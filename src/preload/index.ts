/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { contextBridge, ipcRenderer, webFrame } from "electron/renderer";

import { IpcEvents } from "../shared/IpcEvents";
import { VesktopNative } from "./VesktopNative";

const DISCORD_HOSTNAMES = ["discord.com", "canary.discord.com", "ptb.discord.com"];

/**
 * Wraps Discord's real RTCPeerConnection so voice and video connections can use the
 * relay of the selected DoH provider. It runs in the page's main world from the
 * preload, which is the earliest point that can still intercept Discord's scripts.
 */
function initRtcRelay() {
    const { protocol, hostname } = window.location;
    if (protocol !== "https:" || !DISCORD_HOSTNAMES.includes(hostname)) return;

    try {
        const source = ipcRenderer.sendSync(IpcEvents.GET_RTC_RELAY_SCRIPT);
        const snapshot = ipcRenderer.sendSync(IpcEvents.RTC_RELAY_SNAPSHOT);

        webFrame
            .executeJavaScript(`${source}\n;window.__dohcordRtcRelay?.update(${JSON.stringify(snapshot)});`)
            .catch(err => console.error("Failed to install the RTC relay integration", err));
    } catch (err) {
        console.error("Failed to install the RTC relay integration", err);
    }

    ipcRenderer.on(IpcEvents.RTC_RELAY_UPDATE, (_event, snapshot) => {
        webFrame.executeJavaScript(`window.__dohcordRtcRelay?.update(${JSON.stringify(snapshot)});`).catch(() => {});
    });
}

initRtcRelay();

contextBridge.exposeInMainWorld("VesktopNative", VesktopNative);

// While sandboxed, Electron "polyfills" these APIs as local variables.
// We have to pass them as arguments as they are not global
Function("require", "process", ipcRenderer.sendSync(IpcEvents.GET_VENCORD_PRELOAD_SCRIPT))(require, process);

webFrame.executeJavaScript(ipcRenderer.sendSync(IpcEvents.GET_VENCORD_RENDERER_SCRIPT));
webFrame.executeJavaScript(ipcRenderer.sendSync(IpcEvents.GET_VESKTOP_RENDERER_SCRIPT));
