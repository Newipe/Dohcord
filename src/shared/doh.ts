/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface DohResolver {
    label: string;
    url: string;
}

export const REMOTE_DOH_RESOLVERS_URL = "https://raw.githubusercontent.com/Newipe/Dohcord/main/resolvers.json";

export const DEFAULT_DOH_RESOLVERS: DohResolver[] = [
    { label: "Cloudflare (1.1.1.1)", url: "https://cloudflare-dns.com/dns-query" },
    { label: "Google (dns.google)", url: "https://dns.google/dns-query" },
    { label: "Newipe (newipe.qd.je) - Iran only", url: "https://newipe.qd.je/dns-query" },
    { label: "Quad9 (dns.quad9.net)", url: "https://dns.quad9.net/dns-query" },
    { label: "OpenDNS (doh.opendns.com)", url: "https://doh.opendns.com/dns-query" }
];

export function parseDohResolvers(value: unknown): DohResolver[] | undefined {
    if (!Array.isArray(value)) return;

    const resolvers = value.filter(
        (resolver): resolver is DohResolver =>
            typeof resolver === "object" &&
            resolver !== null &&
            typeof (resolver as DohResolver).label === "string" &&
            typeof (resolver as DohResolver).url === "string" &&
            (resolver as DohResolver).label.trim().length > 0 &&
            (resolver as DohResolver).url.startsWith("https://")
    );

    return resolvers.length > 0 ? resolvers : undefined;
}
