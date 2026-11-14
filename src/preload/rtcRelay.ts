/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Injected into the Discord page's main world from the preload, before Discord's
 * own scripts run. It wraps the real RTCPeerConnection so the relay configuration
 * is applied to the connections Discord creates for voice and video, and watches
 * their stats to confirm traffic actually goes through the relay.
 */

import {
    type DohcordRtcRelay,
    RTC_RELAY_EXPIRY_MARGIN_MS,
    RTC_RELAY_STATUS_EVENT,
    type RtcIceServer,
    type RtcRelaySnapshot,
    type RtcRelayStatus
} from "../shared/rtcRelay";

interface TrackedConnection {
    pc: any;
    /** The native setConfiguration, captured before anything shadows it */
    setConfiguration: (config: any) => void;
    /** Discord's configuration, restored when the relay is abandoned */
    originalConfig: any;
    /** Relay mode is applied and not abandoned yet */
    relay: boolean;
    fellBack: boolean;
    fallbackReason?: string;
    confirmedRelay: boolean;
    logged: boolean;
    statsTimer?: number;
    connectTimer?: number;
    disconnectTimer?: number;
}

/** A relay that has not connected by then is considered unusable */
const CONNECT_TIMEOUT_MS = 15_000;
/** A brief disconnect is normal, a sustained one is not */
const DISCONNECT_GRACE_MS = 8_000;
const STATS_INTERVAL_MS = 3_000;
/** Controlled backoff between relay attempts after a failure */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const MAX_ICE_SERVERS = 16;

(function installDohcordRtcRelay() {
    const win = window as any;

    // Every navigation and renderer restart runs this again; never stack wrappers
    if (win.__dohcordRtcRelayInstalled) return;
    win.__dohcordRtcRelayInstalled = true;

    const nativeRTCPeerConnection = win.RTCPeerConnection as typeof RTCPeerConnection | undefined;
    if (typeof nativeRTCPeerConnection !== "function") return;

    const connections = new Set<TrackedConnection>();

    let snapshot: RtcRelaySnapshot = { enabled: false };
    let lastStats: Partial<RtcRelayStatus> = {};
    let status: RtcRelayStatus = { configured: false, state: "unavailable", updatedAt: Date.now() };
    let retryAfter = 0;
    let failureCount = 0;

    /* ---------------------------------------------------------------- */
    /* Configuration                                                      */
    /* ---------------------------------------------------------------- */

    function sanitizeSnapshot(value: any): RtcRelaySnapshot {
        if (!value || typeof value !== "object" || value.enabled !== true) return { enabled: false };

        const result: RtcRelaySnapshot = { enabled: true };

        if (Array.isArray(value.iceServers)) {
            const servers: RtcIceServer[] = [];

            for (const entry of value.iceServers.slice(0, MAX_ICE_SERVERS)) {
                if (!entry || typeof entry !== "object") continue;

                const { urls } = entry;
                const valid =
                    typeof urls === "string" ||
                    (Array.isArray(urls) && urls.length > 0 && urls.every((url: unknown) => typeof url === "string"));
                if (!valid) continue;

                const server: RtcIceServer = { urls };
                if (typeof entry.username === "string") server.username = entry.username;
                if (typeof entry.credential === "string") server.credential = entry.credential;
                servers.push(server);
            }

            if (servers.length) result.iceServers = servers;
        }

        if (typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)) result.expiresAt = value.expiresAt;
        if (typeof value.error === "string") result.error = value.error;

        return result;
    }

    function usableRelayServers(): RtcIceServer[] | undefined {
        if (!snapshot.enabled || !snapshot.iceServers?.length) return;
        // Stop handing out credentials that are about to expire
        if (snapshot.expiresAt && Date.now() >= snapshot.expiresAt - RTC_RELAY_EXPIRY_MARGIN_MS) return;

        return snapshot.iceServers;
    }

    function relayAllowed() {
        return !!usableRelayServers() && Date.now() >= retryAfter;
    }

    function relayHost(): string | undefined {
        for (const server of snapshot.iceServers ?? []) {
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];

            for (const url of urls) {
                const match = /^turns?:([^:?/]+)/i.exec(url);
                if (match) return match[1];
            }
        }
    }

    function toIceServers(servers: RtcIceServer[]): RTCIceServer[] {
        return servers.map(server => {
            const copy: RTCIceServer = { urls: server.urls };
            if (server.username !== undefined) copy.username = server.username;
            if (server.credential !== undefined) copy.credential = server.credential;

            return copy;
        });
    }

    /**
     * Builds the relay configuration from Discord's own. Everything Discord set is
     * carried over (bundlePolicy, encodedInsertableStreams, data channels, ...);
     * only the ICE servers and the transport policy change, so the only candidate
     * Chromium can choose is the relay.
     */
    function buildRelayConfig(config: any): { config: any; original: any } {
        const original = config && typeof config === "object" ? { ...config } : {};
        if (Array.isArray(original.iceServers)) {
            original.iceServers = original.iceServers.map((server: any) => ({ ...server }));
        }

        return {
            original,
            config: {
                ...original,
                iceServers: toIceServers(usableRelayServers()!),
                iceTransportPolicy: "relay"
            }
        };
    }

    /* ---------------------------------------------------------------- */
    /* Status                                                             */
    /* ---------------------------------------------------------------- */

    function computeState(): Partial<RtcRelayStatus> & Pick<RtcRelayStatus, "configured" | "state"> {
        if (!snapshot.enabled) return { configured: false, state: "direct" };

        if (!snapshot.iceServers?.length) {
            if (snapshot.error) return { configured: true, state: "unavailable", reason: snapshot.error };

            return { configured: true, state: "connecting", reason: "Fetching temporary relay credentials" };
        }

        const tracked = [...connections];

        if (tracked.some(connection => connection.confirmedRelay)) {
            return { configured: true, state: "relayed", relayHost: relayHost() };
        }

        const attempts = tracked.filter(connection => connection.relay || connection.fellBack);
        if (attempts.length) {
            if (attempts.every(connection => !connection.relay)) {
                const lastFailure = [...attempts].reverse().find(connection => connection.fallbackReason);

                return {
                    configured: true,
                    relayHost: relayHost(),
                    state: "fallback",
                    reason: lastFailure?.fallbackReason
                };
            }

            return { configured: true, relayHost: relayHost(), state: "connecting" };
        }

        return {
            configured: true,
            relayHost: relayHost(),
            state: "connecting",
            reason: "Waiting for a Discord voice connection"
        };
    }

    function publish(extra: Partial<RtcRelayStatus> = {}) {
        const next: RtcRelayStatus = {
            ...computeState(),
            ...extra,
            updatedAt: Date.now()
        } as RtcRelayStatus;

        status = next;

        Object.defineProperty(win, "__dohcordRtcRelayStatus", {
            value: Object.freeze({ ...next }),
            enumerable: false,
            configurable: true
        });

        window.dispatchEvent(new CustomEvent(RTC_RELAY_STATUS_EVENT, { detail: { ...next } }));
    }

    /* ---------------------------------------------------------------- */
    /* Relay tracking                                                     */
    /* ---------------------------------------------------------------- */

    function clearTimers(entry: TrackedConnection) {
        if (entry.statsTimer !== undefined) {
            clearInterval(entry.statsTimer);
            entry.statsTimer = undefined;
        }
        if (entry.connectTimer !== undefined) {
            clearTimeout(entry.connectTimer);
            entry.connectTimer = undefined;
        }
        if (entry.disconnectTimer !== undefined) {
            clearTimeout(entry.disconnectTimer);
            entry.disconnectTimer = undefined;
        }
    }

    function stopTracking(entry: TrackedConnection) {
        clearTimers(entry);
        connections.delete(entry);
    }

    /**
     * setConfiguration only accepts the non modifiable fields with their current
     * values, so every update starts from what Chromium reports right now.
     */
    function currentConfiguration(pc: any): any {
        try {
            return { ...pc.getConfiguration() };
        } catch {
            return {};
        }
    }

    function applyRelayToExisting(entry: TrackedConnection, servers: RtcIceServer[]) {
        entry.setConfiguration({
            ...currentConfiguration(entry.pc),
            iceServers: toIceServers(servers),
            iceTransportPolicy: "relay"
        });
    }

    /** Restores Discord's own configuration so the next ICE attempt is direct */
    function restoreDirect(entry: TrackedConnection, reason: string) {
        if (!entry.relay) return;

        entry.relay = false;
        entry.fellBack = true;
        entry.fallbackReason = reason;

        clearTimers(entry);

        try {
            entry.setConfiguration({
                ...currentConfiguration(entry.pc),
                iceServers: Array.isArray(entry.originalConfig?.iceServers) ? entry.originalConfig.iceServers : [],
                iceTransportPolicy: entry.originalConfig?.iceTransportPolicy ?? "all"
            });
        } catch (err) {
            console.warn("[Dohcord RTC] Could not restore Discord's PeerConnection configuration", err);
        }

        try {
            entry.pc.restartIce();
        } catch {}

        lastStats = {};
        publish({ reason });
    }

    function failOver(entry: TrackedConnection, reason: string) {
        if (!entry.relay) return;

        restoreDirect(entry, reason);

        failureCount++;
        retryAfter = Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (failureCount - 1), BACKOFF_MAX_MS);

        console.warn(
            `[Dohcord RTC] ${reason} — using direct RTC, next relay attempt in ${Math.round((retryAfter - Date.now()) / 1000)}s`
        );
    }

    function startStats(entry: TrackedConnection) {
        if (entry.statsTimer !== undefined) return;

        entry.statsTimer = window.setInterval(() => void collectStats(entry), STATS_INTERVAL_MS);
        void collectStats(entry);
    }

    async function collectStats(entry: TrackedConnection) {
        const { pc } = entry;
        if (!pc || pc.connectionState === "closed") {
            stopTracking(entry);
            return;
        }

        let report: RTCStatsReport | undefined;
        try {
            report = await pc.getStats();
        } catch {
            return;
        }
        if (!report) return;

        let transport: any;
        const pairs: any[] = [];
        const candidates = new Map<string, any>();

        report.forEach((stat: any) => {
            if (stat.type === "transport") transport ??= stat;
            else if (stat.type === "candidate-pair") pairs.push(stat);
            else if (stat.type === "local-candidate" || stat.type === "remote-candidate") candidates.set(stat.id, stat);
        });

        // The selected pair is the one ICE actually uses; the fallbacks cover older
        // Chromium versions that do not expose transport.selectedCandidatePairId
        const selectedId = transport?.selectedCandidatePairId;
        const pair =
            (selectedId ? report.get(selectedId) : undefined) ??
            pairs.find(candidatePair => candidatePair.selected && candidatePair.state === "succeeded") ??
            pairs.find(candidatePair => candidatePair.nominated && candidatePair.state === "succeeded") ??
            pairs.find(candidatePair => candidatePair.state === "succeeded");

        if (!pair) return;

        const local = candidates.get(pair.localCandidateId);
        const remote = candidates.get(pair.remoteCandidateId);

        const bytesSent = Number(pair.bytesSent ?? 0);
        const bytesReceived = Number(pair.bytesReceived ?? 0);

        // A relay candidate alone is not proof: real media has to flow both ways
        const relayed = entry.relay && local?.candidateType === "relay" && bytesSent > 0 && bytesReceived > 0;

        entry.confirmedRelay = relayed;

        if (relayed) {
            failureCount = 0;
            retryAfter = 0;
        }

        const roundTripTime = pair.currentRoundTripTime;
        lastStats = {
            candidateType: local?.candidateType,
            protocol: local?.protocol ?? pair.protocol,
            localAddress: local?.address,
            remoteAddress: remote?.address,
            iceConnectionState: pc.iceConnectionState,
            dtlsState: transport?.dtlsState,
            bytesSent,
            bytesReceived,
            packetsSent: pair.packetsSent,
            packetsReceived: pair.packetsReceived,
            rttMs: roundTripTime === undefined ? undefined : Math.round(roundTripTime * 1000)
        };

        if (relayed && !entry.logged) {
            entry.logged = true;
            console.info(
                `[Dohcord RTC] Relay confirmed via ${relayHost() ?? "the relay"}: candidate=${local?.candidateType}, ` +
                    `protocol=${local?.protocol ?? pair.protocol ?? "?"}, ` +
                    `${bytesSent} bytes up / ${bytesReceived} bytes down, ` +
                    `${lastStats.rttMs ?? "?"} ms RTT`
            );
        }

        publish(lastStats);
    }

    function onStateChange(entry: TrackedConnection) {
        const { pc } = entry;
        const { iceConnectionState: iceState, connectionState } = pc;

        if (entry.relay) {
            if (iceState === "failed" || connectionState === "failed") {
                failOver(entry, "ICE could not connect through the relay");
                return;
            }

            if (iceState === "disconnected" || connectionState === "disconnected") {
                if (entry.disconnectTimer === undefined) {
                    entry.disconnectTimer = window.setTimeout(() => {
                        entry.disconnectTimer = undefined;

                        const now = pc.iceConnectionState;
                        if (now === "disconnected" || now === "failed" || pc.connectionState === "failed") {
                            failOver(entry, "The relay connection was lost");
                        }
                    }, DISCONNECT_GRACE_MS);
                }
            } else if (entry.disconnectTimer !== undefined) {
                clearTimeout(entry.disconnectTimer);
                entry.disconnectTimer = undefined;
            }
        }

        if (iceState === "connected" || iceState === "completed") {
            if (entry.connectTimer !== undefined) {
                clearTimeout(entry.connectTimer);
                entry.connectTimer = undefined;
            }

            startStats(entry);
        }

        publish();
    }

    function track(pc: any, relay: boolean, originalConfig: any) {
        if (!pc || typeof pc.addEventListener !== "function") return;

        const nativeSetConfiguration =
            typeof pc.setConfiguration === "function" ? pc.setConfiguration.bind(pc) : undefined;
        if (!nativeSetConfiguration) return;

        const entry: TrackedConnection = {
            pc,
            setConfiguration: nativeSetConfiguration,
            originalConfig,
            relay,
            fellBack: false,
            confirmedRelay: false,
            logged: false
        };

        connections.add(entry);

        // Discord may update the configuration later; keep the relay applied when it does
        pc.setConfiguration = function (config: any) {
            if (!entry.relay) return nativeSetConfiguration(config);

            const servers = usableRelayServers();
            if (!servers) {
                restoreDirect(entry, "The relay credentials are no longer valid");
                return nativeSetConfiguration(config);
            }

            entry.originalConfig = config && typeof config === "object" ? { ...config } : {};

            return applyRelayToExisting(entry, servers);
        };

        const nativeClose = pc.close;
        pc.close = function () {
            stopTracking(entry);
            return nativeClose.apply(pc, arguments as any);
        };

        pc.addEventListener("iceconnectionstatechange", () => onStateChange(entry));
        pc.addEventListener("connectionstatechange", () => onStateChange(entry));

        if (relay) {
            entry.connectTimer = window.setTimeout(() => {
                entry.connectTimer = undefined;
                if (!entry.relay) return;

                const iceState = pc.iceConnectionState;
                if (iceState !== "connected" && iceState !== "completed") {
                    failOver(entry, "No relay candidate connected in time");
                }
            }, CONNECT_TIMEOUT_MS);
        }

        publish();
    }

    /* ---------------------------------------------------------------- */
    /* Constructor patch                                                  */
    /* ---------------------------------------------------------------- */

    // A Proxy keeps the constructor's name, prototype, statics and instanceof
    // behaviour identical to the native one
    const patchedRTCPeerConnection = new Proxy(nativeRTCPeerConnection, {
        construct(target, args: any[], newTarget) {
            const [config, ...rest] = args;

            // No usable relay: behave exactly like the native constructor
            if (!relayAllowed()) return Reflect.construct(target, args, newTarget);

            const { config: relayConfig, original } = buildRelayConfig(config);
            const pc = Reflect.construct(target, [relayConfig, ...rest], newTarget);
            track(pc, true, original);

            return pc;
        }
    });

    const nativeDescriptor = Object.getOwnPropertyDescriptor(window, "RTCPeerConnection");
    Object.defineProperty(window, "RTCPeerConnection", {
        configurable: true,
        enumerable: nativeDescriptor?.enumerable ?? false,
        writable: true,
        value: patchedRTCPeerConnection
    });

    if (win.webkitRTCPeerConnection === nativeRTCPeerConnection) {
        win.webkitRTCPeerConnection = patchedRTCPeerConnection;
    }

    /* ---------------------------------------------------------------- */
    /* Public API used by the preload                                     */
    /* ---------------------------------------------------------------- */

    function update(next: unknown) {
        const previousServers = JSON.stringify(snapshot.iceServers ?? null);
        snapshot = sanitizeSnapshot(next);

        // Switching to another profile restores Discord's own RTC behaviour
        if (!snapshot.enabled) {
            for (const entry of [...connections]) {
                if (entry.relay) restoreDirect(entry, "Relay is not enabled for the selected connection profile");
            }

            retryAfter = 0;
            failureCount = 0;
        }

        if (JSON.stringify(snapshot.iceServers ?? null) !== previousServers) lastStats = {};

        publish(lastStats);
    }

    const api: DohcordRtcRelay = {
        update,
        getStatus: () => status
    };

    Object.defineProperty(win, "__dohcordRtcRelay", {
        value: Object.freeze(api),
        enumerable: false,
        configurable: false,
        writable: false
    });

    publish();
})();
