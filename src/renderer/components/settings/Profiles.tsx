/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./Profiles.css";
import { classNameFactory } from "@vencord/types/api/Styles";
import { Button, Card, Divider, Heading, Paragraph, Text } from "@vencord/types/components";
import { Select, TextInput, useEffect, useState } from "@vencord/types/webpack/common";

import { DIRECT_PROFILE_VALUE, type ConnectionProfile, type ProfileStatus } from "../../../shared/profiles";
import { RTC_RELAY_STATUS_EVENT, type RtcRelayStatus } from "../../../shared/rtcRelay";
import { SimpleErrorBoundary } from "../SimpleErrorBoundary";
import { SettingsComponent } from "./Settings";

const cl = classNameFactory("vcd-profiles-");

type StatusTone = "ok" | "warn" | "error" | "off";

const STATUS_LABEL: Record<ProfileStatus["state"], string> = {
    direct: "Direct",
    connecting: "Connecting",
    connected: "Connected",
    unavailable: "Unavailable",
    invalid: "Invalid config",
    expired: "Expired"
};

const STATUS_TONE: Record<ProfileStatus["state"], StatusTone> = {
    direct: "off",
    connecting: "warn",
    connected: "ok",
    unavailable: "error",
    invalid: "error",
    expired: "warn"
};

export const Profiles: SettingsComponent = ({ settings }) => {
    const [initial] = useState(() => VesktopNative.profiles.list());
    const [profiles, setProfiles] = useState<ConnectionProfile[]>(initial.profiles);
    const [status, setStatus] = useState<ProfileStatus>(initial.status);
    const [rtcStatus, setRtcStatus] = useState<RtcRelayStatus | undefined>(() => window.__dohcordRtcRelay?.getStatus());

    const [managing, setManaging] = useState(false);
    const [editing, setEditing] = useState<string | undefined>();
    const [name, setName] = useState("");
    const [networkConfigUrl, setNetworkConfigUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [removing, setRemoving] = useState<string | undefined>();

    useEffect(() => {
        const off = VesktopNative.profiles.onStatus(next => {
            setStatus(next);
            setProfiles(VesktopNative.profiles.list().profiles);
        });

        const onRelayStatus = (event: Event) => setRtcStatus((event as CustomEvent<RtcRelayStatus>).detail);
        window.addEventListener(RTC_RELAY_STATUS_EVENT, onRelayStatus);

        return () => {
            off();
            window.removeEventListener(RTC_RELAY_STATUS_EVENT, onRelayStatus);
        };
    }, []);

    const selectedId = settings.profileId ?? DIRECT_PROFILE_VALUE;
    const selectedProfile = profiles.find(profile => profile.id === settings.profileId);
    const customProfiles = profiles.filter(profile => profile.type === "custom");

    const tone = STATUS_TONE[status.state];
    const hint =
        status.message ??
        (status.state === "direct"
            ? "Discord connects like a normal client; no traffic is routed through a relay."
            : "Retrieving the profile configuration…");

    const selectProfile = (value: string) => {
        setError(undefined);
        settings.profileId = value === DIRECT_PROFILE_VALUE ? undefined : value;
    };

    const startAdd = () => {
        setEditing("new");
        setName("");
        setNetworkConfigUrl("");
        setError(undefined);
    };

    const startEdit = (profile: ConnectionProfile) => {
        setEditing(profile.id);
        setName(profile.name);
        setNetworkConfigUrl(profile.networkConfigUrl);
        setError(undefined);
    };

    const resetForm = () => {
        setEditing(undefined);
        setName("");
        setNetworkConfigUrl("");
        setError(undefined);
    };

    const save = async () => {
        setBusy(true);
        setError(undefined);

        try {
            const result = await VesktopNative.profiles.save({
                id: editing === "new" ? undefined : editing,
                name,
                networkConfigUrl
            });

            if (!result.ok) {
                setError(result.error ?? "The profile could not be saved");
                return;
            }

            if (result.profiles) setProfiles(result.profiles);
            resetForm();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (profile: ConnectionProfile) => {
        setBusy(true);
        setError(undefined);

        try {
            const result = await VesktopNative.profiles.remove(profile.id);

            if (!result.ok) {
                setError(result.error ?? "The profile could not be removed");
                return;
            }

            if (result.profiles) setProfiles(result.profiles);
            // Keep the renderer's settings in step with the main process, which also
            // clears the selection when the removed profile was the active one
            if (settings.profileId === profile.id) settings.profileId = undefined;
            setRemoving(undefined);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const retry = () => {
        setError(undefined);
        void VesktopNative.profiles.retry();
    };

    return (
        <SimpleErrorBoundary>
            <Card defaultPadding className={cl("card")}>
                <div className={cl("header")}>
                    <Heading tag="h5">Connection Profile</Heading>
                    <Text
                        tag="span"
                        size="xs"
                        weight="semibold"
                        defaultColor={false}
                        className={cl("pill", `pill-${tone}`)}
                    >
                        {STATUS_LABEL[status.state]}
                    </Text>
                </div>

                <Text tag="span" size="sm" defaultColor={false} className={cl("hint")}>
                    {hint}
                </Text>

                <RtcRelayStatusLine status={rtcStatus} />

                <div className={cl("field")}>
                    <Text tag="span" size="sm" weight="medium" defaultColor={false}>
                        Profile
                    </Text>

                    <Select
                        placeholder="No Profile — Direct Connection"
                        options={[
                            { label: "No Profile — Direct Connection", value: DIRECT_PROFILE_VALUE },
                            ...profiles.map(profile => ({ label: profile.name, value: profile.id }))
                        ]}
                        closeOnSelect
                        select={selectProfile}
                        isSelected={(value: string) => value === selectedId}
                        serialize={(value: string) => value}
                    />

                    {selectedProfile?.description && (
                        <Text tag="span" size="sm" defaultColor={false} className={cl("hint")}>
                            {selectedProfile.description}
                        </Text>
                    )}
                </div>

                <div className={cl("actions")}>
                    <Button variant="secondary" size="small" onClick={() => setManaging(value => !value)}>
                        {managing ? "Hide Profiles" : "Manage Profiles"}
                    </Button>

                    {status.state !== "direct" && status.state !== "connecting" && (
                        <Button variant="secondary" size="small" onClick={retry}>
                            Retry
                        </Button>
                    )}

                    {status.proxyHost && (
                        <Text tag="span" size="sm" defaultColor={false}>
                            Proxy: {status.proxyHost}
                        </Text>
                    )}
                </div>

                <Paragraph>
                    Switching profiles reconnects Discord's network connections so the new policy applies right away.
                    Your DNS over HTTPS provider is never changed.
                </Paragraph>

                {managing && (
                    <div className={cl("manage")}>
                        <Divider />

                        <Text tag="span" size="sm" weight="medium" defaultColor={false}>
                            {customProfiles.length ? "Custom profiles" : "No custom profiles yet"}
                        </Text>

                        {customProfiles.map(profile => (
                            <div key={profile.id} className={cl("row")}>
                                <div className={cl("rowText")}>
                                    <Text tag="span" size="sm" weight="medium" defaultColor={false}>
                                        {profile.name}
                                    </Text>
                                    <Text tag="span" size="xs" defaultColor={false} className={cl("hint")}>
                                        {profile.networkConfigUrl}
                                    </Text>
                                </div>

                                {removing === profile.id ? (
                                    <div className={cl("rowActions")}>
                                        <Button
                                            variant="dangerPrimary"
                                            size="small"
                                            disabled={busy}
                                            onClick={() => remove(profile)}
                                        >
                                            Confirm
                                        </Button>
                                        <Button variant="secondary" size="small" onClick={() => setRemoving(undefined)}>
                                            Cancel
                                        </Button>
                                    </div>
                                ) : (
                                    <div className={cl("rowActions")}>
                                        <Button
                                            variant="secondary"
                                            size="small"
                                            disabled={busy}
                                            onClick={() => startEdit(profile)}
                                        >
                                            Edit
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            size="small"
                                            disabled={busy}
                                            onClick={() => setRemoving(profile.id)}
                                        >
                                            Remove
                                        </Button>
                                    </div>
                                )}
                            </div>
                        ))}

                        {editing ? (
                            <div className={cl("form")}>
                                <Text tag="span" size="sm" weight="medium" defaultColor={false}>
                                    {editing === "new" ? "Add a custom profile" : "Edit profile"}
                                </Text>

                                <TextInput value={name} placeholder="Profile Name" onChange={setName} />
                                <TextInput
                                    value={networkConfigUrl}
                                    placeholder="https://relay.example.com:8443/network-config"
                                    onChange={setNetworkConfigUrl}
                                />

                                <Text tag="span" size="sm" defaultColor={false} className={cl("hint")}>
                                    Only the name and the Network Configuration URL are needed. The proxy, domains and
                                    TURN credentials come from that endpoint and are validated before the profile is
                                    saved.
                                </Text>

                                {error && (
                                    <Text tag="span" size="sm" defaultColor={false} className={cl("error")}>
                                        {error}
                                    </Text>
                                )}

                                <div className={cl("actions")}>
                                    <Button
                                        variant="primary"
                                        size="small"
                                        disabled={busy || !name.trim() || !networkConfigUrl.trim()}
                                        onClick={save}
                                    >
                                        {busy ? "Contacting the relay…" : "Save Profile"}
                                    </Button>
                                    <Button variant="secondary" size="small" disabled={busy} onClick={resetForm}>
                                        Cancel
                                    </Button>
                                </div>

                                <Paragraph>
                                    The built-in Newipe profile cannot be edited or removed. Removing a profile never
                                    changes your DNS over HTTPS settings.
                                </Paragraph>
                            </div>
                        ) : (
                            <Button variant="secondary" size="small" onClick={startAdd} disabled={busy}>
                                Add Custom Profile
                            </Button>
                        )}

                        {!editing && error && (
                            <Text tag="span" size="sm" defaultColor={false} className={cl("error")}>
                                {error}
                            </Text>
                        )}

                        <Text tag="span" size="xs" defaultColor={false} className={cl("hint")}>
                            Dohcord-relay is a separate server-side project. Copy the Network Configuration URL it
                            prints after setup.
                        </Text>
                    </div>
                )}
            </Card>
        </SimpleErrorBoundary>
    );
};

function RtcRelayStatusLine({ status }: { status: RtcRelayStatus | undefined }) {
    if (!status?.configured) return null;

    const { tone, text } = describeRtcRelay(status);

    return (
        <Text tag="span" size="sm" defaultColor={false} className={cl("relay", `relay-${tone}`)}>
            {text}
        </Text>
    );
}

function describeRtcRelay(status: RtcRelayStatus): { tone: StatusTone; text: string } {
    const host = status.relayHost ?? "the relay";

    switch (status.state) {
        case "relayed":
            return {
                tone: "ok",
                text: `Voice: relayed via ${host} (${status.candidateType ?? "relay"} candidate, ${
                    status.protocol ?? "udp"
                }) · ${formatBytes(status.bytesSent)} up / ${formatBytes(status.bytesReceived)} down${
                    status.rttMs !== undefined ? ` · ${status.rttMs} ms` : ""
                }`
            };
        case "fallback":
            return {
                tone: "warn",
                text: `Voice: direct fallback${status.reason ? ` — ${status.reason}` : ""}`
            };
        case "unavailable":
            return {
                tone: "error",
                text: `Voice relay unavailable — ${status.reason ?? "no credentials"} · using direct RTC`
            };
        default:
            return {
                tone: "warn",
                text: `Voice: connecting${status.reason ? ` — ${status.reason}` : "…"}`
            };
    }
}

function formatBytes(value: number | undefined): string {
    if (!value) return "0 B";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;

    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
