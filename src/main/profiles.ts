/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { app, BrowserWindow, session } from "electron";
import { IpcEvents } from "shared/IpcEvents";
import {
    buildPacScript,
    buildUnavailablePacScript,
    type ConnectionProfile,
    type CustomProfileInput,
    isValidProfileId,
    MAX_CUSTOM_PROFILES,
    normalizeNetworkConfigUrl,
    normalizeProfileName,
    type NetworkConfigResult,
    parseCustomProfiles,
    parseNetworkConfig,
    parsePackagedProfiles,
    type ProfileNetworkConfig,
    type ProfilesSnapshot,
    type ProfileSaveResult,
    type ProfileStatus
} from "shared/profiles";

import { DATA_DIR } from "./constants";
import { publishRtcRelaySnapshot } from "./rtcRelay";
import { Settings } from "./settings";

const PACKAGED_PROFILES_PATH = join(app.getAppPath(), "profiles.json");
const CUSTOM_PROFILES_PATH = join(DATA_DIR, "custom-profiles.json");

const CONFIG_TIMEOUT_MS = 10_000;
const PROXY_CHECK_TIMEOUT_MS = 8_000;
/** Temporary credentials are refreshed this long before they expire */
const EXPIRY_MARGIN_MS = 60_000;
const EXPIRY_REFRESH_MIN_MS = 5_000;
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Isolated in-memory session used to retrieve Network Configurations */
const CONFIG_SESSION = "dohcord-profile-config";

let packagedProfiles: ConnectionProfile[] = [];
let customProfiles: ConnectionProfile[] = [];

let status: ProfileStatus = { state: "direct", updatedAt: Date.now() };

let applying: Promise<void> | undefined;
let runningId: string | undefined;
/** A configuration validated moments ago, so selecting it does not fetch it twice */
let primed: { id: string; config: ProfileNetworkConfig } | undefined;

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let failureCount = 0;

let proxyInstalled = false;
let appliedProxySignature: string | undefined;
/** The active PAC policy has been proven to reach Discord through the proxy */
let proxyVerified = false;

let configSession: Electron.Session | undefined;

export function initProfiles() {
    loadPackagedProfiles();
    loadCustomProfiles();

    Settings.addChangeListener("profileId", () => void applySelectedProfile());

    void applySelectedProfile();
}

export function getProfiles(): ConnectionProfile[] {
    return [...packagedProfiles, ...customProfiles];
}

export function getSelectedProfileId(): string | undefined {
    const { profileId } = Settings.store;
    return profileId && isValidProfileId(profileId) ? profileId : undefined;
}

export function getProfilesSnapshot(): ProfilesSnapshot {
    return { profiles: getProfiles(), selectedId: getSelectedProfileId(), status };
}

export function getProfileStatus(): ProfileStatus {
    return status;
}

export function findProfile(id: string | undefined): ConnectionProfile | undefined {
    if (!id) return;
    return getProfiles().find(profile => profile.id === id);
}

/** Reuses a configuration the caller has already validated */
export function primeProfileConfig(id: string, config: ProfileNetworkConfig) {
    primed = { id, config };
}

/**
 * Applies the currently selected profile: fetch and validate its Network
 * Configuration, install the PAC policy and hand the TURN credentials to Discord.
 */
export function applySelectedProfile(): Promise<void> {
    if (applying) return applying;

    runningId = getSelectedProfileId();
    applying = runApply(runningId).finally(() => {
        applying = undefined;

        // The selection changed while this run was in flight; apply the new one
        if (getSelectedProfileId() !== runningId) void applySelectedProfile();
    });

    return applying;
}

async function runApply(id: string | undefined) {
    clearTimers();

    const ses = session.defaultSession;
    const profile = findProfile(id);

    if (!id) {
        primed = undefined;
        failureCount = 0;
        await resetProxy(ses);
        publishRtcRelaySnapshot({ enabled: false });
        setStatus({ state: "direct" });
        return;
    }

    if (!profile) {
        primed = undefined;
        proxyVerified = false;
        publishRtcRelaySnapshot({ enabled: false });
        // Fail closed rather than quietly sending Discord direct
        await installPac(ses, buildUnavailablePacScript());
        setStatus({
            profileId: id,
            state: "unavailable",
            message: "This profile is no longer available. Choose another profile or a direct connection."
        });
        return;
    }

    setStatus({
        profileId: profile.id,
        profileName: profile.name,
        state: "connecting",
        message: "Retrieving the network configuration…"
    });

    const ready = takePrimed(profile.id);
    let config: ProfileNetworkConfig;

    if (ready) {
        config = ready;
    } else {
        const result = await fetchNetworkConfig(profile.networkConfigUrl);
        if (getSelectedProfileId() !== profile.id) return;

        if (!result.ok) {
            publishRtcRelaySnapshot({ enabled: true, error: result.error });
            proxyVerified = false;
            await installPac(ses, buildUnavailablePacScript());

            setStatus({
                profileId: profile.id,
                profileName: profile.name,
                state: result.expired ? "expired" : "invalid",
                message: result.error
            });

            scheduleRetry();
            return;
        }

        config = result.config;
    }

    if (getSelectedProfileId() !== profile.id) return;

    try {
        await installPac(ses, buildPacScript(config));
    } catch (err) {
        proxyVerified = false;
        publishRtcRelaySnapshot({ enabled: true, error: "The proxy configuration could not be applied" });
        setStatus({
            profileId: profile.id,
            profileName: profile.name,
            state: "unavailable",
            message: `The proxy configuration could not be applied: ${errorMessage(err)}`
        });
        scheduleRetry();
        return;
    }

    if (getSelectedProfileId() !== profile.id) return;

    // Temporary TURN credentials stay in memory and are never written to disk
    if (config.rtcRelay) {
        publishRtcRelaySnapshot({
            enabled: true,
            iceServers: config.rtcRelay.iceServers,
            expiresAt: config.rtcRelay.expiresAt
        });
    } else {
        publishRtcRelaySnapshot({ enabled: false });
    }

    // Installing a PAC script is not proof the proxy actually works; probe it once
    // for a new policy, not again on every credential refresh
    if (!proxyVerified) {
        const probe = await checkProxy(ses);
        if (getSelectedProfileId() !== profile.id) return;

        if (!probe.ok) {
            proxyVerified = false;
            setStatus({
                profileId: profile.id,
                profileName: profile.name,
                proxyHost: config.httpsProxy.host,
                state: "unavailable",
                message: probe.error
            });
            scheduleRetry();
            return;
        }

        proxyVerified = true;
    }

    failureCount = 0;

    setStatus({
        profileId: profile.id,
        profileName: profile.name,
        proxyHost: config.httpsProxy.host,
        state: "connected",
        message: `Discord traffic is routed through ${config.httpsProxy.host}:${config.httpsProxy.port}`
    });

    scheduleExpiryRefresh(config);
}

async function installPac(ses: Electron.Session, script: string) {
    const signature = `${script.length}:${script}`;

    if (signature !== appliedProxySignature) {
        await ses.setProxy({ mode: "pac_script", pacScript: script });
        appliedProxySignature = signature;
        proxyInstalled = true;
        proxyVerified = false;

        // New settings only affect new connections until Chromium is told to drop
        // the old ones, so Discord reconnects with the new policy
        await ses.closeAllConnections();
    }
}

async function resetProxy(ses: Electron.Session) {
    appliedProxySignature = undefined;
    proxyVerified = false;

    if (!proxyInstalled) return;

    proxyInstalled = false;
    await ses.setProxy({ mode: "system" });
    await ses.closeAllConnections();
}

/** Retrieves and validates a profile's Network Configuration */
export async function fetchNetworkConfig(url: string): Promise<NetworkConfigResult> {
    let response: Awaited<ReturnType<Electron.Session["fetch"]>>;

    try {
        response = await getConfigSession().fetch(url, {
            method: "GET",
            redirect: "error",
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS)
        });
    } catch (err) {
        return { ok: false, error: describeFetchError(err) };
    }

    if (!response.ok) {
        return { ok: false, error: `The Network Configuration endpoint returned HTTP ${response.status}` };
    }

    // Redirects are refused above; this only catches Electron reporting a final
    // URL that is no longer HTTPS
    if (response.url) {
        try {
            if (new URL(response.url).protocol !== "https:") {
                return { ok: false, error: "The Network Configuration endpoint redirected off HTTPS" };
            }
        } catch {}
    }

    let json: unknown;
    try {
        json = await response.json();
    } catch {
        return { ok: false, error: "The Network Configuration endpoint did not return valid JSON" };
    }

    return parseNetworkConfig(json);
}

/** Validates a profile without applying it, used by the first launch window */
export async function checkProfileConfig(profile: ConnectionProfile): Promise<NetworkConfigResult> {
    return fetchNetworkConfig(profile.networkConfigUrl);
}

/**
 * Retrieves the configuration through a session that never uses the profile proxy.
 * The proxy connection itself must not be routed through the proxy.
 */
function getConfigSession(): Electron.Session {
    if (!configSession) {
        configSession = session.fromPartition(CONFIG_SESSION, { cache: false });
        void configSession.setProxy({ mode: "direct" });
    }

    return configSession;
}

async function checkProxy(ses: Electron.Session): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        // A real request through the active PAC policy. Any Discord response proves
        // the tunnel worked; TLS errors and proxy failures reject the promise.
        const response = await ses.fetch("https://discord.com/api/v9/gateway", {
            method: "GET",
            cache: "no-store",
            redirect: "follow",
            signal: AbortSignal.timeout(PROXY_CHECK_TIMEOUT_MS)
        });

        if (response.status === 407) {
            return {
                ok: false,
                error: "The proxy requires authentication, which Dohcord connection profiles do not support"
            };
        }

        // Any other response came back through the tunnel, including Discord's own
        // 4xx responses, which proves the proxy forwarded the connection
        return { ok: true };
    } catch (err) {
        return { ok: false, error: `Could not reach Discord through the proxy: ${errorMessage(err)}` };
    }
}

export async function saveCustomProfile(input: unknown): Promise<ProfileSaveResult> {
    const record = (typeof input === "object" && input !== null ? input : {}) as Partial<CustomProfileInput> & {
        id?: unknown;
    };

    const name = normalizeProfileName(record.name);
    if (!name) return { ok: false, error: "Enter a name of up to 64 characters" };

    const networkConfigUrl = normalizeNetworkConfigUrl(record.networkConfigUrl);
    if (!networkConfigUrl) {
        return { ok: false, error: "Enter a valid https:// Network Configuration URL without credentials" };
    }

    if (record.id !== undefined && !isValidProfileId(record.id)) {
        return { ok: false, error: "That profile is not a valid custom profile" };
    }

    const id = record.id as string | undefined;
    const existing = id ? customProfiles.find(profile => profile.id === id) : undefined;

    if (id && !existing) {
        if (packagedProfiles.some(profile => profile.id === id)) {
            return { ok: false, error: "The built-in Newipe profile cannot be modified" };
        }

        return { ok: false, error: "That profile no longer exists" };
    }

    if (customProfiles.some(profile => profile.id !== id && profile.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, error: "A profile with that name already exists" };
    }

    if (customProfiles.some(profile => profile.id !== id && profile.networkConfigUrl === networkConfigUrl)) {
        return { ok: false, error: "A profile with that Network Configuration URL already exists" };
    }

    if (!existing && customProfiles.length >= MAX_CUSTOM_PROFILES) {
        return { ok: false, error: `You can add up to ${MAX_CUSTOM_PROFILES} custom profiles` };
    }

    // A profile is only accepted once its server configuration has been retrieved
    // and validated by the same code that will later apply it
    const result = await fetchNetworkConfig(networkConfigUrl);
    if (!result.ok) return { ok: false, error: result.error };

    let savedId = id;
    const previous = existing
        ? { name: existing.name, networkConfigUrl: existing.networkConfigUrl, description: existing.description }
        : undefined;

    if (existing) {
        existing.name = name;
        existing.networkConfigUrl = networkConfigUrl;
        delete existing.description;
    } else {
        const newId = generateCustomProfileId(name, customProfiles);
        savedId = newId;
        customProfiles.push({ id: newId, name, networkConfigUrl, type: "custom" });
    }

    if (!persistCustomProfiles()) {
        // Do not keep a profile that cannot be saved for the next start
        if (existing && previous) {
            existing.name = previous.name;
            existing.networkConfigUrl = previous.networkConfigUrl;
            if (previous.description) existing.description = previous.description;
            else delete existing.description;
        } else {
            customProfiles.pop();
        }

        return { ok: false, error: "The custom profiles file could not be written" };
    }

    if (savedId && getSelectedProfileId() === savedId) {
        primeProfileConfig(savedId, result.config);
        void applySelectedProfile();
    }

    return { ok: true, profiles: getProfiles() };
}

export function deleteCustomProfile(id: unknown): ProfileSaveResult {
    if (!isValidProfileId(id)) return { ok: false, error: "That is not a valid profile" };

    if (packagedProfiles.some(profile => profile.id === id)) {
        return { ok: false, error: "The built-in Newipe profile cannot be removed" };
    }

    const index = customProfiles.findIndex(profile => profile.id === id);
    if (index === -1) return { ok: false, error: "That profile no longer exists" };

    const [removed] = customProfiles.splice(index, 1);

    if (!persistCustomProfiles()) {
        customProfiles.splice(index, 0, removed);
        return { ok: false, error: "The custom profiles file could not be written" };
    }

    if (getSelectedProfileId() === id) {
        Settings.store.profileId = undefined;
        void applySelectedProfile();
    }

    return { ok: true, profiles: getProfiles() };
}

function loadPackagedProfiles() {
    try {
        packagedProfiles = parsePackagedProfiles(JSON.parse(readFileSync(PACKAGED_PROFILES_PATH, "utf8")));
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            console.error("[Profiles] Failed to load packaged profiles:", errorMessage(err));
        }
        packagedProfiles = [];
    }
}

function loadCustomProfiles() {
    try {
        customProfiles = parseCustomProfiles(JSON.parse(readFileSync(CUSTOM_PROFILES_PATH, "utf8")));
    } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;

        if (code === "ENOENT") {
            customProfiles = [];
            return;
        }

        console.error("[Profiles] Ignoring unreadable custom profiles:", errorMessage(err));
        customProfiles = [];
    }
}

function persistCustomProfiles(): boolean {
    try {
        mkdirSync(dirname(CUSTOM_PROFILES_PATH), { recursive: true });
        writeFileSync(CUSTOM_PROFILES_PATH + ".tmp", JSON.stringify(customProfiles, null, 4));
        renameSync(CUSTOM_PROFILES_PATH + ".tmp", CUSTOM_PROFILES_PATH);

        return true;
    } catch (err) {
        console.error("[Profiles] Failed to save custom profiles:", errorMessage(err));
        return false;
    }
}

function generateCustomProfileId(name: string, existing: ConnectionProfile[]): string {
    const base =
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "profile";

    const taken = new Set([...packagedProfiles, ...existing].map(profile => profile.id));

    for (let attempt = 0; attempt < 50; attempt++) {
        const suffix = Math.random().toString(36).slice(2, 7);
        const id = `custom-${base}-${suffix}`.slice(0, 64);

        if (!taken.has(id)) return id;
    }

    return `custom-${Date.now().toString(36)}`;
}

function publishStatus(next: ProfileStatus) {
    status = { ...next, updatedAt: Date.now() };

    for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.isDestroyed()) continue;
        win.webContents.send(IpcEvents.PROFILES_STATUS_UPDATE, status);
    }
}

function setStatus(next: Omit<ProfileStatus, "updatedAt">) {
    if (
        status.state === next.state &&
        status.profileId === next.profileId &&
        status.profileName === next.profileName &&
        status.message === next.message &&
        status.proxyHost === next.proxyHost
    ) {
        return;
    }

    publishStatus(next as ProfileStatus);
}

function scheduleExpiryRefresh(config: ProfileNetworkConfig) {
    const expiresAt = config.rtcRelay?.expiresAt;
    if (!expiresAt) return;

    clearRefresh();
    const delay = Math.max(EXPIRY_REFRESH_MIN_MS, expiresAt - EXPIRY_MARGIN_MS - Date.now());

    refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void applySelectedProfile();
    }, delay);
    refreshTimer.unref?.();
}

function scheduleRetry() {
    clearRetry();

    const delay = Math.min(RETRY_BASE_MS * 2 ** failureCount, RETRY_MAX_MS);
    failureCount++;

    retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void applySelectedProfile();
    }, delay);
    retryTimer.unref?.();
}

function clearRefresh() {
    if (refreshTimer === undefined) return;

    clearTimeout(refreshTimer);
    refreshTimer = undefined;
}

function clearRetry() {
    if (retryTimer === undefined) return;

    clearTimeout(retryTimer);
    retryTimer = undefined;
}

function clearTimers() {
    clearRefresh();
    clearRetry();
}

function takePrimed(id: string): ProfileNetworkConfig | undefined {
    if (primed?.id !== id) {
        primed = undefined;
        return;
    }

    const { config } = primed;
    primed = undefined;

    return config;
}

function describeFetchError(err: unknown): string {
    const message = errorMessage(err);

    if (/CERT|SSL|TLS/i.test(message)) {
        return `The Network Configuration endpoint's TLS certificate could not be verified: ${message}`;
    }

    if (/TIMED_OUT|timeout|aborted/i.test(message)) {
        return "The Network Configuration endpoint did not respond in time";
    }

    if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
        return "The Network Configuration endpoint could not be resolved";
    }

    return `The Network Configuration endpoint could not be reached: ${message}`;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
