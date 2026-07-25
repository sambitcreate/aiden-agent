# Aiden Agent

<p align="center">
  <img src="resources/app-icon.png" width="96" alt="Aiden Agent app icon">
</p>

<p align="center">
  A native-feeling macOS workspace for chatting with local or hosted AI models and safely working inside the folders you choose.
</p>

![Aiden Agent showing a workspace chat and Personal Model Pad](docs/assets/aiden-agent-app.png)

## Why Aiden

I don't come from a coding background. I'd been bouncing between the coding agents that exist, and each one had a piece of what I wanted without any of them being the whole thing. I loved **Codex** for its restrained, lovely desktop UX, **Opencode** for letting me bring whatever model and provider I wanted and also looking great in both the terminal and desktop, and **Cursor** for its nimbleness and UI, and I used **Claude Code** for the models lol. But the one terminal agent kept coming back to was **Pi**, by **Mario Zechner**, for the plugin system I could shape to my own workflow. What **Pi** lacked was a GUI, and I wanted the extensibility with a real interface on top of it. The first version was a native **SwiftUI** app, but within two weeks it was clear that building a coding agent inside **SwiftUI** was the wrong fight for someone who doesn't already write code, so the project pivoted to **Electron**. I was playing around with **Glaze**, **Raycast**'s AI app maker. I figured, let me just recreate Aiden in Glaze, ran out of credits inside an hour, used **Codex** to grab the code out of Glaze, and a week later this is what happened. **Aiden** runs on the **Pi** agent runtime and gives it a Mac-native workspace.

## Features

- **Workspaces** - folder/worktree/scratch, the three access levels, tool scoping, Ask-mode approvals, **Computer Use** safety, plus the sidebar/composer detail.
- **Models and the Model Pad** - the ~36 hosted providers, local options, and a proper explanation of the Model Pad as the distinctive idea.
- **Native Mac surface** - menus, shortcuts, **Keychain**, **Parakeet**, dictation pill, **Foundation Models**, the **Rust** broker, themes, reduced motion.
- **Terminal, Git, and review** - the terminal drawer, the environment panel's three modes, the dirty-file guard, external-editor discovery.
- **Extensibility** - skills, **MCP**, **Exa**, scheduled tasks, voice, attachments.

## Privacy and trust

Aiden stores chats, settings, workspace metadata, and downloaded speech models locally. Provider credentials and MCP OAuth sessions are encrypted with macOS secure storage. The renderer is sandboxed, has no direct Node.js access, and communicates with Electron through an allowlisted bridge.

Network access happens only when the selected feature needs it: hosted models receive the conversation content sent to them, cloud transcription receives selected audio, Exa receives search queries, remote MCP servers receive tool requests, and model downloads contact their upstream host. A fully local session can use a local model, on-device voice, no remote MCP servers, and web search disabled.

Computer Use is an opt-in beta with a global switch, a separate per-chat switch, macOS permission checks, exact target binding, and one-use approval for every mutation. See the [Computer Use security design](docs/computer-use-integration.md) for the complete boundary.

## Architecture

```text
React renderer
    │ allowlisted context bridge
    ▼
Electron preload
    │ typed IPC and notifications
    ▼
Electron main process
    ├── Pi agent and model adapters
    ├── workspace-scoped tools, Git, review, and terminal
    ├── encrypted credentials and local JSON stores
    ├── MCP, attachments, search, and voice
    └── signed native helpers for Apple models and Computer Use
```

Core technologies include Electron 43, React 19, TypeScript, Vite, Tailwind CSS, TanStack Router and Query, Radix UI, the Pi agent runtime, Swift, and Rust.

## Development

### Requirements

- macOS
- Node.js 22.19 or newer and npm
- Rust and Cargo
- A full Xcode 26 or newer for the Apple Foundation Models helper
- An Apple Development or Developer ID Application identity for packaged builds

### Run locally

```bash
npm install
npm run dev
```

The development launcher prepares a cached, ad-hoc-signed Aiden runtime so macOS displays **Aiden Agent** instead of Electron while preserving development-only paths and behavior. Native builds discover the newest compatible full Xcode without changing the machine-wide `xcode-select` setting; `DEVELOPER_DIR` remains available as a per-command override.

### Verify changes

```bash
npm test
npm run test:native
npm run type-check
npm run lint
npm run build
```

### Package the app

```bash
npm run package
npm run package:verify
```

Distribution builds use `npm run dist` and require Developer ID signing plus notarization. The release pipeline fails closed, verifies the app, DMG, and ZIP, and publishes updater metadata only with the matching verified artifacts. Read [macOS releases and automatic updates](docs/releasing.md) before enabling publication.

The checked-in models.dev snapshot is refreshed only through `npm run models:refresh` or the guarded distribution path. Artificial Analysis credentials and data are never bundled; users explicitly fetch suggestions into an encrypted, device-local cache.

## Project status

Aiden Agent is a beta macOS release, starting at version 0.27.0. Public binary distribution is prepared but remains disabled until the signing, notarization, release-repository, and protected-environment setup in [the release guide](docs/releasing.md) is complete.

The project is MIT licensed (see [LICENSE](LICENSE)).
