/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

import { app } from "electron";
import { BrowserWindow } from "electron/main";
import { SplashProps } from "shared/browserWinProperties";
import { normalizeDohUrl } from "shared/doh";
import { DIRECT_PROFILE_VALUE } from "shared/profiles";

import { autoStart } from "./autoStart";
import { DATA_DIR } from "./constants";
import { createWindows } from "./mainWindow";
import {
    applySelectedProfile,
    checkProfileConfig,
    findProfile,
    getProfiles,
    getProfileStatus,
    primeProfileConfig
} from "./profiles";
import { Settings, State } from "./settings";
import { makeLinksOpenExternally } from "./utils/makeLinksOpenExternally";
import { loadView } from "./vesktopStatic";

interface Data {
    minimizeToTray?: "on";
    autoStart?: "on";
    importSettings?: "on";
    richPresence?: "on";
    enableDoh?: "on";
    dohUrl?: string;
    profileId?: string;
}

export function createFirstLaunchTour() {
    const win = new BrowserWindow({
        ...SplashProps,
        transparent: false,
        frame: true,
        autoHideMenuBar: true,
        height: 620,
        width: 620
    });

    makeLinksOpenExternally(win);

    let submitting = false;

    function runInPage(code: string) {
        if (win.isDestroyed()) return;

        win.webContents.executeJavaScript(code).catch(() => {});
    }

    function showProfileError(message: string) {
        runInPage(`window.__dohcordProfileError?.(${JSON.stringify(message)})`);
    }

    async function finishSetup(data: Data) {
        if (submitting) return;
        submitting = true;

        const requestedProfile =
            typeof data.profileId === "string" && data.profileId !== DIRECT_PROFILE_VALUE ? data.profileId : undefined;

        if (requestedProfile) {
            const profile = findProfile(requestedProfile);

            if (!profile) {
                showProfileError("That profile is no longer available. Choose another profile or Direct Connection.");
                submitting = false;
                return;
            }

            runInPage(`window.__dohcordProfileState?.("Retrieving the profile configuration…")`);

            // A profile is only accepted once its server configuration was fetched
            // and validated by the same code that applies it
            const result = await checkProfileConfig(profile);

            if (!result.ok) {
                showProfileError(result.error);
                submitting = false;
                return;
            }

            primeProfileConfig(profile.id, result.config);
            Settings.store.profileId = profile.id;
            await applySelectedProfile();

            const status = getProfileStatus();
            if (status.state !== "connected") {
                showProfileError(
                    status.message ?? "The profile could not be activated. Try again or use Direct Connection."
                );
                submitting = false;
                return;
            }
        } else {
            Settings.store.profileId = undefined;
            await applySelectedProfile();
        }

        State.store.firstLaunch = false;
        Settings.store.minimizeToTray = !!data.minimizeToTray;
        Settings.store.arRPC = !!data.richPresence;

        if (data.enableDoh === "on") {
            Settings.store.enableDoh = true;
            // Unusable URLs are dropped rather than applied, the setup window
            // validates custom ones but the remote provider list is not trusted
            Settings.store.dohUrl = normalizeDohUrl(data.dohUrl);
        } else {
            Settings.store.enableDoh = false;
            Settings.store.dohUrl = undefined;
        }

        if (data.autoStart) autoStart.enable();

        if (data.importSettings) {
            const from = join(app.getPath("userData"), "..", "Vencord", "settings");
            const to = join(DATA_DIR, "settings");
            try {
                const files = readdirSync(from);
                mkdirSync(to, { recursive: true });

                for (const file of files) {
                    copyFileSync(join(from, file), join(to, file));
                }
            } catch (e) {
                if (e instanceof Error && "code" in e && e.code === "ENOENT") {
                    console.log("No Vencord settings found to import.");
                } else {
                    console.error("Failed to import Vencord settings:", e);
                }
            }
        }

        win.close();

        createWindows();
    }

    loadView(win, "first-launch.html");

    win.webContents.addListener("console-message", (_e, _l, msg) => {
        if (msg === "cancel") return app.exit();

        if (msg === "profiles:init") {
            const profiles = getProfiles().map(({ id, name, description }) => ({ id, name, description }));
            runInPage(`window.__dohcordProfiles?.(${JSON.stringify(profiles)})`);
            return;
        }

        if (!msg.startsWith("form:")) return;

        let data: Data;
        try {
            data = JSON.parse(msg.slice(5)) as Data;
        } catch {
            showProfileError("The setup form could not be read. Please try again.");
            return;
        }

        void finishSetup(data);
    });
}
