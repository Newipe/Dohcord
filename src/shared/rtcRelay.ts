/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface RtcIceServer {
    urls: string | string[];
    username?: string;
    credential?: string;
}

export interface RtcRelayCredentials {
    iceServers: RtcIceServer[];
    /** Epoch milliseconds at which the temporary credentials expire */
    expiresAt: number;
}

/**
 * Handed from the main process to the Discord renderer. An empty object is never
 * valid; {@link RtcRelaySnapshot.enabled} always states whether the selected
 * connection profile asks for a relay.
 */
export interface RtcRelaySnapshot {
    enabled: boolean;
    iceServers?: RtcIceServer[];
    expiresAt?: number;
    /** Why no usable credentials are available */
    error?: string;
}

export type RtcRelayState = "unavailable" | "connecting" | "relayed" | "fallback" | "direct";

/** Live state of the relay as observed on Discord's actual PeerConnections */
export interface RtcRelayStatus {
    /** The selected connection profile carries an RTC relay configuration */
    configured: boolean;
    state: RtcRelayState;
    reason?: string;
    /** Host of the TURN server in use, for display only */
    relayHost?: string;
    candidateType?: string;
    protocol?: string;
    localAddress?: string;
    remoteAddress?: string;
    iceConnectionState?: string;
    dtlsState?: string;
    bytesSent?: number;
    bytesReceived?: number;
    packetsSent?: number;
    packetsReceived?: number;
    rttMs?: number;
    updatedAt: number;
}

/** API the integration exposes to the Discord page */
export interface DohcordRtcRelay {
    update(snapshot: RtcRelaySnapshot): void;
    getStatus(): RtcRelayStatus;
}

/** Dispatched on window every time {@link RtcRelayStatus} changes */
export const RTC_RELAY_STATUS_EVENT = "dohcord-rtc-relay-status";

/** Cached credentials are refreshed this long before they expiry */
export const RTC_RELAY_EXPIRY_MARGIN_MS = 60_000;

const MAX_ICE_SERVERS = 16;
const MAX_ICE_URLS = 8;
const MAX_FIELD_LENGTH = 512;
/** Credentials this close to expiry are treated as expired */
const MIN_REMAINING_TTL_MS = 30_000;
const ICE_URL = /^(?:stuns?|turns?):[^\s]+$/i;
const TURN_URL = /^turns?:[^\s]+$/i;

export type RtcRelayCredentialsResult = ({ ok: true } & RtcRelayCredentials) | { ok: false; error: string };

/**
 * Validates the credential endpoint response. The iceServers array is passed on as
 * returned, only known fields are kept so nothing else reaches Chromium.
 *
 * The temporary username has the coturn REST format `<EXPIRATION_TIMESTAMP>:Dohcord`,
 * which is where the expiry is read from. Nothing is assumed about the password.
 */
export function parseRtcRelayCredentials(value: unknown, now = Date.now()): RtcRelayCredentialsResult {
    if (typeof value !== "object" || value === null)
        return fail("The credential endpoint did not return a JSON object");

    const { iceServers } = value as { iceServers?: unknown };
    if (!Array.isArray(iceServers) || !iceServers.length) return fail("The credential response contains no iceServers");
    if (iceServers.length > MAX_ICE_SERVERS) return fail("The credential response contains too many ICE servers");

    const parsed: RtcIceServer[] = [];
    let hasTurn = false;
    let expiresAt = 0;

    for (const entry of iceServers) {
        if (typeof entry !== "object" || entry === null)
            return fail("The credential response contains an invalid ICE server");

        const { urls, username, credential } = entry as { urls?: unknown; username?: unknown; credential?: unknown };

        const urlList = typeof urls === "string" ? [urls] : Array.isArray(urls) ? urls : [];
        if (!urlList.length || urlList.length > MAX_ICE_URLS)
            return fail("An ICE server in the response has no usable urls");
        if (!urlList.every(url => typeof url === "string" && ICE_URL.test(url.trim()))) {
            return fail("An ICE server in the response has an invalid url");
        }

        const server: RtcIceServer = { urls: typeof urls === "string" ? urls : [...(urls as string[])] };
        const isTurn = urlList.some(url => typeof url === "string" && TURN_URL.test(url));

        if (isTurn) {
            if (typeof username !== "string" || !username || typeof credential !== "string" || !credential) {
                return fail("The relay credentials are incomplete");
            }
            if (username.length > MAX_FIELD_LENGTH || credential.length > MAX_FIELD_LENGTH) {
                return fail("The relay credentials are malformed");
            }

            const timestamp = parseExpiryTimestamp(username);
            if (!timestamp) return fail("The relay username does not contain an expiry timestamp");

            expiresAt = expiresAt ? Math.min(expiresAt, timestamp) : timestamp;
            hasTurn = true;
            server.username = username;
            server.credential = credential;
        } else if (typeof username === "string" && typeof credential === "string") {
            server.username = username;
            server.credential = credential;
        }

        parsed.push(server);
    }

    // A relay without TURN would just fall back to a direct candidate
    if (!hasTurn) return fail("The relay configuration contains no TURN server");

    // The endpoint may also state when the credentials expire; trust whichever is first
    const declaredExpiry = parseDeclaredExpiry((value as { expiresAt?: unknown }).expiresAt);
    if (declaredExpiry) expiresAt = expiresAt ? Math.min(expiresAt, declaredExpiry) : declaredExpiry;

    if (!expiresAt) return fail("The relay credentials do not contain an expiry timestamp");
    if (expiresAt <= now + MIN_REMAINING_TTL_MS) return fail("The relay credentials have expired");

    return { ok: true, iceServers: parsed, expiresAt };
}

/** Reads the optional top level expiresAt field, in unix seconds, milliseconds or a date string */
export function parseDeclaredExpiry(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;

    if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return parsed;
    }
}

/** Reads the coturn REST timestamp prefix from a temporary username */
export function parseExpiryTimestamp(username: string): number | undefined {
    const match = /^(\d{10,13})\b/.exec(username);
    if (!match) return;

    const value = Number(match[1]);
    if (!Number.isFinite(value)) return;

    return value < 1e12 ? value * 1000 : value;
}

function fail(error: string): RtcRelayCredentialsResult {
    return { ok: false, error };
}
