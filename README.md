<div align="center">


# Dohcord

**A fast, lightweight Discord client with [Vencord](https://vencord.dev) built in,
featuring native [DNS over HTTPS](https://en.wikipedia.org/wiki/DNS_over_HTTPS)
to bypass DNS-level censorship, prevent spoofing, and stay connected on
restricted networks.**

A fork of [Vesktop](https://github.com/Vencord/Vesktop) · Maintained by [Newipe](https://github.com/Newipe)

[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-5865F2?style=flat-square)](#installation)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-green?style=flat-square)](LICENSE)

</div>

---

## About

**Dohcord** is a custom Discord desktop app that is significantly lighter and
faster than the official client. It ships with [Vencord](https://vencord.dev)
preinstalled and offers native Wayland screen sharing with audio on Linux.

This fork extends Vesktop with **DNS over HTTPS (DoH)** built directly into the
app's network stack. Standard DNS sends every lookup as plaintext, so your ISP
— or anything else on the network — can see, block, or poison the results. DoH
encrypts those lookups inside an HTTPS tunnel, hiding them from the network and
defeating DNS-based blocking.

> [!NOTE]
> This repository is a fork of [Vesktop](https://github.com/Vencord/Vesktop).
> Credit for the base client goes to Vendicated and the Vencord contributors —
> this fork adds the DoH integration on top.

---

## How It Works

**Standard DNS — every lookup exposed:**

~~~text
   Dohcord
      │   plaintext DNS query
      ▼
System / ISP DNS
      │   blocked or spoofed IP
      ▼
Connection fails ✗
~~~

**With DoH — lookups encrypted end to end:**

~~~text
   Dohcord
      │   encrypted HTTPS request
      ▼
DoH resolver  (Cloudflare, Google, or your own)
      │   real Discord IP
      ▼
Connected ✓
~~~

|  | Standard DNS | DNS over HTTPS |
|---|:---:|:---:|
| Lookup visibility | Plaintext | Encrypted |
| DNS poisoning / hijacking | Trivial | Prevented |
| DNS-level blocking | Effective | Bypassed |

---

## Features

|  | Feature | Description |
|---|---|---|
| 🛡️ | **DNS over HTTPS** | Encrypted DNS queries — no ISP snooping, no DNS hijacking |
| 🌍 | **Custom DoH routing** | Point Dohcord at any DoH server, including SNI-proxy resolvers |
| 🧩 | **Vencord built in** | The full plugin, theme and tweak ecosystem out of the box |
| 🐧 | **Linux first-class** | Native Wayland, screen sharing with audio, better performance |
| ⚡ | **Lightweight** | No Discord bloat or telemetry — a snappier experience |

---

## SmartSNI & Restricted Networks

In heavily restricted networks (such as Iran), Discord is commonly blocked at
the DNS or SNI level. This fork is designed to work seamlessly with custom DoH
servers that provide **Smart DNS routing** and **SNI proxying**.

**Example custom DoH server:**

~~~text
https://newipe.qd.je/dns-query
~~~

> [!WARNING]
> This server is optimized for Iranian networks and routes traffic through an
> SNI proxy. It may not work outside of Iran.

**How the custom proxy works:**

1. Dohcord asks `newipe.qd.je` for Discord's IP over encrypted HTTPS.
2. The DoH server returns the IP of an **SNI proxy** instead of Discord's actual IP.
3. Dohcord connects to the SNI proxy, which reads the TLS SNI header and
   securely forwards the connection to Discord's real servers — bypassing
   local network filters.

---

## Installation

Prebuilt binaries are available on the **[Releases](../../releases)** page.

| Platform | Files |
|----------|-------|
| ⊞ Windows | [`.exe`, `.zip`](../../releases/latest) |
| 🍎 macOS | [`.dmg`, `.zip`](../../releases/latest) |
| 🐧 Linux | [`.AppImage`, `.deb`, `.rpm`](../../releases/latest) |

> [!TIP]
> **macOS:** this fork is unsigned. If macOS blocks it, right-click the app →
> **Open**, or allow it under *System Settings → Privacy & Security*.

---

## Enabling DoH

### Method 1 — In-app (recommended)

**On first launch** you'll see a setup screen — pick a DoH provider from the
dropdown (or choose **Custom**) and hit **Submit**.

**Any time after that:**

1. Open Dohcord and log in.
2. Click the **gear icon** (User Settings) in the bottom-left corner.
3. Scroll the left sidebar down to the **Dohcord** section.
4. Find **DNS over HTTPS (DoH)** and pick a provider — or **Custom** to paste
   your own DoH URL.
5. The setting saves automatically. Restart Dohcord so every network socket
   picks up the new resolver.

### Method 2 — Manual config (when Discord is fully blocked)

If Discord is blocked hard enough that you can't reach the settings menu, edit
the config file directly.

1. **Completely close Dohcord.**
2. Open `settings.json` for your platform:

   | Platform | Path |
   |----------|------|
   | Windows | `%appdata%\Dohcord\settings.json` |
   | Linux | `~/.config/Dohcord/settings.json` |
   | macOS | `~/Library/Application Support/Dohcord/settings.json` |

3. Add or modify these lines:

   ~~~json
   {
     "enableDoh": true,
     "dohUrl": "https://newipe.qd.je/dns-query"
   }
   ~~~

4. Save the file and launch Dohcord.

> [!NOTE]
> The predefined provider list is loaded from [`resolvers.json`](resolvers.json)p
> at startup. If the file can't be fetched, the built-in list is kept — so the
> provider list can be updated on GitHub without shipping a new Dohcord release.

---

## Recommended DoH Servers

Any RFC 8484–compliant DoH server works.

### Global providers — privacy & anti-spoofing

| Provider | URL |
|----------|-----|
| **Cloudflare** | `https://cloudflare-dns.com/dns-query` |
| **Google** | `https://dns.google/dns-query` |
| **Quad9** (malware blocking) | `https://dns.quad9.net/dns-query` |
| **OpenDNS** | `https://doh.opendns.com/dns-query` |

### Region-specific — censorship bypass

| Provider | URL | Notes |
|----------|-----|-------|
| **Newipe DoH** | `https://newipe.qd.je/dns-query` | Iran only — routes via SNI proxy |

---

## FAQ

**Does DoH encrypt my messages and calls?**
No. DoH only encrypts the initial DNS lookup (finding the IP). Your messages,
voice, and data are already encrypted by Discord's normal TLS connections.

**Does this guarantee access if Discord is blocked?**
It depends on *how* it's blocked. DNS poisoning and standard SNI filtering are
likely bypassed with DoH + SNI proxying. If your ISP blocks the DoH server or
the proxy's IP ranges entirely, DoH alone won't help.

**Can I use my own self-hosted DoH server?**
Yes — as long as it speaks standard DoH (`application/dns-message`), Dohcord
can use it.

**Why not just set DoH in my OS or router?**
Setting it in Dohcord means only Discord traffic uses the custom routing /
SNI proxy, while everything else on your machine keeps using normal DNS. It
also sidesteps OS-level restrictions that prevent changing DNS settings.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Discord won't load after enabling DoH | The DoH URL may be wrong or the server is down — clear it in settings or edit `settings.json` to disable. |
| "Invalid URL" error | The URL must start with `https://` and include the query path (usually `/dns-query`). |
| Stuck on "Connecting…" | The DoH server may be returning an IP your ISP blocks at the IP level — try another provider. |
| macOS "App is damaged" | Standard Gatekeeper warning for unsigned apps. Right-click → **Open**, or run `xattr -cr /Applications/Dohcord.app`. |

---

## Building from Source

You'll need [Git](https://git-scm.com), [Node.js](https://nodejs.org) and
[pnpm](https://pnpm.io) (`npm install --global pnpm`).

~~~sh
git clone https://github.com/Newipe/Dohcord
cd Dohcord

pnpm i          # install dependencies

pnpm start      # run without packaging

pnpm package                     # build installers for your OS into dist/
pnpm package --linux pacman      # build only the Linux pacman package
pnpm package:dir                 # package to a directory only
~~~

> [!NOTE]
> On Linux, Vesktop uses a small C++ helper library (**LibVesktop**) to emit
> D-Bus events. Prebuilt binaries are used by default; build it from source
> with `pnpm buildLibVesktop` if you have the required C++ toolchain.

---

## Credits

- **[Vesktop](https://github.com/Vencord/Vesktop)** — the base client and its
  Linux optimizations, by Vendicated & contributors
- **[Vencord](https://vencord.dev)** — the Discord client mod powering it all
- **[Newipe](https://github.com/Newipe)** — this fork: the DoH integration and
  the custom SNI-proxy DoH resolver (`https://newipe.qd.je/dns-query`)

Not affiliated with or endorsed by Discord Inc.

---

## License

GPL-3.0-or-later, inherited from upstream Vesktop. See the [LICENSE](LICENSE)
file for details.