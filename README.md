# Aiden Agent

<p align="center">
  <img src="resources/app-icon.png" width="96" alt="Aiden Agent app icon">
</p>

<p align="center">
  A native-feeling macOS workspace for chatting with local or hosted AI models and safely working inside the folders you choose.
</p>

```sh
brew install --cask sambitcreate/tap/aiden-agent
```

![Aiden Agent showing a workspace chat and Personal Model Pad](docs/assets/aiden-agent-app.png)

## Why Aiden

I don't come from a coding background. I'd been bouncing between the coding agents that exist, and each one had a piece of what I wanted without any of them being the whole thing. I loved **Codex** for its restrained, lovely desktop UX, **Opencode** for letting me bring whatever model and provider I wanted and also looking great in both the terminal and desktop, and **Cursor** for its nimbleness and UI, and I used **Claude Code** for the models lol. But the one terminal agent kept coming back to was **Pi**, by **Mario Zechner**, for the plugin system I could shape to my own workflow. What **Pi** lacked was a GUI, and I wanted the extensibility with a real interface on top of it. The first version was a native **SwiftUI** app, but within two weeks it was clear that building a coding agent inside **SwiftUI** was the wrong fight for someone who doesn't already write code, so the project pivoted to **Electron**. I was playing around with **Glaze**, **Raycast**'s AI app maker. I figured, let me just recreate Aiden in Glaze, ran out of credits inside an hour, used **Codex** to grab the code out of Glaze, and a week later this is what happened. **Aiden** runs on the **Pi** agent runtime and gives it a Mac-native workspace.

## Features

- **Aiden Assistant** - press `⌘⌥A` to open a private assistant dock inside the main window. It follows the selected chat model, keeps its own local history and drafts, supports Stop, and can explain the app without receiving workspace tools or a hidden copy of the workspace.
- **Command palette and shortcuts** - `⌘K` searches commands, chats, models, providers, Settings, and appearance actions. One typed command system also powers native menus, visible shortcut labels, transactional global hotkeys, and the searchable Keyboard Shortcuts editor.
- **Native Subagents** - a foreground chat can delegate up to four fresh `scout`, `planner`, or `reviewer` tasks. Children are read/search-only, inherit the approved workspace and model, stop with the parent, and appear as live chips plus an inspectable **Subagents** view in Environment.
- **Workspaces and managed worktrees** - use folders, scratch workspaces, or isolated managed worktrees with three access levels, workspace-scoped tools, Ask-mode approvals, guarded creation/deletion, and crash-aware cleanup.
- **Models and the Model Pad** - choose from Pi's native hosted-provider catalog, local Ollama or LM Studio models, and declarative compatible endpoints. Provider-specific authentication, model capabilities, availability, and branded marks flow into the picker and Personal Model Pad.
- **Terminal, Git, and review** - keep a terminal drawer beside the conversation, inspect files and diffs in Environment, edit with dirty-file protection, compare branches, commit or push checked snapshots, and open the workspace in a discovered external editor.
- **macOS integration and appearance** - native menus, **Keychain**, **Parakeet**, the dictation pill, Apple **Foundation Models**, the signed **Rust** Computer Use broker, semantic themes, high contrast, reduced motion, and consistent light/dark rendering.
- **Extensibility and background work** - use skills, **MCP**, **Exa** search, scheduled tasks, voice, and attachments through typed, allowlisted boundaries.
- **Updates and release safety** - signed builds use the verified GitHub release feed. Once an update is downloaded, Aiden shows the version above Profile with **Later** and **Restart now**, then follows the normal save and shutdown guards before relaunching.

## Upcoming

The roadmap is maintained in [the plan index](docs/plans/README.md). These bullets name only the unfinished parts of partially shipped work or features with no runtime implementation yet; they are directions, not release promises:

- **Assistant tools and proactive nudges** - the private dock, shortcut, and Settings foundation ship today. The remaining work is approval-gated settings/status tools plus opt-in, rate-limited suggestions about useful app and workspace maintenance. See the [Aiden Assistant plan](docs/plans/aiden-assistant-plan.md).
- **Slash commands and explicit skill selection** - Aiden already discovers Agent Skills and lets the model load them as tools. The planned addition is a composer-anchored `/` palette, one authoritative registry for UI and runtime, and explicit turn-scoped skill activation chosen by the user. See the [Slash Commands and Skill Invocation plan](docs/plans/slash-commands-and-skill-invocation-plan.md).
- **Designer Mode** - no Designer Mode runtime exists yet. The proposed flow selects UI in a local Vite app, requests a bounded change, requires approval, and reviews the exact action diff; Phase 0 remains a go/no-go validation gate. See the [Designer Mode plan](docs/plans/designer-mode-plan.md).
- **Static-catalog overlays and provider completion** - Pi built-in discovery, encrypted credentials, provider-owned authentication, native streaming, stored dynamic catalogs, manual refresh, and voice credential lookup already ship. Remaining work includes remote overlays for otherwise-static hosted catalogs, Pi-native custom-endpoint composition, historical message provenance, scalable large-catalog recovery UX, and rollout cleanup. See the [Dynamic Model Catalog](docs/plans/dynamic-model-catalog-plan.md) and [Pi Provider Integration](docs/plans/pi-provider-integration-plan.md) plans.
- **Truthful generation progress notes** - no progress-note runtime exists yet. The plan would show one temporary acknowledgement after an otherwise-silent start, using an explicitly selected on-device or verified hosted route without exposing hidden reasoning. See the [Generation Progress Notes plan](docs/plans/generation-progress-notes-plan.md).
- **Long-session context and run control** - model-aware deterministic compaction already ships. Remaining work includes visible compaction activity, reconstructable structured checkpoints, durable-versus-working memory separation, queued follow-up messages, and safe mid-run redirects. See the [Compaction](docs/plans/compaction-plan.md) and [Taracodlab Learnings](docs/plans/taracodlab-learnings-plan.md) plans.
- **Whole-app performance, durability, and battery gates** - atomic/recoverable chat storage and several bounded lifecycles already ship. The broader program still needs production-equivalent baselines, recovery and hard bounds across the remaining stores and payloads, zero-idle Git/renderer scheduling, cancellable heavy helpers, and enforceable packaged release budgets. See the [Performance, Stability, Battery, and Efficiency plan](docs/plans/performance-stability-efficiency-plan.md).

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

The development launcher prepares a cached, ad-hoc-signed **Aiden Agent Dev** runtime that can run beside the installed **Aiden Agent** app. Development uses separate Application Support, Chromium session, log, crash, and `~/.aiden-dev` roots; it does not copy production data, register global shortcuts, or check the production update feed by default. Set `AIDEN_DEV_GLOBAL_SHORTCUTS=1` only when a development run intentionally needs the global bindings.

Native builds discover the newest compatible full Xcode without changing the machine-wide `xcode-select` setting; `DEVELOPER_DIR` remains available as a per-command override.

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

Distribution builds use `npm run dist` and require Developer ID signing plus notarization. The release pipeline fails closed, verifies the app, DMG, and ZIP, checks the deployed Homebrew and website consumers, and publishes updater metadata only with the matching verified artifacts. Read [macOS releases and automatic updates](docs/releasing.md) before enabling publication.

The checked-in models.dev snapshot is refreshed only through `npm run models:refresh` or the guarded distribution path. Artificial Analysis credentials and data are never bundled; users explicitly fetch suggestions into an encrypted, device-local cache.

## Project status

Aiden Agent is a beta macOS release. Signed DMG and ZIP builds, checksums, and automatic-update metadata are published through [GitHub Releases](https://github.com/sambitcreate/aiden-agent/releases). The release workflow is fail-closed: it verifies signing, notarization, package contents, updater metadata, and version monotonicity before publishing. See [the release guide](docs/releasing.md) for the complete process.

The project is MIT licensed (see [LICENSE](LICENSE)).
