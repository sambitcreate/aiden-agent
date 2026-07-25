# Aiden Agent

<p align="center">
  <img src="resources/app-icon.png" width="96" alt="Aiden Agent app icon">
</p>

<p align="center">
  A native-feeling macOS workspace for chatting with local or hosted AI models and safely working inside the folders you choose.
</p>

![Aiden Agent showing a workspace chat and Personal Model Pad](docs/assets/aiden-agent-app.png)

## Why Aiden

I don't come from a coding background. I'd been bouncing between the coding agents that exist, and each one had a piece of what I wanted without any of them being the whole thing. I loved **Codex** for its restrained, calm desktop UX, **opencode** for letting me bring whatever model and provider I wanted, and **Cursor** for its nimbleness and UI, and I used **Claude Code** for the models. But the one I kept coming back to was **Pi**, by **Mario Zechner**, for the plugin system I could shape to my own workflow. What **Pi** lacked was a GUI, and I wanted the extensibility with a real interface on top of it. The first version was a native **SwiftUI** app, but within two weeks it was clear that building a coding agent inside **SwiftUI** was the wrong fight for someone who doesn't already write code, so the project pivoted to **Electron**. The first beta followed about eight days after the first commit. Along the way I started by testing the limits of **Glaze**, **Raycast**'s AI coding agent, ran out of credits inside an hour, and used **Codex** to pull out the work we'd done and carry it into this app. **Aiden** runs on the **Pi** agent runtime and gives it a Mac-native workspace.

## Features

### Workspaces

A workspace is a folder you choose, an isolated git worktree, or a scratch space. Each one keeps its own chats, terminal sessions, and file and review panels. You pick one access level per workspace: Full, Ask, or No Access. The agent's file, search, edit, and command tools are scoped to that root and can't escape it through symlinks. Ask mode surfaces an approval card before any mutation, so a file edit or shell command waits for you to allow it once before it runs. **Computer Use** layers a second, one-use approval on top for every input action, with destructive key combinations blocked outright and typed text checked against shell-bootstrap and deletion payloads.

The sidebar groups chats into recent, yesterday, month, and older buckets, with fuzzy search and ⌘1 through ⌘9 to jump to the top nine. Chats can be renamed by hand or auto-titled with **Apple Foundation Models**. The composer carries a workspace context bar showing the folder, the local execution indicator, and the git branch, plus attachments, a per-workspace permission dropdown, a per-chat **Computer Use** toggle, and a reasoning-effort selector for models that support it.

### Models and the Model Pad

**Pi** ships around three dozen hosted providers out of the box, including **OpenAI**, **Anthropic**, **Google**, **DeepSeek**, **Moonshot**, and **ChatGPT** sign-in for **Codex**. **Aiden** adds **Ollama**, **LM Studio**, and any **OpenAI**-compatible endpoint, with native model discovery for the local ones.

The Model Pad is the part I'm proudest of. Instead of a dropdown, models live on a two-dimensional pad where you drag the ones you use onto a grid: more capable toward the top, faster toward the left, more deliberate toward the right. A snapping puck lets you pick a model by pointing, with full keyboard support and a crosshair over the active row and column. Personal placements always win. Optional **Artificial Analysis** benchmark data can suggest where unfamiliar models might sit, fetched on demand with your own key into an encrypted, device-local cache; the pad works fine without it.

### Native Mac surface

The native feel is real, not themed. There's a full macOS application menu, global shortcuts (⌘⌥Space to bring the app forward and focus the composer, ⌘⇧D for system-wide dictation, ⌘J for the terminal drawer, ⌘⇧E for the environment panel), and per-chat ⌘1 through ⌘9. Credentials live in the macOS **Keychain**. On-device transcription runs through **NVIDIA Parakeet** fully offline via sherpa-onnx, with cloud options from **OpenAI** and **Google Gemini** if you prefer, and a floating dictation pill that records, transcribes, and pastes into whatever app is focused. Chat titles come from **Apple Foundation Models** through a signed **Swift** helper. **Computer Use** runs through a pinned, hashed **Rust** broker that owns its own macOS permissions. Four theme presets (Aiden, Slate, Berry, Moss) cover light and dark, with custom JSON themes and reduced-motion support throughout.

### Terminal, Git, and review

A bottom terminal drawer (xterm.js, toggled with ⌘J) hosts workspace-attached sessions that can be split up to four panes. The environment panel on the right has three modes: an overview card showing working-tree status with line counts, a review tab with diff and branch-comparison modes, and a files tab with an in-app editor. The whole app blocks quitting or leaving the chat when a file is dirty or a save or git operation is in flight. A toolbar dropdown can open the workspace folder in **Cursor**, **VS Code**, **Zed**, **Nova**, **Android Studio**, or several others, discovered by macOS bundle id.

### Extensibility

Agent Skills load from `~/.agents`, `~/.claude`, and `~/.aiden`, and from the same folders inside a workspace; workspace skills override global ones on name clash, and each enabled skill becomes a tool the agent can call. **MCP** servers connect over stdio, HTTP, or SSE, with OAuth for the ones that need it and presets for common services. **Exa** powers web search when you want it. Scheduled tasks run agent turns on cron schedules with templates for daily briefs, weekly reviews, and follow-up monitors. Voice works with local or cloud providers, and attachments accept files and images, with images dropped automatically if a model isn't vision-capable.

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
