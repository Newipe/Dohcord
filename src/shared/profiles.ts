/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseDeclaredExpiry, parseRtcRelayCredentials, type RtcIceServer } from "./rtcRelay";

/**
 * Connection profiles describe a selective HTTPS CONNECT proxy for Discord
 * traffic and, optionally, a TURN relay for Discord voice. Everything the client
 * applies comes from the profile's own Network Configuration endpoint, which is
 * also the only source of the routing policy. Dohcord keeps no production copy
 * of the allowed domains.
 *
 * DoH is a separate system: it is only available in Direct Connection and is
 * disabled whenever a profile is selected.
 */

/** Value the profile pickers use for "no profile", a plain direct connection */
export const DIRECT_PROFILE_VALUE = "direct";

/** Shown wherever DoH is unavailable because a profile is active */
export const DOH_PROFILE_BLOCK_MESSAGE = "DoH is unavailable while a Network Profile is enabled.";

export const MAX_CUSTOM_PROFILES = 20;
export const MAX_BUILTIN_PROFILES = 16;
export const MAX_PROFILE_NAME_LENGTH = 64;
export const MAX_NETWORK_CONFIG_URL_LENGTH = 512;
export const MAX_ROUTING_DOMAINS = 64;
export const MAX_PORT_RANGES_PER_DOMAIN = 16;
/** Largest Network Configuration response Dohcord will read */
export const MAX_NETWORK_CONFIG_BYTES = 64 * 1024;
/** Largest built-in profile list Dohcord will read */
export const MAX_PROFILES_FILE_BYTES = 32 * 1024;

/**
 * The repository copy of profiles.json. Built-in profiles are refreshed from here
 * on startup so a relay address can change without shipping a new app version.
 */
export const REMOTE_PROFILES_URL = "https://raw.githubusercontent.com/Newipe/Dohcord/main/profiles.json";

/**
 * Used by the PAC script when a destination matches the policy but its port is
 * not allowed. The request is sent to a port nothing listens on, so it fails
 * instead of leaking the original destination over a direct connection.
 */
const PAC_REJECT_PROXY = "PROXY 127.0.0.1:9";

export interface ConnectionProfile {
    id: string;
    name: string;
    description?: string;
    /** HTTPS endpoint returning this profile's Network Configuration */
    networkConfigUrl: string;
    type: "builtin" | "custom";
}

export interface CustomProfileInput {
    name: string;
    networkConfigUrl: string;
}

export interface PortRange {
    from: number;
    to: number;
}

export type RoutingMatch = "exact" | "suffix";

export interface RoutingDomain {
    host: string;
    match: RoutingMatch;
    portRanges: PortRange[];
}

export interface ProfileNetworkConfig {
    schemaVersion: 1;
    /** HTTPS CONNECT proxy supplied by the relay */
    proxy: {
        url: string;
        host: string;
        port: number;
    };
    /** Authoritative routing policy returned by the relay */
    routing: {
        domains: RoutingDomain[];
    };
    /** Temporary TURN credentials; kept in memory only */
    rtcRelay?: {
        iceServers: RtcIceServer[];
        expiresAt?: number;
    };
}

export type NetworkConfigResult =
    | { ok: true; config: ProfileNetworkConfig }
    | { ok: false; error: string; expired?: boolean };

export type ProfileState = "direct" | "connecting" | "connected" | "unavailable" | "invalid" | "expired";

/** Everything the settings UI and the first launch window display about a profile */
export interface ProfileStatus {
    profileId?: string;
    profileName?: string;
    state: ProfileState;
    message?: string;
    /** Host of the HTTPS proxy, for display only */
    proxyHost?: string;
    updatedAt: number;
}

export interface ProfilesSnapshot {
    profiles: ConnectionProfile[];
    selectedId?: string;
    status: ProfileStatus;
}

export interface ProfileSaveResult {
    ok: boolean;
    error?: string;
    profiles?: ConnectionProfile[];
}

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV6 = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/;
const TURN_URL =
    /^(turn|turns):(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?(?:\?transport=(?:udp|tcp))?$/i;

/** A profile always disables DoH; only Direct Connection may use a resolver */
export function resolveEffectiveDoh(profileId: string | undefined, enableDoh: boolean): boolean {
    return enableDoh && !profileId;
}

/** Trims and validates a profile name entered by the user */
export function normalizeProfileName(value: unknown): string | undefined {
    if (typeof value !== "string") return;

    const name = value.trim().replace(/\s+/g, " ");
    if (!name || name.length > MAX_PROFILE_NAME_LENGTH) return;

    // Control characters would make the settings list unreadable
    for (const character of name) {
        const codePoint = character.codePointAt(0)!;
        if (codePoint < 0x20 || codePoint === 0x7f) return;
    }

    return name;
}

/** Validates the Network Configuration URL a user entered or a packaged profile carries */
export function normalizeNetworkConfigUrl(value: unknown): string | undefined {
    if (typeof value !== "string") return;

    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_NETWORK_CONFIG_URL_LENGTH) return;

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return;
    }

    // HTTPS only: no plain HTTP, no certificate bypass, no credentials in the URL
    if (url.protocol !== "https:" || !url.hostname) return;
    if (url.username || url.password) return;

    url.hash = "";

    return url.href;
}

export function isValidProfileId(value: unknown): value is string {
    return typeof value === "string" && PROFILE_ID.test(value);
}

/** Parses the packaged profiles.json, or the repository copy of it */
export function parsePackagedProfiles(value: unknown): ConnectionProfile[] {
    return parseProfileList(value, "builtin").slice(0, MAX_BUILTIN_PROFILES);
}

/**
 * Merges the built-in profiles shipped with the app and the repository copy.
 * The repository copy wins for matching ids and may add new profiles, while
 * packaged profiles missing from it are kept so a broken download cannot remove
 * a profile the user relies on. Ids reserved by custom profiles are ignored.
 */
export function mergeBuiltInProfiles(
    packaged: ConnectionProfile[],
    remote: ConnectionProfile[],
    reservedIds: Iterable<string> = []
): ConnectionProfile[] {
    const reserved = new Set(reservedIds);
    const merged = new Map(packaged.map(profile => [profile.id, profile]));

    for (const profile of remote.slice(0, MAX_BUILTIN_PROFILES)) {
        if (reserved.has(profile.id)) continue;
        merged.set(profile.id, profile);
    }

    return [...merged.values()];
}

/** Parses the user's custom-profiles.json */
export function parseCustomProfiles(value: unknown): ConnectionProfile[] {
    return parseProfileList(value, "custom");
}

function parseProfileList(value: unknown, type: ConnectionProfile["type"]): ConnectionProfile[] {
    if (!Array.isArray(value)) return [];

    const profiles: ConnectionProfile[] = [];
    const seen = new Set<string>();

    for (const entry of value) {
        if (typeof entry !== "object" || entry === null) continue;

        const { id, name, description, networkConfigUrl } = entry as Partial<ConnectionProfile>;
        const normalizedName = normalizeProfileName(name);
        const url = normalizeNetworkConfigUrl(networkConfigUrl);

        if (!isValidProfileId(id) || !normalizedName || !url || seen.has(id)) continue;

        seen.add(id);

        const profile: ConnectionProfile = { id, name: normalizedName, networkConfigUrl: url, type };

        if (typeof description === "string" && description.trim()) {
            profile.description = description.trim().slice(0, 240);
        }

        profiles.push(profile);
    }

    return profiles;
}

/**
 * Parses and validates an untrusted Network Configuration response.
 *
 * The relay is the authoritative source of the routing policy; Dohcord only
 * checks that the response is well formed and safe to turn into PAC rules.
 */
export function parseNetworkConfig(value: unknown, now = Date.now()): NetworkConfigResult {
    if (typeof value !== "object" || value === null) return fail("The server did not return a JSON object");

    const root = value as Record<string, unknown>;
    let config: ProfileNetworkConfig;

    try {
        if (root.schemaVersion !== undefined) {
            config = parseVersionedConfig(root);
        } else if (root.version === 1) {
            // Older relays only send the proxy block with its destination list
            config = parseLegacyConfig(root);
        } else {
            return fail("Unsupported Network Configuration schema version");
        }
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }

    if (root.rtcRelay !== undefined) {
        if (typeof root.rtcRelay !== "object" || root.rtcRelay === null) {
            return fail("The rtcRelay block is malformed");
        }

        const relay = root.rtcRelay as { iceServers?: unknown; expiresAt?: unknown };
        const credentials = parseRtcRelayCredentials(relay, now);
        if (!credentials.ok) {
            return {
                ok: false,
                error: `The RTC relay configuration is unusable: ${credentials.error}`,
                expired: /expired/i.test(credentials.error)
            };
        }

        for (const server of credentials.iceServers) {
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];

            for (const url of urls) {
                const problem = getTurnUrlError(url);
                if (problem) return fail(problem);
            }
        }

        const declared = parseDeclaredExpiry(relay.expiresAt);
        config.rtcRelay = {
            iceServers: credentials.iceServers,
            expiresAt: declared ? Math.min(declared, credentials.expiresAt) : credentials.expiresAt
        };
    }

    return { ok: true, config };
}

function parseVersionedConfig(root: Record<string, unknown>): ProfileNetworkConfig {
    if (root.schemaVersion !== 1) throw new Error("Unsupported Network Configuration schema version");

    const proxy = parseProxyBlock(root.proxy);
    const domains = parseRoutingPolicy(root.routing);

    return {
        schemaVersion: 1,
        proxy,
        routing: { domains }
    };
}

function parseProxyBlock(value: unknown): ProfileNetworkConfig["proxy"] {
    if (typeof value !== "object" || value === null) throw new Error("The configuration has no proxy object");

    const { scheme, host: rawHost, port } = value as { scheme?: unknown; host?: unknown; port?: unknown };

    if (scheme !== "https") throw new Error("The proxy scheme must be https");

    const host = normalizeProxyHost(rawHost);
    if (!host) throw new Error("The proxy host is invalid");
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("The proxy port is invalid");
    }

    return { url: `https://${formatHostPort(host, port)}/`, host, port };
}

function parseLegacyConfig(root: Record<string, unknown>): ProfileNetworkConfig {
    const legacy = root.httpsProxy;
    if (typeof legacy !== "object" || legacy === null) throw new Error("The configuration has no httpsProxy object");

    const { url: rawUrl, allowedDestinations } = legacy as { url?: unknown; allowedDestinations?: unknown };
    const proxyUrl = normalizeNetworkConfigUrl(rawUrl);
    if (!proxyUrl) throw new Error("The HTTPS proxy URL is missing or is not a valid https:// URL");

    const parsed = new URL(proxyUrl);
    if (parsed.port && Number(parsed.port) < 1) throw new Error("The HTTPS proxy URL has an invalid port");

    const domains = parseLegacyDestinations(allowedDestinations);

    return {
        schemaVersion: 1,
        proxy: {
            url: proxyUrl,
            host: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : 443
        },
        routing: { domains }
    };
}

function parseRoutingPolicy(value: unknown): RoutingDomain[] {
    if (typeof value !== "object" || value === null) throw new Error("The configuration has no routing object");

    const { domains } = value as { domains?: unknown };
    if (!Array.isArray(domains) || !domains.length) throw new Error("The routing policy allows no domains");
    if (domains.length > MAX_ROUTING_DOMAINS) throw new Error("The routing policy contains too many domains");

    const parsed: RoutingDomain[] = [];
    const seen = new Set<string>();

    for (const entry of domains) {
        if (typeof entry !== "object" || entry === null) throw new Error("The routing policy has an invalid domain");

        const { host: rawHost, match, ports } = entry as { host?: unknown; match?: unknown; ports?: unknown };
        const host = normalizeRoutingHost(rawHost);
        if (!host) throw new Error(`The routing policy has an invalid host: ${String(rawHost)}`);

        if (match !== "exact" && match !== "suffix") {
            throw new Error(`The routing policy has an invalid match mode for ${host}`);
        }

        const key = `${match}:${host}`;
        if (seen.has(key)) throw new Error(`The routing policy contains ${host} twice`);
        seen.add(key);

        const portRanges = parsePortRanges(ports);
        if (!portRanges.length) throw new Error(`The routing policy allows no ports for ${host}`);

        parsed.push({ host, match, portRanges });
    }

    return parsed;
}

function parseLegacyDestinations(value: unknown): RoutingDomain[] {
    if (!Array.isArray(value) || !value.length) throw new Error("The configuration allows no destinations");
    if (value.length > MAX_ROUTING_DOMAINS) throw new Error("The configuration allows too many destinations");

    const parsed: RoutingDomain[] = [];
    const seen = new Set<string>();

    for (const entry of value) {
        if (typeof entry !== "object" || entry === null) {
            throw new Error("The configuration contains an invalid destination");
        }

        const { domain, ports, portRanges } = entry as { domain?: unknown; ports?: unknown; portRanges?: unknown };
        const host = normalizeRoutingHost(domain);
        if (!host) throw new Error(`The destination "${String(domain)}" is not a valid host`);

        const ranges = parseLegacyPorts(ports, portRanges);
        if (!ranges.length) throw new Error(`The destination "${host}" allows no ports`);
        if (seen.has(host)) throw new Error(`The destination "${host}" appears twice`);
        seen.add(host);

        parsed.push({ host, match: "suffix", portRanges: ranges });
    }

    return parsed;
}

function parsePortRanges(value: unknown): PortRange[] {
    if (!Array.isArray(value)) throw new Error("A routing entry has an invalid port list");
    if (value.length > MAX_PORT_RANGES_PER_DOMAIN) throw new Error("A routing entry lists too many port ranges");

    const ranges: PortRange[] = [];

    for (const entry of value) {
        if (typeof entry !== "object" || entry === null) throw new Error("A routing entry has an invalid port range");

        const { from, to } = entry as { from?: unknown; to?: unknown };
        if (!isValidPort(from) || !isValidPort(to) || from > to) {
            throw new Error("A routing entry has an invalid port range");
        }

        if (!ranges.some(range => range.from === from && range.to === to)) ranges.push({ from, to });
    }

    return ranges;
}

function parseLegacyPorts(ports: unknown, portRanges: unknown): PortRange[] {
    const ranges: PortRange[] = [];

    if (ports !== undefined && ports !== null) {
        if (!Array.isArray(ports)) throw new Error("A destination has an invalid port list");
        if (ports.length > MAX_PORT_RANGES_PER_DOMAIN) throw new Error("A destination lists too many ports");

        for (const port of ports) {
            if (!isValidPort(port)) throw new Error("A destination lists an invalid port");
            if (!ranges.some(range => range.from === port && range.to === port)) ranges.push({ from: port, to: port });
        }
    }

    if (portRanges !== undefined && portRanges !== null) {
        if (!Array.isArray(portRanges)) throw new Error("A destination has an invalid port range list");
        if (portRanges.length > MAX_PORT_RANGES_PER_DOMAIN) throw new Error("A destination lists too many port ranges");

        for (const entry of portRanges) {
            if (typeof entry !== "object" || entry === null) throw new Error("A destination has an invalid port range");

            const { from, to } = entry as { from?: unknown; to?: unknown };
            if (!isValidPort(from) || !isValidPort(to) || from > to) {
                throw new Error("A destination has an invalid port range");
            }

            if (!ranges.some(range => range.from === from && range.to === to)) ranges.push({ from, to });
        }
    }

    return ranges;
}

function isValidPort(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Lowercases and removes a trailing root dot, as DNS names are case insensitive */
function normalizeRoutingHost(value: unknown): string | undefined {
    if (typeof value !== "string") return;

    let host = value.trim().toLowerCase();
    while (host.endsWith(".")) host = host.slice(0, -1);

    if (!host || host.length > 253) return;
    if (!HOSTNAME.test(host)) return;

    return host;
}

function normalizeProxyHost(value: unknown): string | undefined {
    const host = normalizeRoutingHost(value);
    if (host) return host;

    if (typeof value === "string" && IPV6.test(value.trim().toLowerCase())) return value.trim().toLowerCase();

    return undefined;
}

function getTurnUrlError(url: string): string | undefined {
    const match = TURN_URL.exec(url.trim());
    if (!match) return `The TURN URL "${url}" is not valid`;

    if (match[3]) {
        const port = Number(match[3]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return `The TURN URL "${url}" has an invalid port`;
    }

    return undefined;
}

/**
 * Builds the PAC script from the validated routing policy.
 *
 * A matching destination and port uses the HTTPS proxy. A matching destination
 * on a port the policy does not allow is rejected instead of sent direct. All
 * unrelated destinations stay DIRECT. The proxy is never followed by DIRECT, so
 * a relay failure cannot silently bypass the profile.
 */
export function buildPacScript(config: ProfileNetworkConfig): string {
    const proxy = `HTTPS ${formatHostPort(config.proxy.host, config.proxy.port)}`;
    const rules = config.routing.domains.map(domain => ({
        host: domain.host,
        exact: domain.match === "exact",
        ranges: domain.portRanges.map(range => [range.from, range.to])
    }));

    return `/* Dohcord connection profile */
var DOHCORD_PROXY = ${JSON.stringify(proxy)};
var DOHCORD_REJECT = ${JSON.stringify(PAC_REJECT_PROXY)};
var DOHCORD_RULES = ${JSON.stringify(rules)};

function dohcordNormalizeHost(host) {
    host = host.toLowerCase();
    while (host.length > 1 && host.charAt(host.length - 1) === ".") host = host.substring(0, host.length - 1);
    return host;
}

function dohcordMatches(host, rule) {
    if (host === rule.host) return true;
    if (rule.exact) return false;
    if (host.length <= rule.host.length) return false;
    return host.substring(host.length - rule.host.length - 1) === "." + rule.host;
}

function dohcordPort(url) {
    var schemeEnd = url.indexOf("://");
    if (schemeEnd < 0) return 0;

    var rest = url.substring(schemeEnd + 3);
    var end = rest.length;
    for (var i = 0; i < rest.length; i++) {
        var c = rest.charAt(i);
        if (c === "/" || c === "?" || c === "#") {
            end = i;
            break;
        }
    }

    var authority = rest.substring(0, end);
    var at = authority.lastIndexOf("@");
    if (at >= 0) authority = authority.substring(at + 1);

    if (authority.charAt(0) === "[") {
        var close = authority.indexOf("]");
        if (close < 0) return 0;
        var afterHost = authority.substring(close + 1);
        return afterHost.charAt(0) === ":" ? parseInt(afterHost.substring(1), 10) || 0 : 443;
    }

    var colon = authority.lastIndexOf(":");
    return colon >= 0 ? parseInt(authority.substring(colon + 1), 10) || 0 : 443;
}

function dohcordPortAllowed(port, rule) {
    for (var i = 0; i < rule.ranges.length; i++) {
        if (port >= rule.ranges[i][0] && port <= rule.ranges[i][1]) return true;
    }

    return false;
}

function FindProxyForURL(url, host) {
    var schemeEnd = url.indexOf(":");
    if (schemeEnd < 0) return "DIRECT";

    var scheme = url.substring(0, schemeEnd).toLowerCase();
    if (scheme !== "https" && scheme !== "wss") return "DIRECT";

    host = dohcordNormalizeHost(host);
    var port = dohcordPort(url);
    if (!port) return DOHCORD_REJECT;

    for (var i = 0; i < DOHCORD_RULES.length; i++) {
        var rule = DOHCORD_RULES[i];
        if (!dohcordMatches(host, rule)) continue;

        return dohcordPortAllowed(port, rule) ? DOHCORD_PROXY : DOHCORD_REJECT;
    }

    return "DIRECT";
}
`;
}

/**
 * Fail-closed policy used while an active profile's configuration is unavailable
 * and no policy has been applied yet. Because no destination list is known, every
 * HTTPS/WSS connection is refused rather than guessed at. Loopback stays direct so
 * local tooling keeps working.
 */
export function buildUnavailablePacScript(): string {
    return `/* Dohcord connection profile: configuration unavailable */
var DOHCORD_REJECT = ${JSON.stringify(PAC_REJECT_PROXY)};

function FindProxyForURL(url, host) {
    var schemeEnd = url.indexOf(":");
    if (schemeEnd < 0) return "DIRECT";

    var scheme = url.substring(0, schemeEnd).toLowerCase();
    if (scheme !== "https" && scheme !== "wss") return "DIRECT";

    host = host.toLowerCase();
    while (host.length > 1 && host.charAt(host.length - 1) === ".") host = host.substring(0, host.length - 1);

    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "DIRECT";

    return DOHCORD_REJECT;
}
`;
}

function formatHostPort(host: string, port: number): string {
    return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function fail(error: string): NetworkConfigResult {
    return { ok: false, error };
}
