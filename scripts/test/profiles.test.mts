/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import vm from "node:vm";

import {
    buildPacScript,
    buildUnavailablePacScript,
    DOH_PROFILE_BLOCK_MESSAGE,
    MAX_NETWORK_CONFIG_BYTES,
    MAX_ROUTING_DOMAINS,
    parseNetworkConfig,
    type ProfileNetworkConfig,
    resolveEffectiveDoh
} from "../../src/shared/profiles";

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

interface MutableDomain {
    host: string;
    match: string;
    ports: Array<{ from: number; to: number }>;
}

interface MutableConfig {
    schemaVersion: number;
    proxy: { scheme: string; host: string; port: number };
    routing: { domains: MutableDomain[] };
    rtcRelay?: unknown;
}

function relayResponse(): MutableConfig {
    return {
        schemaVersion: 1,
        proxy: { scheme: "https", host: "13.48.52.216", port: 443 },
        routing: {
            domains: [
                {
                    host: "discord-attachments-uploads-prd.storage.googleapis.com",
                    match: "exact",
                    ports: [{ from: 443, to: 443 }]
                },
                { host: "discord.com", match: "suffix", ports: [{ from: 443, to: 443 }] },
                { host: "discord.gg", match: "suffix", ports: [{ from: 443, to: 443 }] },
                {
                    host: "discord.media",
                    match: "suffix",
                    ports: [
                        { from: 443, to: 443 },
                        { from: 1024, to: 65535 }
                    ]
                },
                { host: "discordapp.com", match: "suffix", ports: [{ from: 443, to: 443 }] },
                { host: "discordapp.net", match: "suffix", ports: [{ from: 443, to: 443 }] }
            ]
        }
    };
}

function variant(mutate: (config: MutableConfig) => void): unknown {
    const config = structuredClone(relayResponse());
    mutate(config);
    return config;
}

function parsed(value: unknown = relayResponse()): ProfileNetworkConfig {
    const result = parseNetworkConfig(value);

    if (!result.ok) throw new Error(`Expected a valid configuration, got: ${result.error}`);

    return result.config;
}

function finder(script: string) {
    const context = vm.createContext({});
    vm.runInContext(script, context);

    return (url: string, host: string) =>
        vm.runInContext(`FindProxyForURL(${JSON.stringify(url)}, ${JSON.stringify(host)})`, context) as string;
}

const PROXY = "HTTPS 13.48.52.216:443";

/* ---------------------------------------------------------------- */
/* DoH is unavailable while a profile is active                      */
/* ---------------------------------------------------------------- */

assert.equal(DOH_PROFILE_BLOCK_MESSAGE, "DoH is unavailable while a Network Profile is enabled.");

// Direct Connection may use DoH, but only when the user asked for it
assert.equal(resolveEffectiveDoh(undefined, true), true);
assert.equal(resolveEffectiveDoh(undefined, false), false);

// Built-in and custom profiles both disable a saved DoH setting
assert.equal(resolveEffectiveDoh("newipe", true), false);
assert.equal(resolveEffectiveDoh("my-custom-profile", true), false);
assert.equal(resolveEffectiveDoh("newipe", false), false);

/* ---------------------------------------------------------------- */
/* Parsing the relay's routing contract                              */
/* ---------------------------------------------------------------- */

const config = parsed();

assert.equal(config.proxy.host, "13.48.52.216");
assert.equal(config.proxy.port, 443);
assert.equal(config.routing.domains.length, 6);
assert.equal(config.routing.domains[0].host, "discord-attachments-uploads-prd.storage.googleapis.com");
assert.equal(config.routing.domains[0].match, "exact");
assert.deepEqual(config.routing.domains[3].portRanges, [
    { from: 443, to: 443 },
    { from: 1024, to: 65535 }
]);

// The configuration endpoint port is not the proxy port
assert.notEqual(config.proxy.port, 8443);

/* ---------------------------------------------------------------- */
/* PAC generation and matching                                       */
/* ---------------------------------------------------------------- */

const find = finder(buildPacScript(config));

// Suffix rules match the domain itself and its subdomains
assert.equal(find("https://discord.com/api/v9/gateway", "discord.com"), PROXY);
assert.equal(find("https://canary.discord.com/login", "canary.discord.com"), PROXY);

// Suffix rules respect DNS label boundaries
assert.equal(find("https://notdiscord.com/", "notdiscord.com"), "DIRECT");
assert.equal(find("https://discord.com.example.org/", "discord.com.example.org"), "DIRECT");
assert.equal(find("https://discordapp.com.evil.test/", "discordapp.com.evil.test"), "DIRECT");

// Exact rules do not match subdomains
assert.equal(
    find(
        "https://discord-attachments-uploads-prd.storage.googleapis.com/file",
        "discord-attachments-uploads-prd.storage.googleapis.com"
    ),
    PROXY
);
assert.equal(
    find(
        "https://evil.discord-attachments-uploads-prd.storage.googleapis.com/file",
        "evil.discord-attachments-uploads-prd.storage.googleapis.com"
    ),
    "DIRECT"
);

// Hosts are compared case insensitively and with a trailing root dot
assert.equal(find("https://DISCORD.COM/", "DISCORD.COM."), PROXY);

// Exact ports and explicit port ranges
assert.equal(find("https://discord.media/voice", "discord.media"), PROXY);
assert.equal(find("https://discord.media:2048/voice", "discord.media"), PROXY);
assert.equal(find("https://discord.media:65535/voice", "discord.media"), PROXY);

// A matching destination on a port the policy does not allow is rejected,
// never sent direct
for (const url of ["https://discord.com:8443/", "https://discord.media:1000/", "wss://discord.com:8443/"]) {
    const decision = find(url, new URL(url).hostname);
    assert.notEqual(decision, "DIRECT", `${url} must not go direct`);
    assert.ok(!decision.startsWith("HTTPS "), `${url} must not use the proxy`);
}

// Unrelated destinations stay direct
assert.equal(find("https://example.com/", "example.com"), "DIRECT");
assert.equal(find("https://github.com/", "github.com"), "DIRECT");
assert.equal(find("http://discord.com/", "discord.com"), "DIRECT");

// A matching destination never has a DIRECT proxy-failure fallback
const pacSource = buildPacScript(config);
assert.ok(!/HTTPS\s[^"]*;\s*DIRECT/i.test(pacSource));
assert.ok(!pacSource.includes("; DIRECT"));

/* ---------------------------------------------------------------- */
/* The policy is dynamic: add and remove domains without code changes */
/* ---------------------------------------------------------------- */

const added = variant(entry => {
    entry.routing.domains.push({
        host: "new-relay-destination.example",
        match: "exact",
        ports: [{ from: 443, to: 443 }]
    });
});
const addedConfig = parsed(added);
const findAdded = finder(buildPacScript(addedConfig));

assert.equal(findAdded("https://new-relay-destination.example/", "new-relay-destination.example"), PROXY);
assert.equal(find("https://new-relay-destination.example/", "new-relay-destination.example"), "DIRECT");

const removed = variant(entry => {
    entry.routing.domains = entry.routing.domains.filter(domain => domain.host !== "discord.gg");
});
const findRemoved = finder(buildPacScript(parsed(removed)));

assert.equal(find("https://discord.gg/invite", "discord.gg"), PROXY);
assert.equal(findRemoved("https://discord.gg/invite", "discord.gg"), "DIRECT");
assert.equal(findRemoved("https://discord.com/", "discord.com"), PROXY);

/* ---------------------------------------------------------------- */
/* Legacy relay responses are adapted, not hardcoded                 */
/* ---------------------------------------------------------------- */

const legacy = parsed({
    version: 1,
    httpsProxy: {
        url: "https://13.48.52.216:443/",
        allowedDestinations: [
            { domain: "discord.com", ports: [443] },
            { domain: "discord.media", ports: [443], portRanges: [{ from: 1024, to: 65535 }] }
        ]
    }
});

assert.equal(legacy.proxy.host, "13.48.52.216");
assert.equal(legacy.proxy.port, 443);
assert.equal(legacy.routing.domains[0].match, "suffix");
assert.deepEqual(legacy.routing.domains[1].portRanges, [
    { from: 443, to: 443 },
    { from: 1024, to: 65535 }
]);

/* ---------------------------------------------------------------- */
/* Invalid configurations are rejected                               */
/* ---------------------------------------------------------------- */

const invalid: Array<[string, unknown]> = [
    ["not an object", "nope"],
    ["unsupported schema version", variant(entry => (entry.schemaVersion = 2))],
    ["plain http proxy", variant(entry => (entry.proxy.scheme = "http"))],
    ["missing proxy", variant(entry => delete (entry as Partial<MutableConfig>).proxy)],
    ["proxy port zero", variant(entry => (entry.proxy.port = 0))],
    ["proxy port too high", variant(entry => (entry.proxy.port = 70000))],
    ["proxy port not an integer", variant(entry => (entry.proxy.port = 443.5))],
    ["invalid proxy host", variant(entry => (entry.proxy.host = "not a host"))],
    ["missing routing", variant(entry => delete (entry as Partial<MutableConfig>).routing)],
    ["empty routing", variant(entry => (entry.routing.domains = []))],
    [
        `more than ${MAX_ROUTING_DOMAINS} domains`,
        variant(entry => {
            entry.routing.domains = Array.from({ length: MAX_ROUTING_DOMAINS + 1 }, (_, index) => ({
                host: `relay-${index}.example`,
                match: "exact",
                ports: [{ from: 443, to: 443 }]
            }));
        })
    ],
    ["invalid host", variant(entry => (entry.routing.domains[0].host = "bad host"))],
    ["wildcard host", variant(entry => (entry.routing.domains[0].host = "*.discord.com"))],
    ["unknown match mode", variant(entry => (entry.routing.domains[0].match = "regex"))],
    ["no ports", variant(entry => (entry.routing.domains[0].ports = []))],
    ["port zero", variant(entry => (entry.routing.domains[0].ports = [{ from: 0, to: 443 }]))],
    ["port too high", variant(entry => (entry.routing.domains[0].ports = [{ from: 443, to: 70000 }]))],
    ["inverted range", variant(entry => (entry.routing.domains[0].ports = [{ from: 500, to: 400 }]))],
    ["invalid port entry", variant(entry => (entry.routing.domains[0].ports = [{ from: 443 } as never]))],
    ["duplicate domain", variant(entry => entry.routing.domains.push({ ...entry.routing.domains[1] }))],
    ["no domains", { schemaVersion: 1, proxy: { scheme: "https", host: "13.48.52.216", port: 443 } }],
    ["missing schema version", { proxy: { scheme: "https", host: "13.48.52.216", port: 443 } }]
];

for (const [label, value] of invalid) {
    const result = parseNetworkConfig(value);
    assert.equal(result.ok, false, `Expected rejection for: ${label}`);
}

// The size limit is enforced while reading the response body
assert.equal(MAX_NETWORK_CONFIG_BYTES, 64 * 1024);

/* ---------------------------------------------------------------- */
/* TURN stays separate and credentials never reach the PAC script     */
/* ---------------------------------------------------------------- */

const credentials = "turn-credential-that-must-not-leak";
const turnConfig = parsed({
    ...relayResponse(),
    rtcRelay: {
        iceServers: [
            {
                urls: "turn:13.48.52.216:3478?transport=udp",
                username: `${Math.floor((Date.now() + 3_600_000) / 1000)}:dohcord`,
                credential: credentials
            }
        ],
        expiresAt: Math.floor((Date.now() + 3_600_000) / 1000)
    }
});

assert.ok(turnConfig.rtcRelay, "TURN configuration must be preserved");
assert.ok(!buildPacScript(turnConfig).includes(credentials), "TURN credentials must not reach the PAC script");
assert.ok(!buildPacScript(turnConfig).includes("turn:"), "TURN must stay out of the PAC script");

/* ---------------------------------------------------------------- */
/* Fail-closed policy while no valid configuration is available       */
/* ---------------------------------------------------------------- */

const unavailable = finder(buildUnavailablePacScript());

assert.notEqual(unavailable("https://discord.com/", "discord.com"), "DIRECT");
assert.equal(unavailable("http://discord.com/", "discord.com"), "DIRECT");
assert.equal(unavailable("https://127.0.0.1:8080/", "127.0.0.1"), "DIRECT");
assert.ok(!buildUnavailablePacScript().includes("discord.com"), "the fail-closed PAC must not guess domains");

console.log("profiles tests passed");
