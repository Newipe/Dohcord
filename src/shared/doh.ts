/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface DohResolver {
    label: string;
    url: string;
    /** Optional extra info about the provider, shown under it in the settings UI */
    description?: string;
}

/** Sentinel value of the provider pickers for "no DoH" */
export const DOH_OFF = "off";
/** Sentinel value of the provider pickers for "user supplied URL" */
export const DOH_CUSTOM = "custom";

export const REMOTE_DOH_RESOLVERS_URL = "https://raw.githubusercontent.com/Newipe/Dohcord/main/resolvers.json";

/**
 * Used when the remote list cannot be loaded. Keep this in sync with resolvers.json
 * so the app is never left without a single usable provider.
 */
export const DEFAULT_DOH_RESOLVERS: DohResolver[] = [
    {
        label: "Cloudflare (1.1.1.1)",
        url: "https://cloudflare-dns.com/dns-query",
        description: "Fast privacy focused resolver operated by Cloudflare."
    },
    {
        label: "Google (dns.google)",
        url: "https://dns.google/dns-query",
        description: "Reliable global resolver operated by Google."
    },
    {
        label: "Newipe (newipe.qd.je)",
        url: "https://newipe.qd.je/dns-query",
        description: "Routes Discord through an SNI proxy. Recommended in Iran, may not work elsewhere."
    },
    {
        label: "VanillaApp (vanillapp.ir)",
        url: "https://dns.vanillapp.ir/dns-query",
        description: "Iranian resolver. Requires registering your IP with the provider first."
    },
    {
        label: "Quad9 (dns.quad9.net)",
        url: "https://dns.quad9.net/dns-query",
        description: "Blocks domains known to distribute malware and phishing."
    },
    {
        label: "OpenDNS (doh.opendns.com)",
        url: "https://doh.opendns.com/dns-query",
        description: "Cisco's resolver, with optional content filtering."
    }
];

/**
 * Validates and canonicalises a user supplied DoH URL.
 *
 * @returns The canonical URL, or undefined if the value is not a usable resolver
 */
export function normalizeDohUrl(value: unknown): string | undefined {
    if (typeof value !== "string") return;

    const trimmed = value.trim();
    if (!trimmed) return;

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return;
    }

    // Chromium only accepts hostnames resolved over TLS, anything else is a typo
    if (url.protocol !== "https:" || !url.hostname) return;
    // Credentials are never part of a resolver template
    if (url.username || url.password) return;

    url.hash = "";

    return url.href;
}

export function isValidDohUrl(value: unknown): boolean {
    return normalizeDohUrl(value) !== undefined;
}

/**
 * The hostname of a resolver, for display purposes. Falls back to the raw value
 * so half typed input can still be shown.
 */
export function getDohHost(value: unknown): string | undefined {
    const url = normalizeDohUrl(value);
    if (url) return new URL(url).hostname;

    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Parses an untrusted resolver list (the remote resolvers.json), dropping
 * anything malformed and de-duplicating by URL.
 *
 * @returns The parsed resolvers, or undefined if there is not a single usable one
 */
export function parseDohResolvers(value: unknown): DohResolver[] | undefined {
    if (!Array.isArray(value)) return;

    const resolvers: DohResolver[] = [];
    const seen = new Set<string>();

    for (const entry of value) {
        if (typeof entry !== "object" || entry === null) continue;

        const { label, url: rawUrl, description } = entry as Partial<DohResolver>;
        const url = normalizeDohUrl(rawUrl);

        if (typeof label !== "string" || !label.trim() || !url || seen.has(url)) continue;

        seen.add(url);

        const resolver: DohResolver = { label: label.trim(), url };
        if (typeof description === "string" && description.trim()) resolver.description = description.trim();

        resolvers.push(resolver);
    }

    return resolvers.length ? resolvers : undefined;
}

/** Finds the predefined resolver matching the stored DoH URL, if any */
export function findDohResolver(resolvers: DohResolver[], url: unknown): DohResolver | undefined {
    const normalized = normalizeDohUrl(url);
    if (!normalized) return;

    return resolvers.find(resolver => normalizeDohUrl(resolver.url) === normalized);
}

/**
 * Resolves the value the provider picker should show for the stored settings.
 * See {@link DOH_OFF} and {@link DOH_CUSTOM}.
 */
export function getDohProviderValue(
    settings: { enableDoh?: boolean; dohUrl?: string },
    resolvers: DohResolver[]
): string {
    if (!settings.enableDoh) return DOH_OFF;

    // Enabled, but the URL is empty or not a valid endpoint (yet)
    return findDohResolver(resolvers, settings.dohUrl)?.url ?? DOH_CUSTOM;
}

/** The result of the in-app resolver test, see IpcEvents.DOH_RESOLVE_HOST */
export interface DohTestResult {
    ok: boolean;
    addresses?: string[];
    tookMs?: number;
    error?: string;
}
