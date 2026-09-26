# Aiden CLI — pi-based headless Aiden Agent

Build `aiden`, a standalone CLI/TUI inside this repo (`packages/cli/`) that runs the Aiden feature set on any machine — including headless Linux servers — on top of the pi coding agent (`@earendil-works/pi-coding-agent`, MIT, pinned to the same 0.84.4 line as the desktop app's `pi-agent-core`/`pi-ai`).

The TUI is pi's own interactive TUI customized with Aiden themes and (later) extension UI; headless use rides pi's print/JSON/RPC modes. Interop with Aiden Desktop is phased in later (shared stores/formats, then live coordination).

## Architecture decisions

- **Rebrand by bundling.** pi's `src/config.ts` walks up from the running code to the nearest `package.json` and reads its `piConfig`. The build therefore bundles pi's code into `packages/cli/dist/app/cli.js` with a generated `dist/app/package.json` carrying `piConfig: { name: "aiden", configDir: ".aiden" }`. That one fact rebrands the banner, usage, env override (`AIDEN_CODING_AGENT_DIR`), global state root (`~/.aiden/agent/`), and project resource dir (`.aiden/`).
- **Self-contained app root.** `dist/app/` also vendors pi's built-in assets at the paths pi resolves relative to its package dir (`src/modes/interactive/theme`, `src/modes/interactive/assets`, `src/core/export-html`, `docs`) plus our theme presets in `themes/`. The bundle externals (`@earendil-works/chord`, `@silvia-odwyer/photon-node`, `jiti`, optional native accelerators) resolve from `packages/cli/node_modules` at runtime.
- **Separate lockfile, not a workspace.** The root package is the Electron app; hoisting a CLI workspace into it would disturb electron-builder, vite, and `patch-pi-oauth-branding.mjs`. `packages/cli` keeps its own `package.json`/lockfile; root delegates via `cli:install`, `cli:build`, `test:cli` (wired into the root `test` chain so CI covers it).
- **Themes generated, never hand-written.** `scripts/generate-themes.ts` imports `renderer/shared/appearance.ts` and emits pi-format theme JSONs with the desktop's exact contrast-corrected math. Aiden dark/light replace pi's built-in `dark`/`light` (so terminal background auto-detection lands on Aiden); slate/berry/moss × light/dark plus pi's originals (`pi-dark`/`pi-light`) ship beside the bundle and are registered by the entry through the public `--theme <path>` flag. A fidelity test regenerates and deep-compares to prevent drift.
- **Version check off.** The entry sets `PI_SKIP_VERSION_CHECK=1` (overridable) because Aiden CLI's version numbers are unrelated to pi.dev's feed.
- **`~/.aiden` namespace.** The desktop already treats `~/.aiden` as its portable config home (`config.json`, `skills/`, `scripts/`). The CLI adds only the `~/.aiden/agent/` subtree — no collisions today; Phase 3 aligns skills folders across both.

## Phases

### Phase 0 — Rebranded pi CLI foundation (this change)

- `packages/cli` package: `piConfig` rebrand, esbuild bundle (ported from pi's own bundle script: same externals, lazy jiti rewrite, standalone OAuth/Bedrock/image-worker emissions), generated app-root `package.json`.
- `src/cli.ts` entry calling pi's `main()` with theme injection; `--version`/`--help`/print/JSON/RPC all branded `aiden`.
- Eight Aiden theme presets (4 presets × light/dark) + preserved pi originals.
- Tests: bundle structure, rebrand identity (version/help/env-dir isolation), print-mode offline semantics, RPC `get_state` handshake, theme generation fidelity, var-reference integrity. Root scripts `cli:install`/`cli:build`/`test:cli` and CI coverage via the `test` chain.
- Docs: this plan, `packages/cli/README.md`, plans index row, AGENTS.md conventions.

### Phase 1 — Signature Aiden extensions

Feature-level parity against the desktop is tracked item-by-item in the
[parity checklist](aiden-cli-parity-checklist.md); new port candidates should be checked against
it first.

Status: **core set shipped.** The `pi-bridge` (`src/pi-bridge/adapt-aiden-extension.ts`) translates Aiden's `PiAgentRuntimeExtension` shape into pi inline extension factories passed to `main()` — tools register as-is (execute signatures are structurally compatible) and `systemPrompt` chains onto `before_agent_start`. Ported by importing the pure cores from `main/services/` (identical backend semantics to the desktop):

- ask-user-question (tool + sequential TUI selects, multi-select accumulation; works over the RPC extension-UI sub-protocol for GUI clients)
- todo (journal-replayed tool + above-editor widget refreshed on `tool_execution_end`)
- memory (recall/remember over the desktop's SQLite store, per-workspace hashed scope, `memoryEnabled` setting)
- web-search (Aiden's `WebSearchService` router; anonymous Exa default, env-keyed providers)
- display-image (inline TUI images via wrapped tool result + `<agentDir>/artifacts` archive)
- `/usage`, `/voice`, `/dictate` (voice transcription settings persist to `aiden.json` in the desktop's `AppSettings` shapes; dictation uses `sox`/`ffmpeg` + Gemini/OpenAI REST; Parakeet stays desktop-only)

All animation colors derive from the ACTIVE theme accent (parsed from `theme.fg`'s ANSI prefix — truecolor when available, flat accent/muted fallbacks otherwise), so they follow the user's palette. pi's own palettes are removed from the bundle; the eight Aiden presets are the only themes.

Also in Phase 0/1: branding patch (`scripts/patch-branding.mjs`, run inside every build) removes pi's startup self-promotion line, de-Pi's the tmux hint, and makes the system prompt identify as Aiden — asserted by tests. The fullscreen TUI is the Aiden default (flag/saved-preference override respected), and startup is minimal: the loaded-resources listing (Context/Skills/Themes/Extensions) defaults off via `quietStartup`, surfacing on load errors, `--verbose`, or a `/config` override. **pi telemetry is removed**: the entry forces `PI_TELEMETRY=0` (unconditional — it gates both the pi.dev report-install ping and pi's attribution headers and overrides settings), the `enableInstallTelemetry` settings default flips to off, and the build patches the ping's call sites and endpoint out of the bundle; all three layers are test-enforced.

**Advisor and btw shipped.** Both run on the shared `pi-bridge/model-runtime.ts` adapter, which resolves Aiden's `ResolvedModelRuntime` through pi's extension `ModelRegistry` (`getModel` + `getApiKeyAndHeaders` + a fresh pi-ai `createModels` collection). Advisor vendors `AdvisorRuntime` byte-identically (`src/vendor/advisor/`, drift-tested) because esbuild fails to remap that file's sibling `.js` import inside the CLI graph; the desktop builds one runtime per response and the CLI preserves once-per-response semantics by refreshing the consultation at each `before_agent_start` behind one delegating tool. btw reuses the desktop's pure context builder (`boundedContextMessages`/`buildBtwContext`) as a `/btw` command with ephemeral session-scoped follow-up history. Advisor usage ledger recorders are device-local no-ops for now (session-journal usage remains via the engine).

### Phase 2 — Providers and model parity

- Custom providers via `registerProvider` reusing `provider-registry` cores (LM Studio, Ollama, OpenAI-compatible, Concentrate); thinking-level mapping.
- Catalogs: pi's native 4-hour refresh; models.dev / Artificial Analysis / OpenRouter insights as manual-only commands honoring the repo's network rules for those sources.
- Credentials for headless: env vars + `~/.aiden/agent/auth.json` + `aiden auth` (safeStorage is not portable; the desktop keychain stays desktop-only). Document device-code and paste-URL OAuth paths.
- First-run onboarding extension (provider setup + theme pick), concise per repo norms.

### Phase 3 — Desktop interop

- Same-machine sharing: memory SQLite, skills folders, catalog caches; align `~/.aiden` layout across desktop and CLI. **Memory is shared**: both surfaces open `~/.aiden/memory/memory-v1.sqlite` (`AIDEN_CONFIG_DIR`-aware; a non-default `AIDEN_CODING_AGENT_DIR` keeps an isolated `<agentDir>/shared-memory` sandbox). Workspace scopes use `ws-<sha256(canonical folder)>` on both sides. On first open the store absorbs legacy databases (desktop `userData/memory`, CLI `<agentDir>/memory`) and copies rows from workspace-UUID/`cli-` scopes into the shared scope — originals stay for downgrade compatibility, and a `busy_timeout` hardens cross-process writes. Bot scopes stay per-surface (bot ids differ across installs).
- Session interop: import Aiden desktop journals (PiSessionPort reader) into CLI sessions; evaluate a custom session repo backed by the journal port — fallback stays import/export.
- Concurrency guard so desktop and CLI never write one journal simultaneously (ownership lease/effect-store reuse).

### Phase 4 — Orchestration and workspace commands

- Subagents: port the child runner with `child_process` replacing Electron `UtilityProcess`; budgets, capability profiles, roster widget intact.
- `aiden serve` daemon hosting scheduled tasks, bots, and Telegram (all already headless-capable cores in `main/services/`).
- Generative-UI artifacts: write standalone HTML + `open`/URL (vendored Chart.js/Plotly/KaTeX from the desktop pipeline).
- `/git` and `/files` review commands; managed worktrees.

### Phase 5 — Headless authority and remote

- `aiden serve --remote` embedding the aiden-remote REST+SSE server (pairing, TLS identity, Tailscale route) so iOS/Android clients pair directly with the headless box.
- RPC daemon mode; containerization guide (Docker, sandbox extension); optional compiled binaries (Bun `--compile`, following pi's `src/bun/cli.ts` precedent).

### Phase 6 — Pairing, notifications, and distribution

- **QR-code remote pairing — done.** `aiden remote pair lan|tailscale` renders the existing `qrPayload` as a scannable terminal QR plus the manual code, endpoint, and verification fingerprint; `remote pair-status` and `remote pair-cancel <session-id>` manage the daemon-owned pairing window.
- **Daemon lifecycle — done.** `aiden serve --daemon [--remote]` spawns a detached daemon logging to `<agentDir>/serve.log`; `aiden serve status`/`aiden serve stop` report and stop it via the serve lease's owner PID, and stale locks/sockets are recovered only when the recorded PID is verifiably dead.
- **Scheduled-run notifications — done.** `GET /scheduled-tasks/notifications?since=<ms>` (contract revision 12) is a polling feed of completed, non-silent runs (redacted, `notify` flag carried through) consumed by the iOS/Android clients, which post local notifications on scheduled-list refresh; `aiden schedule notifications [since-ms]` exposes the same feed locally, and the desktop keeps its existing Electron notification path on Mac/Linux.
- **Prebuilt distribution — done.** `prebuilt/native/<target>/` ships architecture-verified helpers (darwin-universal, linux-x64, linux-arm64, with sha256 manifests) produced by `scripts/build-native-helpers.mjs` (host or `--docker` cross-build); the CLI bundle copies them when present and `AIDEN_NATIVE_PREBUILT_DIR` can point at a released set, so end users never need clang/cc.
- **Daemon-chat tool parity — done.** Daemon sessions now admit the headless-safe surface: memory, todo, MCP, web search, advisor (per-turn context fallback, no TUI questionnaire), and artifacts (files under `<agentDir>/artifacts`, path returned). Image display and ask-user-question stay interactive-only.

## Out of scope

Desktop global-hotkey dictation, computer-use, Bot Face Studio, and dock/menubar surfaces — inherently graphical or desktop-bound; terminal equivalents degrade (tables for canvases, export-and-open for artifacts, emoji/ASCII for avatars).

## Testing and acceptance

- Every phase extends `packages/cli/tests/` (registered in the root `test` chain): runtime smoke against the built bundle, structure checks, theme fidelity, and per-feature suites.
- pi upgrades go through a replay gate modeled on `scripts/pi-upgrade-evaluation.mjs` before the exact pin moves.


## Parity implementation checkpoint — 2026-09-05

Phases 2–5 now have CLI adapters and end-to-end tests: encrypted native provider credentials,
MCP transport/OAuth, workspace authority and snapshot interop, shared scheduling/Telegram,
Bot capability runtime, local speech workers, Remote HTTPS/SSE, native subagent execution,
and Docker packaging. See the [parity checklist](aiden-cli-parity-checklist.md) for the current
acceptance status and intentional terminal equivalents. Build checks inspect esbuild output
imports; earlier notes attributing erased TypeScript imports to a resolver failure were incorrect.
macOS and Linux CLI suites, native helper behavior, shared regression suites, TypeScript/lint, and Android checks pass. The plan remains active solely for the physical iPhone rerun, which Xcode cannot launch while the device is locked.
