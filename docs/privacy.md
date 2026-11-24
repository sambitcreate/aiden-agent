# Privacy and trust

Aiden Agent is built around explicit local ownership, OS-backed credential isolation, and narrow permission boundaries.

## Local configuration and storage

- **Portable configuration permissions** — On macOS and Linux, portable configuration uses an owned private directory (`0700`) and config and migration/recovery files use `0600`. `~/.aiden` may itself be a symlink to a folder you own (such as a dotfile-manager target), and that folder is made private; other symlinks, foreign ownership, and linked config files block access rather than replacing data. A dedicated `AIDEN_CONFIG_DIR` may override `~/.aiden` (do not point it at `$HOME` or a shared directory).
- **Local data** — Aiden stores chats, settings, workspace metadata, and downloaded speech models locally. Each picture in a chat is stored once beside the chats (chats showing the same picture share it); after a chat is deleted or cleared, unreferenced pictures unused for a day are removed.
- **Encrypted credentials** — On the desktop app, provider credentials, MCP OAuth sessions, and custom MCP environment/header values use the operating system's encrypted credential storage (on Linux, Aiden refuses to store secrets if only Electron's reversible `basic_text` backend is available, and Bot authority specifically requires an unlocked Secret Service provider). The headless CLI (`packages/cli`) encrypts `auth.json` and `credentials/insights.json` (MCP sign-ins and the Telegram token) with AES-256-GCM using an owner-private wrapping key (`0600`), and Antigravity ACP tokens / Bot VM guest SSH keys (`0600`) live in private profile directories.
- **Sealed pending connectors** — Pending local connectors are sealed before launch approval; copying portable config copies only their markers. In Settings, **Review and approve** opens an explicit review of the exact command, arguments, and saved environment overrides, then rechecks the effective launch before granting consent.
- **Renderer isolation** — The Electron renderer is sandboxed, has no direct Node.js access, and communicates with the main process only through an allowlisted context bridge.

## Network boundaries

Apart from release update checks and the anonymous usage data described below, network access happens only when a feature you enabled needs it:

- **Hosted models** receive the conversation content sent to them.
- **Cloud transcription** receives selected audio when used.
- **Web Search & page fetch** send search queries to the configured search provider, plain page requests to public URLs the agent reads (never to this computer or private networks), and page text plus field names to Cloudflare when opt-in extract mode is on.
- **Remote MCP servers** receive tool requests you allow.
- **Model downloads** (such as speech models or explicitly installed runtimes) contact their pinned upstream host.
- **Pull request follow-through** (`/follow`) reads PR state from GitHub every few minutes until the follow ends.

A fully local session can run with a local model (Ollama or LM Studio), on-device voice (Parakeet), no remote MCP servers, and web search disabled.

## Anonymous usage data and crash reports

Release builds of the desktop app send anonymous usage data to PostHog (`https://us.i.posthog.com`): app launches, daily use, setup, updates, feature usage, and sanitized crash reports, keyed by a random install ID — never chats, files, user paths, or keys (crash stack traces retain only app-bundle-relative `app:///…` paths).

It is on by default and can be turned off in **Settings → About → Usage data**, with `DO_NOT_TRACK=1`, or with `AIDEN_ANALYTICS=0` (on the headless server, setting `CI` also disables sending). You can inspect every event and field Aiden can send under **What's sent** in Settings and in [Usage data and crash reports](analytics.md). Development builds and headless servers built from a clone never send; distributed server builds have their own switch (`aiden telemetry off`).

## macOS Computer Use

On macOS, Computer Use is an opt-in beta with a global switch, permission checks, and exact target binding. The model's first Computer Use call in a chat raises an explicit access card (**Deny**, **Allow in this chat**, or **Always allow** from its menu), and Settings can revoke permissions at any time. Computer Use is omitted from Linux builds. See [Computer Use integration](computer-use-integration.md) for the complete boundary.
