/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createServer, type Server } from "http";

/**
 * Electron's ProxyConfig.pacScript takes the URL of a PAC file, not the script
 * itself. Chromium rejects a data: URL and cannot read a file: URL here, so the
 * generated policy is served from a loopback HTTP server and Chromium is pointed
 * at it. The server only ever serves the current PAC script, which contains no
 * credentials, and is bound to 127.0.0.1.
 */

let server: Server | undefined;
let serverPort: number | undefined;
let starting: Promise<number> | undefined;

let currentScript = "";
let version = 0;

/** Stores a new PAC script and returns the loopback URL Chromium should use */
export async function publishPacScript(script: string): Promise<string> {
    currentScript = script;
    version++;

    const port = await ensureServer();

    // A fresh version makes Chromium fetch the script again after a profile change
    return `http://127.0.0.1:${port}/proxy.pac?v=${version}`;
}

/** A PAC URL that cannot be fetched, used only if the local server cannot start */
export const UNREACHABLE_PAC_URL = "http://127.0.0.1:9/proxy.pac";

function ensureServer(): Promise<number> {
    if (server && serverPort !== undefined) return Promise.resolve(serverPort);
    if (starting) return starting;

    starting = new Promise<number>((resolve, reject) => {
        const instance = createServer((request, response) => {
            if (request.method !== "GET" && request.method !== "HEAD") {
                response.writeHead(405, { Allow: "GET, HEAD" });
                response.end();
                return;
            }

            const body = currentScript;

            response.writeHead(200, {
                "Content-Type": "application/x-ns-proxy-autoconfig",
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                Pragma: "no-cache",
                "Content-Length": Buffer.byteLength(body)
            });

            response.end(request.method === "HEAD" ? undefined : body);
        });

        instance.once("error", err => {
            starting = undefined;
            instance.close();
            reject(err);
        });

        instance.listen(0, "127.0.0.1", () => {
            const address = instance.address();
            if (!address || typeof address === "string") {
                starting = undefined;
                instance.close();
                reject(new Error("The PAC server did not report a port"));
                return;
            }

            server = instance;
            serverPort = address.port;
            starting = undefined;

            console.log(`[Profiles] PAC policy is served on 127.0.0.1:${serverPort}`);

            resolve(serverPort);
        });
    });

    return starting;
}
