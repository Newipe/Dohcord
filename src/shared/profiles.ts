/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseDeclaredExpiry, parseRtcRelayCredentials, type RtcIceServer } from "./rtcRelay";

/**
 * Connection profiles are completely independent from DoH. A profile describes a
 * selective HTTPS CONNECT proxy for Discord traffic and, optionally, a TURN relay
 * for Discord voice. Everything the client applies comes from the profile's own
 * Network Configuration endpoint, never from resolvers.json.
 */

/** Value the profile pickers use for "no profile", a plain direct connection */
export const DIRECT_PROFILE_VALUE = "direct";

export const MAX_CUSTOM_PROFILES = 20;
export const MAX_PROFILE_NAME_LENGTH = 64;
export const MAX_NETWORK_CONFIG_URL_LENGTH = 512;
export const MAX_ALLOWED_DESTINATIONS = 32;
export const MAX_PORTS_PER_DESTINATION = 16;
export const MAX_PORT_RANGES_PER_DESTINATION = 8;

/** Domains Dohcord itself is willing to route through a profile proxy */
export const DISCORD_DOMAIN_ROOTS = [
    "discord.com",
    "discord.gg",
    "discordapp.com",
    "discordapp.net",
    "discord.media"
] as const;

/** Ports allowed on every Discord domain */
export const DEFAULT_DISCORD_PORTS = [443];

/** Dynamic voice endpoints are only allowed on discord.media, and only in this range */
export const DISCORD_MEDIA_PORT_RANGE: PortRange = { from: 1024, to: 65535 };

/**
 * Used by the PAC script when a Discord destination is not permitted by the policy.
 * The request is sent to a port nothing listens on, so it fails instead of leaking
 * the original destination over a direct connection.
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

export interface ProfileDestination {
    domain: string;
    ports: number[];
    portRanges: PortRange[];
}

export interface ProfileNetworkConfig {
    version: 1;
    httpsProxy: {
        url: string;
        host: string;
        port: number;
        allowedDestinations: ProfileDestination[];
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
const TURN_URL =
    /^(turn|turns):(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?(?:\?transport=(?:udp|tcp))?$/i;

/** Trims and validates a profile name entered by the user */
export function normalizeProfileName(value: unknown): string | undefined {
    if (typeof value !== "string") return;

    const name = value.trim().replace(/\s+/g, " ");
    if (!name || name.length > MAX_PROFILE_NAME_LENGTH) return;
    // Control characters would make the settings list unreadable
    if (/[\u0000-\u001f\u007f]/.test(name)) return;

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

/** Parses the packaged profiles.json */
export function parsePackagedProfiles(value: unknown): ConnectionProfile[] {
    return parseProfileList(value, "builtin");
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

/** Whether host equals domain or is a subdomain of it, never a lookalike suffix */
export function isWithinDomain(host: string, domain: string): boolean {
    return host === domain || host.endsWith(`.${domain}`);
}

/** Whether the domain is one Dohcord itself allows to be proxied */
export function isDiscordDomain(domain: string): boolean {
    return DISCORD_DOMAIN_ROOTS.some(root => isWithinDomain(domain, root));
}

/** The client's own maximum port scope; a server can narrow it but never widen it */
export function isPortWithinClientPolicy(domain: string, port: number): boolean {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    if (port === 443) return true;

    return (
        isWithinDomain(domain, "discord.media") &&
        port >= DISCORD_MEDIA_PORT_RANGE.from &&
        port <= DISCORD_MEDIA_PORT_RANGE.to
    );
}

export function isPortAllowed(host: string, port: number, destinations: ProfileDestination[]): boolean {
    return destinations.some(
        destination =>
            isWithinDomain(host, destination.domain) &&
            (destination.ports.includes(port) ||
                destination.portRanges.some(range => port >= range.from && port <= range.to))
    );
}

/**
 * Parses and validates an untrusted Network Configuration response.
 *
 * The configuration may narrow the client's Discord scope, but anything outside the
 * client's own domain and port policy is rejected outright rather than ignored.
 */
export function parseNetworkConfig(value: unknown, now = Date.now()): NetworkConfigResult {
    if (typeof value !== "object" || value === null) return fail("The server did not return a JSON object");

    const root = value as Record<string, unknown>;
    if (root.version !== 1) return fail("Unsupported Network Configuration version");

    const proxy = root.httpsProxy;
    if (typeof proxy !== "object" || proxy === null) return fail("The configuration has no httpsProxy object");

    const { url: rawUrl, allowedDestinations } = proxy as { url?: unknown; allowedDestinations?: unknown };
    const proxyUrl = normalizeNetworkConfigUrl(rawUrl);
    if (!proxyUrl) return fail("The HTTPS proxy URL is missing or is not a valid https:// URL");

    const parsedProxy = new URL(proxyUrl);
    if (parsedProxy.port && Number(parsedProxy.port) < 1) return fail("The HTTPS proxy URL has an invalid port");

    const destinations = parseDestinations(allowedDestinations);
    if (typeof destinations === "string") return fail(destinations);

    const config: ProfileNetworkConfig = {
        version: 1,
        httpsProxy: {
            url: proxyUrl,
            host: parsedProxy.hostname,
            port: parsedProxy.port ? Number(parsedProxy.port) : 443,
            allowedDestinations: destinations
        }
    };

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

function parseDestinations(value: unknown): ProfileDestination[] | string {
    if (!Array.isArray(value) || !value.length) return "The configuration allows no destinations";
    if (value.length > MAX_ALLOWED_DESTINATIONS) return "The configuration allows too many destinations";

    const destinations: ProfileDestination[] = [];

    for (const entry of value) {
        if (typeof entry !== "object" || entry === null) return "The configuration contains an invalid destination";

        const {
            domain: rawDomain,
            ports: rawPorts,
            portRanges: rawRanges
        } = entry as {
            domain?: unknown;
            ports?: unknown;
            portRanges?: unknown;
        };

        if (typeof rawDomain !== "string") return "A destination has no domain";

        const domain = rawDomain.trim().toLowerCase();
        if (!HOSTNAME.test(domain) || domain.startsWith("."))
            return `The destination "${rawDomain}" is not a valid domain`;

        // A server may narrow the scope, never expand it to other infrastructure
        if (!isDiscordDomain(domain)) return `The destination "${domain}" is not a Discord domain Dohcord allows`;

        const ports = parsePorts(rawPorts);
        if (typeof ports === "string") return ports;

        const portRanges = parsePortRanges(rawRanges);
        if (typeof portRanges === "string") return portRanges;

        if (!ports.length && !portRanges.length) return `The destination "${domain}" allows no ports`;

        for (const port of ports) {
            if (!isPortWithinClientPolicy(domain, port)) {
                return `The destination "${domain}" requests port ${port}, which is outside Dohcord's Discord policy`;
            }
        }

        for (const range of portRanges) {
            if (range.to > DISCORD_MEDIA_PORT_RANGE.to || range.from < DISCORD_MEDIA_PORT_RANGE.from) {
                return `The destination "${domain}" requests a port range outside Dohcord's Discord policy`;
            }
            if (!isWithinDomain(domain, "discord.media")) {
                return `Only discord.media may use a dynamic port range, not "${domain}"`;
            }
        }

        destinations.push({ domain, ports, portRanges });
    }

    return destinations;
}

function parsePorts(value: unknown): number[] | string {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return "A destination has an invalid port list";
    if (value.length > MAX_PORTS_PER_DESTINATION) return "A destination lists too many ports";

    const ports: number[] = [];

    for (const port of value) {
        if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
            return "A destination lists an invalid port";
        }
        if (!ports.includes(port)) ports.push(port);
    }

    return ports;
}

function parsePortRanges(value: unknown): PortRange[] | string {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return "A destination has an invalid port range list";
    if (value.length > MAX_PORT_RANGES_PER_DESTINATION) return "A destination lists too many port ranges";

    const ranges: PortRange[] = [];

    for (const entry of value) {
        if (typeof entry !== "object" || entry === null) return "A destination has an invalid port range";

        const { from, to } = entry as { from?: unknown; to?: unknown };
        if (typeof from !== "number" || typeof to !== "number") return "A destination has an invalid port range";
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 65535 || from > to) {
            return "A destination has an invalid port range";
        }

        if (!ranges.some(range => range.from === from && range.to === to)) ranges.push({ from, to });
    }

    return ranges;
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
 * Builds the PAC script for a validated configuration.
 *
 * Only approved Discord destinations use the HTTPS proxy. Everything else stays
 * DIRECT. An approved hostname on a port the policy does not allow is rejected
 * rather than sent direct, so the original destination cannot leak.
 */
export function buildPacScript(config: ProfileNetworkConfig): string {
    const proxy = `HTTPS ${formatHostPort(config.httpsProxy.host, config.httpsProxy.port)}`;
    const destinations = config.httpsProxy.allowedDestinations.map(destination => ({
        domain: destination.domain,
        ports: destination.ports,
        ranges: destination.portRanges.map(range => [range.from, range.to])
    }));

    return `/* Dohcord connection profile */
var DOHCORD_PROXY = ${JSON.stringify(proxy)};
var DOHCORD_REJECT = ${JSON.stringify(PAC_REJECT_PROXY)};
var DOHCORD_DESTINATIONS = ${JSON.stringify(destinations)};

function dohcordMatchesDomain(host, domain) {
    if (host === domain) return true;
    if (host.length <= domain.length) return false;
    return host.substring(host.length - domain.length - 1) === "." + domain;
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

function dohcordPortAllowed(port, destination) {
    for (var i = 0; i < destination.ports.length; i++) {
        if (destination.ports[i] === port) return true;
    }

    for (var j = 0; j < destination.ranges.length; j++) {
        if (port >= destination.ranges[j][0] && port <= destination.ranges[j][1]) return true;
    }

    return false;
}

function FindProxyForURL(url, host) {
    var schemeEnd = url.indexOf(":");
    if (schemeEnd < 0) return "DIRECT";

    var scheme = url.substring(0, schemeEnd).toLowerCase();
    if (scheme !== "https" && scheme !== "wss") return "DIRECT";

    host = host.toLowerCase();
    var port = dohcordPort(url);
    if (!port) return DOHCORD_REJECT;

    for (var i = 0; i < DOHCORD_DESTINATIONS.length; i++) {
        var destination = DOHCORD_DESTINATIONS[i];
        if (!dohcordMatchesDomain(host, destination.domain)) continue;

        return dohcordPortAllowed(port, destination) ? DOHCORD_PROXY : DOHCORD_REJECT;
    }

    return "DIRECT";
}
`;
}

/**
 * Fail closed policy used while a selected profile's configuration is unavailable.
 * Discord destinations are blackholed instead of silently going direct; everything
 * else keeps working normally.
 */
export function buildUnavailablePacScript(): string {
    return `/* Dohcord connection profile: configuration unavailable */
var DOHCORD_REJECT = ${JSON.stringify(PAC_REJECT_PROXY)};
var DOHCORD_ROOTS = ${JSON.stringify(DISCORD_DOMAIN_ROOTS)};

function dohcordMatchesDomain(host, domain) {
    if (host === domain) return true;
    if (host.length <= domain.length) return false;
    return host.substring(host.length - domain.length - 1) === "." + domain;
}

function FindProxyForURL(url, host) {
    var schemeEnd = url.indexOf(":");
    if (schemeEnd < 0) return "DIRECT";

    var scheme = url.substring(0, schemeEnd).toLowerCase();
    if (scheme !== "https" && scheme !== "wss") return "DIRECT";

    host = host.toLowerCase();

    for (var i = 0; i < DOHCORD_ROOTS.length; i++) {
        if (dohcordMatchesDomain(host, DOHCORD_ROOTS[i])) return DOHCORD_REJECT;
    }

    return "DIRECT";
}
`;
}

function formatHostPort(host: string, port: number): string {
    return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function fail(error: string): NetworkConfigResult {
    return { ok: false, error };
}
