/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow } from "electron";
import { IpcEvents } from "shared/IpcEvents";
import type { RtcRelaySnapshot } from "shared/rtcRelay";

import { isDiscordUrl } from "./utils/isDiscordUrl";

/**
 * The relay snapshot is built from the selected connection profile by the profile
 * manager. It is kept here so the preload can synchronously seed the Discord page
 * before any of its scripts run.
 */
let snapshot: RtcRelaySnapshot = { enabled: false };
let signature = "";

export function getRtcRelaySnapshot(): RtcRelaySnapshot {
    return snapshot;
}

/** Hands the current profile's relay configuration to the Discord renderer */
export function publishRtcRelaySnapshot(next: RtcRelaySnapshot) {
    const nextSignature = JSON.stringify(next);
    if (nextSignature === signature) return;

    signature = nextSignature;
    snapshot = next;

    for (const win of BrowserWindow.getAllWindows()) {
        const contents = win.webContents;
        if (contents.isDestroyed() || !isDiscordUrl(contents.getURL())) continue;

        contents.send(IpcEvents.RTC_RELAY_UPDATE, next);
    }
}
