/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./cli";
import "./updater";
import "./ipc";
import "./userAssets";
import "./vesktopProtocol";

import { app, BrowserWindow, nativeTheme } from "electron";
import { normalizeDohUrl } from "shared/doh";

import { DATA_DIR } from "./constants";
import { createFirstLaunchTour } from "./firstLaunch";
import { createWindows, mainWin } from "./mainWindow";
import { registerMediaPermissionsHandler } from "./mediaPermissions";
import { registerScreenShareHandler } from "./screenShare";
import { Settings, State } from "./settings";
import { setAsDefaultProtocolClient } from "./utils/setAsDefaultProtocolClient";
import { isDeckGameMode } from "./utils/steamOS";

console.log("Dohcord v" + app.getVersion());

// Make the Vencord files use our DATA_DIR
process.env.VENCORD_USER_DATA_DIR = DATA_DIR;

const isLinux = process.platform === "linux";

export let enableHardwareAcceleration = true;

/** Subset of Electron's ConfigureHostResolverOptions that we manage */
interface HostResolverConfig {
    secureDnsMode: "off" | "automatic" | "secure";
    secureDnsServers?: string[];
}

/** Signature of the host resolver configuration currently applied to Chromium */
let appliedDohConfig: string | undefined;

function init() {
    setAsDefaultProtocolClient("discord");

    const { disableSmoothScroll, hardwareAcceleration, hardwareVideoAcceleration } = Settings.store;

    const enabledFeatures = new Set(app.commandLine.getSwitchValue("enable-features").split(","));
    const disabledFeatures = new Set(app.commandLine.getSwitchValue("disable-features").split(","));
    app.commandLine.removeSwitch("enable-features");
    app.commandLine.removeSwitch("disable-features");

    if (!hardwareAcceleration || process.argv.includes("--disable-gpu")) {
        enableHardwareAcceleration = false;
        app.disableHardwareAcceleration();
    } else {
        if (hardwareVideoAcceleration) {
            enabledFeatures.add("AcceleratedVideoEncoder");
            enabledFeatures.add("AcceleratedVideoDecoder");

            if (isLinux) {
                enabledFeatures.add("AcceleratedVideoDecodeLinuxGL");
                enabledFeatures.add("AcceleratedVideoDecodeLinuxZeroCopyGL");
            }
        }
    }

    if (disableSmoothScroll) {
        app.commandLine.appendSwitch("disable-smooth-scrolling");
    }

    // work around chrome 66 disabling autoplay by default
    app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

    // Prevent Discord from registering as a media service.
    disabledFeatures.add("HardwareMediaKeyHandling");
    disabledFeatures.add("MediaSessionService");

    if (isLinux) {
        // This is needed to fix washed out colours - https://github.com/electron/electron/issues/49566
        // Supposed to be fixed already according to comments there, but it's just not lol, I can repro on Electron 43.0.0
        // when moving the window from my main monitor (HDR - not sure if this is relevant lol) to second monitor (SDR) and back
        disabledFeatures.add("WaylandWpColorManagerV1");
    }

    disabledFeatures.forEach(feat => enabledFeatures.delete(feat));

    const enabledFeaturesArray = [...enabledFeatures].filter(Boolean);
    const disabledFeaturesArray = [...disabledFeatures].filter(Boolean);

    if (enabledFeaturesArray.length) {
        app.commandLine.appendSwitch("enable-features", enabledFeaturesArray.join(","));
        console.log("Enabled Chromium features:", enabledFeaturesArray.join(", "));
    }

    if (disabledFeaturesArray.length) {
        app.commandLine.appendSwitch("disable-features", disabledFeaturesArray.join(","));
        console.log("Disabled Chromium features:", disabledFeaturesArray.join(", "));
    }

    // In the Flatpak on SteamOS the theme is detected as light, but SteamOS only has a dark mode, so we just override it
    if (isDeckGameMode) nativeTheme.themeSource = "dark";

    app.on("second-instance", (_event, _cmdLine, _cwd, data: any) => {
        if (data.IS_DEV) app.quit();
        else if (mainWin) {
            if (mainWin.isMinimized()) mainWin.restore();
            if (!mainWin.isVisible()) mainWin.show();
            mainWin.focus();
        }
    });

    app.whenReady().then(async () => {
        if (process.platform === "win32") app.setAppUserModelId("dev.newipe.dohcord");

        registerScreenShareHandler();
        registerMediaPermissionsHandler();

        applyDohSettings();

        bootstrap();

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindows();
        });
    });
}

if (!app.requestSingleInstanceLock({ IS_DEV })) {
    if (IS_DEV) {
        console.log("Dohcord is already running. Quitting previous instance...");
        init();
    } else {
        console.log("Dohcord is already running. Quitting...");
        app.quit();
    }
} else {
    init();
}

async function bootstrap() {
    if (!Object.hasOwn(State.store, "firstLaunch")) {
        createFirstLaunchTour();
    } else {
        createWindows();
    }
}

// MacOS only event
export let darwinURL: string | undefined;
app.on("open-url", (_, url) => {
    darwinURL = url;
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

// Sets the WebRTC IP handling policy for all current and future windows.
// Switching to "default_public_and_private_interfaces" may fix calls stuck at "DTLS Connecting" when using VPNs, Tailscale, etc.
// https://github.com/Vencord/Vesktop/issues/876
app.on("web-contents-created", (_event, contents) => {
    contents.setWebRTCIPHandlingPolicy(Settings.store.webRTCIPHandlingPolicy ?? "default");
});
Settings.addChangeListener("webRTCIPHandlingPolicy", () => {
    for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.setWebRTCIPHandlingPolicy(Settings.store.webRTCIPHandlingPolicy ?? "default");
    }
});

function applyDohSettings() {
    if (!app.isReady()) return;

    const { enableDoh, dohUrl, dohAllowFallback } = Settings.store;
    const url = enableDoh ? normalizeDohUrl(dohUrl) : undefined;

    if (enableDoh && !url) {
        console.warn("[DoH] Ignoring unusable resolver URL:", dohUrl);
    }

    // Without a usable resolver we leave Chromium on its default: DoH when the
    // system resolver supports it, plain DNS otherwise.
    const config: HostResolverConfig = url
        ? {
              secureDnsMode: dohAllowFallback ? "automatic" : "secure",
              secureDnsServers: [url]
          }
        : { secureDnsMode: "automatic" };

    // Configuring the host resolver resets Chromium's host cache, and `enableDoh`
    // and `dohUrl` change together whenever the user enables DoH, so only apply
    // the configuration when it actually differs from the active one.
    const signature = JSON.stringify(config);
    if (signature === appliedDohConfig) return;

    appliedDohConfig = signature;
    app.configureHostResolver(config);

    if (url) {
        console.log(`[DoH] Encrypting DNS via ${url} (secureDnsMode: ${config.secureDnsMode})`);
    } else if (enableDoh) {
        console.warn("[DoH] No usable resolver configured, using system DNS");
    }
}

Settings.addChangeListener("enableDoh", applyDohSettings);
Settings.addChangeListener("dohUrl", applyDohSettings);
Settings.addChangeListener("dohAllowFallback", applyDohSettings);
