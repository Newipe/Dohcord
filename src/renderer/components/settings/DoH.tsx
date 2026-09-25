/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./DoH.css";

import { classNameFactory } from "@vencord/types/api/Styles";
import { BaseText, Button, Card, FormSwitch, Heading, Paragraph } from "@vencord/types/components";
import { Select, TextInput, useEffect, useState } from "@vencord/types/webpack/common";

import {
    DEFAULT_DOH_RESOLVERS,
    DOH_CUSTOM,
    DOH_OFF,
    type DohResolver,
    type DohTestResult,
    findDohResolver,
    getDohHost,
    getDohProviderValue,
    isValidDohUrl,
    normalizeDohUrl,
    parseDohResolvers,
    REMOTE_DOH_RESOLVERS_URL
} from "../../../shared/doh";
import { SimpleErrorBoundary } from "../SimpleErrorBoundary";
import { SettingsComponent } from "./Settings";

const cl = classNameFactory("vcd-doh-");

const FETCH_TIMEOUT_MS = 5000;

type StatusTone = "ok" | "warn" | "off";

const STATUS: Record<StatusTone, string> = {
    ok: "Encrypted",
    warn: "Incomplete",
    off: "Disabled"
};

export const DoH: SettingsComponent = ({ settings }) => {
    const [resolvers, setResolvers] = useState<DohResolver[]>(DEFAULT_DOH_RESOLVERS);
    const [draft, setDraft] = useState<string>();
    const [test, setTest] = useState<DohTestResult | "pending">();
    // Choosing Custom while a resolver is stored keeps that resolver applied until a new
    // URL is committed, so the selection cannot be derived from the settings alone
    const [customMode, setCustomMode] = useState(false);

    // The provider list lives in the repository so it can be updated without a release.
    // If it cannot be loaded, the built in list is used instead.
    useEffect(() => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        fetch(REMOTE_DOH_RESOLVERS_URL, { signal: controller.signal })
            .then(response => (response.ok ? response.json() : undefined))
            .then(value => {
                const remote = parseDohResolvers(value);
                if (remote) setResolvers(remote);
            })
            .catch(() => {})
            .finally(() => clearTimeout(timeout));

        return () => {
            clearTimeout(timeout);
            controller.abort();
        };
    }, []);

    const provider = customMode ? DOH_CUSTOM : getDohProviderValue(settings, resolvers);
    const isCustom = provider === DOH_CUSTOM;
    const enabled = provider !== DOH_OFF;

    const customUrl = isCustom ? (draft ?? settings.dohUrl ?? "") : "";
    const customUrlError = isCustom ? getUrlError(customUrl) : undefined;

    const tone: StatusTone = !enabled ? "off" : customUrlError ? "warn" : "ok";

    // The resolver the main process currently has applied, which is not necessarily
    // what the input shows while a custom URL is being typed
    const appliedResolver = enabled ? findDohResolver(resolvers, settings.dohUrl) : undefined;
    const appliedHost = appliedResolver ? undefined : getDohHost(settings.dohUrl);

    const hint = !enabled
        ? "Lookups use the system resolver, so your network can read, spoof or block them."
        : customUrlError
          ? "A custom URL is being edited — the resolver above stays active until it is valid."
          : `Lookups go to ${appliedResolver?.label ?? appliedHost}${
                appliedResolver?.description ? ` — ${appliedResolver.description}` : ""
            }`;

    const onProviderChange = (value: string) => {
        setTest(undefined);

        if (value === DOH_OFF) {
            setCustomMode(false);
            setDraft(undefined);
            settings.enableDoh = false;
            settings.dohUrl = undefined;
        } else if (value === DOH_CUSTOM) {
            setCustomMode(true);
            settings.enableDoh = true;
            // Seed the input with the current resolver so it can be edited rather than retyped
            setDraft(settings.dohUrl ?? "");
        } else {
            setCustomMode(false);
            setDraft(undefined);
            settings.enableDoh = true;
            settings.dohUrl = value;
        }
    };

    // Committing on blur instead of on every keystroke keeps half typed URLs from
    // reaching the main process, where they would be applied as the resolver.
    const commitCustomUrl = () => {
        if (!customUrl.trim()) {
            settings.dohUrl = undefined;
            return;
        }

        const normalized = normalizeDohUrl(customUrl);
        if (!normalized) return; // keep the invalid input around so it can be fixed

        settings.dohUrl = normalized;
        setDraft(undefined);
    };

    const runTest = async () => {
        setTest("pending");

        try {
            setTest(await VesktopNative.doh.resolveHost());
        } catch (err) {
            setTest({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    };

    return (
        <SimpleErrorBoundary>
            <Card defaultPadding className={cl("card")}>
                <div className={cl("header")}>
                    <Heading tag="h5">DNS over HTTPS</Heading>
                    <BaseText
                        tag="span"
                        size="xs"
                        weight="semibold"
                        defaultColor={false}
                        className={cl("pill", `pill-${tone}`)}
                    >
                        {STATUS[tone]}
                    </BaseText>
                </div>

                <BaseText tag="span" size="sm" defaultColor={false} className={cl("hint")}>
                    {hint}
                </BaseText>

                <div className={cl("field")}>
                    <BaseText tag="span" size="sm" weight="medium" defaultColor={false}>
                        Provider
                    </BaseText>

                    <Select
                        placeholder="Off (Disabled)"
                        options={[
                            { label: "Off (Disabled)", value: DOH_OFF },
                            ...resolvers.map(resolver => ({ label: resolver.label, value: resolver.url })),
                            { label: "Custom…", value: DOH_CUSTOM }
                        ]}
                        closeOnSelect
                        select={onProviderChange}
                        isSelected={(value: string) => value === provider}
                        serialize={(value: string) => value}
                    />

                    {isCustom && (
                        <>
                            <TextInput
                                value={customUrl}
                                placeholder="https://example.com/dns-query"
                                error={customUrlError}
                                onChange={setDraft}
                                onBlur={commitCustomUrl}
                                onKeyDown={event => {
                                    if (event.key === "Enter") commitCustomUrl();
                                }}
                            />
                            <BaseText
                                tag="span"
                                size="sm"
                                defaultColor={false}
                                className={cl("hint", customUrlError && "hint-error")}
                            >
                                {customUrlError ?? "Press Enter or click away to save."}
                            </BaseText>
                        </>
                    )}
                </div>

                <FormSwitch
                    title="Allow Insecure Fallback"
                    description="Use plain DNS when the DoH server cannot be reached. Disabling this guarantees encrypted lookups, but Dohcord will have no DNS at all while the resolver is down."
                    value={settings.dohAllowFallback}
                    onChange={value => (settings.dohAllowFallback = value)}
                    disabled={!enabled}
                    hideBorder
                    className={cl("switch")}
                />

                <div className={cl("actions")}>
                    <Button variant="secondary" size="small" onClick={runTest} disabled={test === "pending"}>
                        {test === "pending" ? "Testing…" : "Test Resolution"}
                    </Button>

                    {test !== undefined && test !== "pending" && (
                        <BaseText
                            tag="span"
                            size="sm"
                            defaultColor={false}
                            className={cl("result", test.ok && "result-ok")}
                        >
                            {formatTestResult(test, appliedResolver?.label ?? appliedHost)}
                        </BaseText>
                    )}
                </div>

                <Paragraph>
                    Changes apply to new connections immediately. Restart Dohcord to refresh connections that are
                    already open.
                </Paragraph>
            </Card>
        </SimpleErrorBoundary>
    );
};

function getUrlError(value: string): string | undefined {
    if (!value.trim()) return "Enter the URL of your DoH server";
    if (!isValidDohUrl(value)) return "Must be a valid https:// endpoint, for example https://example.com/dns-query";

    return undefined;
}

function formatTestResult(result: DohTestResult, resolver: string | undefined) {
    const via = resolver ? `via ${resolver}` : "via the system resolver";

    if (!result.ok) return `Lookup failed ${via}: ${result.error}`;

    return `discord.com ${via} → ${result.addresses!.join(", ")} in ${result.tookMs} ms`;
}
