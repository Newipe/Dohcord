/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, net } from "electron";
import {
    DEFAULT_DOH_RESOLVERS,
    type DohResolver,
    findDohResolver,
    normalizeDohUrl,
    parseDohResolvers,
    REMOTE_DOH_RESOLVERS_URL
} from "shared/doh";
import { IpcEvents } from "shared/IpcEvents";
import {
    isAcceptableCredentialResponseUrl,
    normalizeRtcRelayConfig,
    parseRtcRelayCredentials,
    type RtcRelayConfig,
    type RtcRelayCredentials,
    RTC_RELAY_EXPIRY_MARGIN_MS,
    type RtcRelaySnapshot
} from "shared/rtcRelay";

import { Settings } from "./settings";
import { handleSync } from "./utils/ipcWrappers";
import { isDiscordUrl } from "./utils/isDiscordUrl";

const RESOLVER_LIST_TIMEOUT_MS = 4_000;
const CREDENTIALS_TIMEOUT_MS = 8_000;
/** Never schedule an expiry refresh sooner than this, to avoid a tight loop */
const EXPIRY_REFRESH_MIN_MS = 5_000;
const RETRY_BASE_MS = 10_000;
const RETRY_MAX_MS = 5 * 60_000;

let resolvers: DohResolver[] = DEFAULT_DOH_RESOLVERS;

/** What the renderer is told. Never contains a password beyond the temporary one. */
let snapshot: RtcRelaySnapshot = { enabled: false };
let snapshotSignature = "";

/** credentialsUrl the cached credentials belong to */
let activeCredentialsUrl: string | undefined;
let credentials: RtcRelayCredentials | undefined;

let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let failureCount = 0;

let busy = false;
let queued = false;
let initialised = false;

export function getRtcRelaySnapshot(): RtcRelaySnapshot {
    return snapshot;
}

/**
 * Starts the relay manager. The settings-derived state is published synchronously so
 * the window that is about to open already knows whether its provider wants a relay;
 * credentials are fetched in the background and pushed to the renderer afterwards.
 */
export function initRtcRelay() {
    if (initialised) return;
    initialised = true;

    publishFromSettings();

    void (async () => {
        await loadResolverList();
        await refreshRtcRelay();
    })();
}

/** Re-evaluates the selected provider, fetching fresh credentials when needed */
export async function refreshRtcRelay(): Promise<void> {
    if (busy) {
        queued = true;
        return;
    }

    busy = true;
    try {
        await doRefreshRtcRelay();
    } finally {
        busy = false;

        if (queued) {
            queued = false;
            void refreshRtcRelay();
        }
    }
}

async function doRefreshRtcRelay() {
    const target = resolveRelayTarget();

    if (!target) {
        activeCredentialsUrl = undefined;
        credentials = undefined;
        failureCount = 0;
        clearTimers();
        publish({ enabled: false });
        return;
    }

    if (activeCredentialsUrl !== target.credentialsUrl) {
        activeCredentialsUrl = target.credentialsUrl;
        credentials = undefined;
        failureCount = 0;
        clearTimers();
    }

    // Still safely inside its lifetime, keep using what we have
    if (credentials && Date.now() < credentials.expiresAt - RTC_RELAY_EXPIRY_MARGIN_MS) {
        publish({ enabled: true, iceServers: credentials.iceServers, expiresAt: credentials.expiresAt });
        scheduleExpiryRefresh(credentials.expiresAt);
        return;
    }

    if (!credentials) publish({ enabled: true });

    try {
        const fresh = await fetchCredentials(target.credentialsUrl);

        // The provider may have been switched while the request was in flight
        if (activeCredentialsUrl !== target.credentialsUrl) return;

        credentials = fresh;
        failureCount = 0;
        clearRetry();

        publish({ enabled: true, iceServers: fresh.iceServers, expiresAt: fresh.expiresAt });
        scheduleExpiryRefresh(fresh.expiresAt);

        const minutes = Math.max(1, Math.round((fresh.expiresAt - Date.now()) / 60_000));
        console.log(
            `[RTC] Temporary relay credentials loaded from ${new URL(target.credentialsUrl).host}, valid for ~${minutes} min`
        );
    } catch (err) {
        if (activeCredentialsUrl !== target.credentialsUrl) return;

        // Never log the response itself, only what went wrong
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[RTC] Could not obtain relay credentials:", message);

        if (credentials && Date.now() < credentials.expiresAt) {
            publish({ enabled: true, iceServers: credentials.iceServers, expiresAt: credentials.expiresAt });
            scheduleExpiryRefresh(credentials.expiresAt);
        } else {
            credentials = undefined;
            publish({ enabled: true, error: message });
        }

        scheduleRetry();
    }
}

/**
 * Decides whether the currently selected DoH provider asks for a relay. The provider
 * is identified by its resolver URL, never by its display label, so a renamed entry
 * keeps working and a custom URL cannot accidentally match.
 */
function resolveRelayTarget(): RtcRelayConfig | undefined {
    const { enableDoh, dohUrl } = Settings.store;
    if (!enableDoh) return;

    const url = normalizeDohUrl(dohUrl);
    if (!url) return;

    const fromList = findDohResolver(resolvers, url)?.rtcRelay;
    // An older remote resolvers.json may not carry the block yet; the bundled list does
    const configured = fromList ?? findDohResolver(DEFAULT_DOH_RESOLVERS, url)?.rtcRelay;

    return configured ? normalizeRtcRelayConfig(configured) : undefined;
}

function publishFromSettings() {
    const target = resolveRelayTarget();
    if (!target) {
        publish({ enabled: false });
        return;
    }

    if (activeCredentialsUrl === target.credentialsUrl && credentials) {
        publish({ enabled: true, iceServers: credentials.iceServers, expiresAt: credentials.expiresAt });
        return;
    }

    publish({ enabled: true });
}

async function loadResolverList() {
    try {
        const response = await net.fetch(REMOTE_DOH_RESOLVERS_URL, {
            cache: "no-store",
            signal: AbortSignal.timeout(RESOLVER_LIST_TIMEOUT_MS)
        });
        if (!response.ok) return;

        const parsed = parseDohResolvers(await response.json());
        if (parsed) resolvers = parsed;
    } catch {
        // The bundled list is always available, so a failed refresh is not an error
    }
}

async function fetchCredentials(credentialsUrl: string): Promise<RtcRelayCredentials> {
    const response = await net.fetch(credentialsUrl, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(CREDENTIALS_TIMEOUT_MS)
    });

    if (!response.ok) throw new Error(`the credential endpoint returned HTTP ${response.status}`);

    // Certificate verification is Chromium's normal one. Redirects are refused
    // outright above; Response.url is only checked when Electron reports one.
    if (!isAcceptableCredentialResponseUrl(response.url)) {
        throw new Error("the credential endpoint redirected off HTTPS");
    }

    let json: unknown;
    try {
        json = await response.json();
    } catch {
        throw new Error("the credential endpoint did not return valid JSON");
    }

    const parsed = parseRtcRelayCredentials(json);
    if (!parsed.ok) throw new Error(parsed.error);

    return { iceServers: parsed.iceServers, expiresAt: parsed.expiresAt };
}

function publish(next: RtcRelaySnapshot) {
    const signature = JSON.stringify(next);
    if (signature === snapshotSignature) return;

    snapshotSignature = signature;
    snapshot = next;

    for (const win of BrowserWindow.getAllWindows()) {
        const contents = win.webContents;
        if (contents.isDestroyed() || !isDiscordUrl(contents.getURL())) continue;

        contents.send(IpcEvents.RTC_RELAY_UPDATE, next);
    }
}

function scheduleExpiryRefresh(expiresAt: number) {
    clearExpiry();

    const delay = Math.max(EXPIRY_REFRESH_MIN_MS, expiresAt - RTC_RELAY_EXPIRY_MARGIN_MS - Date.now());
    expiryTimer = setTimeout(() => {
        expiryTimer = undefined;
        void refreshRtcRelay();
    }, delay);
    expiryTimer.unref?.();
}

function scheduleRetry() {
    clearRetry();

    const delay = Math.min(RETRY_BASE_MS * 2 ** failureCount, RETRY_MAX_MS);
    failureCount++;

    retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void refreshRtcRelay();
    }, delay);
    retryTimer.unref?.();
}

function clearRetry() {
    if (retryTimer === undefined) return;

    clearTimeout(retryTimer);
    retryTimer = undefined;
}

function clearExpiry() {
    if (expiryTimer === undefined) return;

    clearTimeout(expiryTimer);
    expiryTimer = undefined;
}

function clearTimers() {
    clearRetry();
    clearExpiry();
}

handleSync(IpcEvents.RTC_RELAY_SNAPSHOT, () => getRtcRelaySnapshot());
