# Aiden Agent — Main Process Architecture Map (Research for GPUI + Rust Port)

**Scope:** `/main` (Electron main process). 404 TypeScript files, ~121k LOC total (~65.5k non-test, ~55.5k `*.test.ts`).
**Date:** 2026-08-06. **App version:** aiden-agent 0.27.0 (Electron 43, macOS-only).
**Companion runtime deps:** `@earendil-works/pi-ai` + `@earendil-works/pi-agent-core` (exact-pinned 0.80.10 — the embedded "Pi" agent/LLM library), `@modelcontextprotocol/sdk` 1.30.0, `node-pty`, `sherpa-onnx-node`, `electron-updater`, `croner`, `re2-wasm`.

A pervasive codebase convention: **`*-core.ts` files are Electron-free, pure logic** (unit-tested under `tsx --test`); the **same-named file without `-core`** is the thin Electron/Node binding that wires real dependencies. Almost every service follows this split, which is excellent news for a Rust port — the `-core` modules are already dependency-injected state machines that map to plain Rust crates, and the bindings map to GPUI/async-runtime glue.

---

## 1. Entry & Bootstrap

### Startup chain

```
build/main/index.js  (package.json "main")
  └─ main/bootstrap.ts                    4 lines: configureRuntimeProfile() then dynamic-import index.ts
       └─ main/runtime-profile.ts         resolves + applies profile BEFORE any app code runs
            └─ main/runtime-profile-core.ts  pure resolution logic
       └─ main/index.ts (1,186 lines)     all app lifecycle
```

- **`main/bootstrap.ts`** — exists solely so `configureRuntimeProfile()` runs before `index.ts` is imported, because Electron's single-instance lock, Chromium session path, crash reporter, and logs must all observe the same profile.
- **`main/runtime-profile-core.ts`** — `resolveRuntimeProfile()` picks `production | development` from `AIDEN_RUNTIME_PROFILE` env, else `app.isPackaged`. Produces:
  - `appName`: `"Aiden Agent"` vs `"Aiden Agent Dev"`
  - `userDataPath` = `appData/<appName>` (or `--user-data-dir` switch)
  - `logsPath` = `<userData>/logs`, `crashDumpsPath` = `<userData>/Crashpad`
  - `configDir` = `$AIDEN_CONFIG_DIR` (must be absolute) else `~/.aiden` (prod) / `~/.aiden-dev` (dev)
  - `globalShortcutsEnabled` (prod, or dev with `AIDEN_DEV_GLOBAL_SHORTCUTS=1`), `updatesEnabled` (prod only)
- **`main/runtime-profile.ts`** — `mkdir -p 0700` all five dirs; `app.setName/setPath("userData")/setPath("sessionData")/setPath("crashDumps")/setAppLogsPath`; exports profile via env (`AIDEN_RUNTIME_PROFILE`, `AIDEN_CONFIG_DIR`) for child processes.
- **`main/runtime-mode.ts` + `runtime-mode-core.ts`** — `isPackagedRuntime()` = `app.isPackaged && !isDevelopmentRuntime(env)`. Gates updater, dev log, devtools, dock badge.

### `main/index.ts` — lifecycle (1,186 lines)

Single-instance lock (`app.requestSingleInstanceLock()`); on failure `app.quit()`. Otherwise:

1. `registerNativeHandlers()` (platform.ts) + `registerHandlers()` (handlers/index.ts) — **all IPC is registered before `app.whenReady()`**.
2. `app.on("second-instance")` → show main window; `window-all-closed` → quit only non-darwin; `activate` → force-refresh Foundation Models status + show window.
3. `before-quit` interception: `requestApplicationQuit()` runs the **close-guard protocol** (see below) before `shutdownAndQuit()`.
4. `whenReady()`:
   - Dev profile on darwin → dock badge "DEV".
   - Load packaged-subagent-soak session (test-only, `loadSubagentPackagedSoakSession`); requires subagents feature flag.
   - Dev only: `initDevLog(<logs>/aiden-dev.log)`.
   - **Startup reconciliation** (crash-recovery): `subagentRunStore.initialize()` → `reconcilePendingChatDeletions` → `reconcilePendingManagedWorktreeDeletions` (journals under `userData/worktrees`) → `reconcilePendingProviderCredentialRotation` → `reconcilePendingMcpCredentialCleanup`.
   - `configStore.getSettings()` → apply `nativeTheme.themeSource`, restore dock icon, build app menu, register global shortcuts (composer focus, dictation, assistant), kick Foundation Models status probe.
   - Resolve `shortcutInitializationPromise` — `createMainWindow()` awaits this so no renderer ever sees a partial shortcut snapshot.
   - Register portable-config watcher triggers: `browser-window-focus` + `powerMonitor.on("resume")` → re-read `~/.aiden/config.json`, reconcile external credential edits, broadcast `app:config-externally-changed`.
   - `createMainWindow()`, then (only if no soak) `scheduleService.start()` + `appUpdateService.start()`.

**Close-guard protocol** (unique, port-relevant): the renderer publishes dirty/gitBusy/saving state via `document.documentElement.dataset` and IPC `app:setCloseGuard`. Close/reload/quit go through `authorizeProtectedAction()` → `executeJavaScript` read of the dataset → optional native confirm dialog → `armRendererUnload` (writes approved revision) → then the actual close. `will-prevent-unload` retries the action against a fresh guard revision (max 3 attempts). Quit is a two-phase `shutdownAndQuit()`: `computerUseSettings.shutdown()` (must be durable first) → `llmClient.abortAll()` + bounded `llmClient.shutdown()` → `subagentRuntimeRegistry.shutdown()` → optional packaged-soak receipt → `cleanupApplication()` (updater, shortcuts, dictation, FM connection, scheduler, MCP close) → parallel settle of provider-auth-flow / computer-use status / scheduler / subagent run store → `app.quit()` (or updater install-and-restart).

**Superseding-task gate** (`services/superseding-task-core.ts`) ensures only the latest `loadURL` wins; **renderer-readiness gate** (`services/renderer-readiness-core.ts`) tracks `app:renderer-ready` IPC; render-process-gone triggers automatic `loadURL` recovery.

**Packaged subagent soak** (lines 118–871): a fixed-function, build-time-gated self-test that navigates the real renderer via `executeJavaScript` with hard-coded scripts (no caller-controlled selectors), drives one subagent lifecycle, and writes a receipt. Pure test infrastructure; a port can skip it entirely.

### `main/platform.ts` (128 lines) — the Electron façade

Centralizes every Electron import (`app`, `BrowserWindow`, `dialog`, `globalShortcut`, `nativeTheme`, `powerMonitor`, `safeStorage`, `shell`, `systemPreferences`, `Notification`, `ShareMenu`, `clipboard`, `screen`). Also defines:

- `logger` — scoped console logger mirrored to the dev log file.
- `ipcMain` wrapper — `handle/on/removeHandler` + **`broadcast(channel, payload)`** which sends to **all** windows (`BrowserWindow.getAllWindows()`). Every main→renderer event flows through this.
- `registerNativeHandlers()` — `aiden:dialog:open`, `aiden:theme:get/set`, `aiden:media:status/request` (mic/camera/screen via `systemPreferences`), `aiden:accessibility:status/request`, and `nativeTheme.on("updated")` → broadcast `aiden:theme:changed`.

**Port note:** this file is the seam. A GPUI port replaces it with a platform abstraction (windowing, dialogs, global hotkeys, keychain, theme, notifications, accessibility permissions).

---

## 2. Windows (`main/windows/`, 3 files, ~157 LOC + tests)

There are exactly **two** windows. Onboarding is **not** a window — it's a route in the main renderer (`renderer/components/onboarding-flow.test.tsx`).

| Window | File | Geometry & behavior |
|---|---|---|
| **Main window** | created inline in `main/index.ts:621` | 1000×700, min 390×456, `titleBarStyle: "hiddenInset"`, `trafficLightPosition {14,20}`, transparent + `vibrancy: "sidebar"`, `show:false` until `ready-to-show`. Loads `main-window.html` (dev: `$AIDEN_RENDERER_URL/main-window.html` from Vite :4143; prod: `build/renderer/` file URL). Preload `build/preload/preload.cjs`, `contextIsolation:true, nodeIntegration:false, sandbox:true`. All navigation/window-open/redirect denied and funneled to `shell.openExternal` (http/https/mailto only). |
| **Dictation pill** | `main/windows/pill-window.ts` | 280×56 frameless, transparent, shadowless, `alwaysOnTop` ("status" level), non-focusable, `skipTaskbar`, visible on all workspaces incl. fullscreen, `backgroundThrottling:false`. Positioned bottom-center (15px above work-area edge) on the display under the cursor. Loads `pill.html` + `preload-pill.cjs`. **The pill's renderer owns audio capture + local STT** so dictation works with the main window closed. |

- `windows/window-paths.ts` — resolves preload/HTML paths; `AIDEN_RENDERER_URL` is the dev-server switch.
- `windows/pill-window-security.ts` — `isTrustedPillSender()`: dictation IPC only accepted from the live pill's exact webContents id + main-frame URL match. The pill's IPC surface is only 4 channels (`dictation:result/error/cancel/ready`).

**Port note:** two windows map to two GPUI windows; the pill needs always-on-top, non-focusable, all-workspaces behavior (macOS NSWindow level/collectionBehavior — `cocoa`/`objc2` crates or GPUI's native window handles).

---

## 3. Handlers / IPC (`main/handlers/`, 25 files, ~3,103 LOC)

All channels are `ipcMain.handle(...)` request/response (no `ipcMain.on`). Renderer→main args are **`unknown`** and parsed/validated by `*-parse.ts` helpers (pure, unit-tested). Return values are plain JSON DTOs. Long-running work streams back over **notification broadcasts** (`ipcMain.broadcast`), allowlisted in `renderer/preload-channels.ts` (`NOTIFICATION_CHANNEL_VALUES`) and enforced by `handlers/ipc-contract.test.ts`.

**Streaming pattern:** `chat:start(streamId, params, messageTurnId)` returns `{streamId}` immediately; tokens arrive as `chat:delta` / `chat:reasoning-delta` / `chat:tool` / `chat:timeline` / `chat:subagents` / `chat:status` → `chat:done` | `chat:error`, sent **only to the owning renderer document** via `RendererDocumentOwner.send` (not broadcast). Approvals arrive as `chat:approval` and resolve via `chat:approve`.

### Channel inventory by domain

| Domain (file) | Channels | Shape notes |
|---|---|---|
| **App/meta** (`index.ts`, `handlers/index.ts`, `app.ts`) | `app:getInfo`, `app:setCloseGuard`, `app:getUpdateState`, `app:restartToUpdate`, `app:renderer-ready`, `app:setDockIcon`, `devlog:write` | `getInfo` → `{name, version, environment, capabilities{subagents}}`. Sender verified against main-window webContents id. |
| **Native** (`platform.ts`) | `aiden:dialog:open`, `aiden:theme:get/set`, `aiden:media:status/request`, `aiden:accessibility:status/request` | Direct Electron wrappers. |
| **Chat generation** (`chat.ts`) | `chat:start`, `chat:cancel`, `chat:approve` | Owner-bound (`chatGenerationOwner(event)`); ids must match `isSafeSubagentIdentifier`. Params parsed by `chat-params.ts` (attachments ≤20, bounded strings, roles, thinking levels). |
| **Chat history** (`chats.ts`) | `chats:list`, `chats:get`, `chats:create`, `chats:rename`, `chats:renameWithFoundationModels`, `chats:appendMessage`, `chats:remove`, `chats:setComputerUse`, `chats:moveEmptyToWorkspace`, `chats:waitUntilIdle`, `chats:abandonTurn` | `chats:get` returns `{chat, reconciliation}`; mutations gate on generation ownership (`llmClient.beginChatWorkspaceChange`, deletion gates). |
| **Providers & settings** (`providers.ts`) | `providers:list`, `providers:listModels`, `providers:save`, `providers:remove`, `providers:setKey`, `providers:test`, `providers:refresh`, `providers:logout`, `providers:auth:status/start/respond/cancel`, `settings:get`, `settings:set`, `settings:getAppearance`, `settings:getAppearanceState`, `settings:previewAppearance`, `settings:setGoogleThinking`, `settings:setCodexThinking`, `settings:setAnthropicThinking` | Auth flows stream `providers:auth:event/prompt/done/error`. Secrets write via `secrets.ts`; never returned to renderer. |
| **Workspaces & git** (`workspaces.ts`) | `workspaces:list/get/create/createFromFolder/createScratch/update/remove/openFolder/openInEditor/externalEditors/files/readFile/writeFile`, `git:review/diff/commit/pushCapability/push/compare/comparisonDiff/branches/checkout/createBranch/worktrees/createWorktree/deleteManagedWorktree` | Workspace-id scoped (renderer never passes fs paths for git); heavy admission gating (`workspaceMutationGate`, `workspaceOperationRegistry`, renderer-owner checks). |
| **MCP / skills / Exa / cloud voice** (`phase2.ts`) | `mcp:list/save/remove/status/authorize/oauthStatus/reconnect/presets/setPresetKey`, `skills:list/save/remove/discovered`, `exa:get/setKey/setEnabled`, `voice:transcribe` | OAuth: `mcp:authorize` → loopback flow, `mcp:oauthStatus` polls. `voice:transcribe` takes base64 audio + mimeType. |
| **Local voice** (`local-voice.ts`) | `localVoice:status`, `localModels:list/download/cancel/delete`, `voice:transcribeLocal` | PCM Float32 in, text out; download progress via `localModels:progress` broadcast. |
| **Dictation pill** (`dictation.ts`) | `dictation:result/error/cancel/ready` | Sender authenticated by `isCurrentPillEvent`. |
| **Terminal** (`terminal.ts`) | `terminal:create/snapshot/write/resize/close` | pty output streams via `terminal:data`, `terminal:exit`. Max 8 sessions/webContents; bounded buffers. |
| **Scheduled tasks** (`scheduled-tasks.ts`) | `schedule:list/save/remove/pause/resume/runNow/runs/preview/scripts/settings` | Cron validated; `schedule:updated` broadcast on change. |
| **Assistant** (`assistant.ts`) | `assistant:get-config`, `assistant:set-config` | Nested config + hotkey snapshot; transactional with shortcut re-registration. |
| **Subagents** (`subagents.ts`) | `subagents:get`, `subagents:manage` | History reads + v2 control plane (pause/resume/stop) — feature-flag gated. |
| **Shortcuts** (`shortcuts.ts`) | `shortcut:get`, `shortcut:set-recording`, `shortcut:set` | Transactional (persist+register+rollback); `shortcut:changed` broadcast. |
| **Computer Use** (`computer-use.ts`) | `computerUse:status`, `computerUse:setEnabled`, `computerUse:requestPermissions` | Owner-bound; enabling requires durable settings write. |
| **Artificial Analysis** (`artificial-analysis.ts`) | `artificialAnalysis:status/connect/refresh/disconnect` | Explicit user actions only; normalized action results. |
| **Titles** (`title-providers.ts`) | `titleProviders:status`, `titleProviders:refresh` | Apple Foundation Models availability. |
| **Usage** (`usage.ts`) | `usage:summary(range)` | Aggregate-only stats from `usage.json`. |
| **Profile** (`profile.ts`) | `profile:get`, `profile:setName`, `profile:shareImage` | `shareImage` → `ShareMenu` with a generated PNG. |
| **Attachments** (`attachments.ts`) | `attachments:read`, `models:info` | File reads bounded (8MB images / 100k chars text). |

**Broadcast channels** (main→renderer): `app:command`, `app:navigate`, `app:update-state`, `app:config-externally-changed`, `chat:approval/delta/done/error/reasoning-delta/status/subagents/timeline/tool`, `chats:metadata-updated`, `chats:settled`, `dictation:state`, `localModels:progress`, `providers:auth:*`, `schedule:updated`, `settings:appearance-changed`, `shortcut:changed`, `terminal:data`, `terminal:exit`, `aiden:theme:changed`.

---

## 4. Services (`main/services/`, ~370 files incl. subdirs)

LOC by domain (non-test): **subagents 21.3k (58 files)**, chat+generation 6.5k, git+worktree 5.9k, computer-use 4.7k, providers 4.2k, config+persist 3.4k, schedule 3.2k, models+catalog 2.9k, workspace/terminal 1.9k, mcp 1.8k, voice 0.6k, assistant 0.5k, misc ~5.2k.

### 4.1 Chat & generation (the heart)

| Service | Purpose / state | Persistence / externals |
|---|---|---|
| `llm-client.ts` (1,860 LOC) | **Chat generation orchestrator.** One `Agent` (pi-agent-core) per generation; owns multi-step tool loop, streaming, approvals (`ToolApprovalCoordinator`), cancellation, computer-use gate, subagent supervisor hookup, usage accounting, Gemini context cache. State: `active`/`initializing` generation maps keyed by streamId; chat deletion/workspace/turn-admission gates. | Network: via Pi transports. Writes messages to chat-store. |
| `chat-generation-owner.ts` + `renderer-document-owner.ts` (132) | Binds a generation/stream/approval to one renderer **document** (webContents + epoch). Invalidated on `did-navigate`/`render-process-gone`/`destroyed`. This is the app's fundamental ownership primitive — nearly every handler takes an owner and aborts when invalidated. | — |
| `chat-generation-start.ts`, `chat-turn-admission.ts`, `chat-cancel.ts` | Turn leasing (persist user message → register generation atomically), explicit-stop detection. | — |
| `chat-deletion-gate.ts`, `chat-deletion-reconciliation.ts`, `chat-workspace-authority.ts`, `chat-workspace-mutation-gate.ts` | Serialize chat deletion vs generation; journal pending deletions and reconcile at startup. | journal files |
| `generation-runtime.ts`, `generation-messages.ts`, `generation-context.ts` (476), `generation-timeline.ts` | Electron-free agent-runtime policy: pi message conversion, **context compaction** (token estimation, tool-result truncation at 32k chars, 40k recent-tool budget, fallback notice), timeline projection for the activity feed. | — |
| `generation-bound-connection-cache.ts` | Per-generation MCP connection attempts/cache with bounded close. | — |
| `chat-title.ts`, `chat-title-policy.ts`, `chat-title-routing.ts` | Background first-turn titles: route to Apple Foundation Models (on-device) or the chat's provider; 15s timeout; sanitized; `chats:metadata-updated` broadcast. | FM helper subprocess / provider API |
| `tools.ts` (agent tool assembly) | Builds the tool set per generation: coding tools + Exa `web_search` + Agent Skills + MCP tools + schedule tool + computer-use + subagent tools. | Exa network |
| `coding-tools.ts` (1,614 LOC) | Workspace-confined agent tools: `read_file`, `list_dir`, `glob`, `grep` (RE2 via `re2-wasm`), `write_file`, `edit_file`, `run_command` (spawn, argv-only in workspace cwd, 120s timeout, 10MB output cap). `APPROVAL_TOOL_NAMES` = write/edit/run. Secret redaction via `safe-text`. | child processes |
| `tool-approval.ts` | Approval prompt coordinator ("ask" permission mode) — pauses pi's `beforeToolCall` until `chat:approve` resolves. | — |
| `skills-discovery.ts` | Scans `~/.agents`, `~/.claude`, `~/.aiden` + workspace-local roots for `SKILL.md` (YAML frontmatter + markdown body). | fs reads |
| `gemini-context-cache.ts` (556) | Gemini **context caching** — creates/reuses server-side cached content for the workspace snapshot (`generativelanguage.googleapis.com/v1beta/cachedContents`), 1h TTL. | network (Google) |
| `usage-accounting.ts`, `usage-store.ts` + `usage-store-core.ts` (425) | Privacy-safe aggregate usage (no prompts/paths/content) — token breakdowns per provider/model/source (`chat`, `chat-title`, `voice-transcription`, `scheduled`, `subagent`). | `userData/usage.json` via DataStore |
| `attachments.ts` | Read composer attachments (images→base64 ≤8MB, text ≤100k chars). | fs reads |

### 4.2 Chat store (persistence of conversations)

| Service | Purpose / state | Persistence |
|---|---|---|
| `chat-store.ts` → `chat-store-core.ts` (639) | **Chat history**: `userData/chats/index.json` (metadata) + one JSON per chat (`<id>.json`). Serialized op queue, fsync'd atomic writes with staging files, `.chat-transaction.<id>.pending` journals for crash recovery, strict chat-id validation (NFKC, charset, length). Title policy hooks. | JSON files under `userData/chats/` |

### 4.3 Config, secrets & portable config

| Service | Purpose / state | Persistence |
|---|---|---|
| `data-store.ts` (556) | **Generic atomic JSON store.** Staged temp + rename, fsync file+dir, corrupt-file preservation (`.invalid-<ts>`), external-change detection via byte-hash comparison, protected publication (hold/relink protocol with `.held`/`.previous` files + startup reconciliation), reload-before-write option. This is the durability backbone for nearly all JSON state. | JSON files |
| `aiden-config-dir.ts` | Resolves portable root: `$AIDEN_CONFIG_DIR` else `~/.aiden` (absolute-override enforced). | — |
| `portable-config.ts` → `portable-config-core.ts` (1,175) | **The four-way split**: `~/.aiden/config.json` (portable: provider intent, id aliases, MCP servers, skills — user hand-editable) + `userData/settings.json` (UI prefs) + `userData/config.json` (workspaces, seeding markers) + `userData/provider-model-cache.json` (regenerable). One-time migration from legacy single-file config. Watches/hand-edit reload via `portable-config-watch-core.ts` + `portable-credential-snapshot.ts`. | 4 JSON files |
| `config-store.ts` → `config-store-core.ts` (779) | The app-facing API over the four stores: providers (list/save/remove, alias resolution), settings (get/set incl. per-model thinking levels, appearance), MCP servers, skills, workspaces (CRUD + scratch + managed-worktree records). First-run seeds a default folderless workspace. | via portable-config stores |
| `secrets.ts` (412) + `secret-map-core.ts` | **Provider API keys**: `safeStorage.encryptString` (Keychain-backed) → base64 ciphertext in `userData/provider-keys.json` (mode 0600). Serialized mutations, binding/quarantine prefixes for rotation transactions, legacy-key migration. | safeStorage + JSON |
| `pi-credential-store.ts` + `pi-credential-store-core.ts` | **Pi's `CredentialStore` impl** (OAuth tokens etc.): `userData/pi-provider-credentials.json`, safeStorage-encrypted. | safeStorage + JSON |
| `pi-models-store.ts` | Pi's `ModelsStore` impl (dynamic catalog snapshots): `userData/pi-provider-models.json`. | JSON |
| `mcp-oauth-store.ts` + `mcp-oauth-store-core.ts` | MCP OAuth sessions (DCR + tokens + PKCE verifier): `userData/mcp-oauth.json`, safeStorage-encrypted. | safeStorage + JSON |
| `provider-credential-rotation*.ts`, `mcp-credential-cleanup*.ts`, `legacy-pi-credential-migration*.ts`, `portable-credential-snapshot.ts` | Transactional credential mutations with pending-journal startup reconciliation; external-edit reconciliation (hand-edited `config.json` vs keychain). | journals |

### 4.4 Providers & models

**Architecture: Pi (`@earendil-works/pi-ai`) is the provider authority** — it owns endpoints, auth (API key + OAuth), model catalogs, and streaming transports for all hosted built-ins (OpenAI, Anthropic, Google, xAI, OpenRouter, DeepSeek, Vercel AI Gateway, OpenCode, Z.AI, Kimi, Groq, Mistral, Bedrock…). Aiden layers policy on top.

| Service | Purpose / state | Network |
|---|---|---|
| `provider-registry.ts` | Process-wide `ProviderRegistry`: wraps Pi `Models` + `CredentialStore`; composes `StoredProvider` records with thinking metadata; owns `CodexProviderService`; auth backends for `provider-auth-flow`. | via Pi |
| `anthropic-provider.ts`, `google-provider.ts` | Thinking-level capability enrichment from Pi builtin catalogs; Google native base URL `https://generativelanguage.googleapis.com/v1beta`, default model pins. | via Pi |
| `codex-provider.ts` (765) | **ChatGPT/Codex OAuth provider**: `https://chatgpt.com/backend-api`, OAuth credential lifecycle w/ generation tracking, request-time auth resolution, typed runtime errors. | OpenAI |
| `model-runtime.ts` + `model-runtime-core.ts` | Resolves `(providerId, modelId)` → `ResolvedModelRuntime` (Pi stream factory + limits + thinking level), incl. custom `custom:*` providers (LM Studio/Ollama/Tailscale/OpenAI-compatible), adaptive-thinking forcing for Anthropic APIs. | via Pi |
| `models.ts` (477) | **Model discovery** for custom/self-hosted endpoints: GET `/models` (OpenAI-style), Google paginated `models` list, Ollama `/api/tags` + `/api/show`. | provider LAN/localhost |
| `models-catalog.ts` + `models-catalog-core.ts` (480) | Offline model-info resolution: **bundled `resources/model-capabilities.json` (models.dev snapshot, refreshed only by `npm run models:refresh`/`dist`)** → Artificial Analysis device-local cache → local discovery. **Reading model info never hits the network** (AGENTS.md invariant). | none at read time |
| `artificial-analysis-runtime.ts` + `-core` (705) + `-catalog-core` + `-cache` + `-action-core` | Optional user-driven AA integration: Connect & fetch / Fetch latest with the user's own key against `https://artificialanalysis.ai/api/v2/language/models/free`; normalized cache at `userData/artificial-analysis-model-cache.json` (≤32MB, bounded reads); key in pi-credential-store (`artificial-analysis`). | AA API (explicit only) |
| `local-models.ts` | Parakeet STT model catalog (fixed, k2-fsa GitHub releases) + download/extract (tar.bz2 via `fetch` + `execFile tar`) into `userData`; progress broadcast. | GitHub releases |
| `local-runtime-status.ts` | Cold-start "Model loading…" probes for local deployments: Ollama `/api/ps`, LM Studio loaded-state. | localhost |
| `foundation-models-connection.ts` + `-core` | **Apple Foundation Models** (on-device titles/availability): spawns the Swift helper app per request with a temp-dir file exchange (request.json ≤20KB, stdout ≤64KB, 15s gen timeout). | none (on-device) |
| `provider-auth-flow.ts` + `provider-auth-flow-core.ts` (971) | Coordinator for Pi interactive auth (API-key prompts and OAuth handshakes) with renderer prompt streaming. | provider OAuth |
| `provider-list-core.ts`, `provider-model-info.ts(-core)`, `provider-key-policy.ts`, `provider-config-migration-core.ts`, `custom-provider-id.ts` | List shaping for Settings UI, per-model info resolution, key validation policy, legacy migrations (incl. `openai→api.openai.com` etc.), `custom:*` id grammar. | — |

### 4.5 MCP (`mcp-*.ts`, ~1,785 LOC)

| Service | Purpose / state | Externals |
|---|---|---|
| `mcp.ts` (387) | **MCP connection manager**: caches SDK `Client`s; transports = stdio (spawn command), StreamableHTTP, SSE; injects preset API keys from secrets as auth headers; wraps MCP tools as pi `AgentTool`s (`Type.Unsafe` schema); generation-bound connection cache; subagent-isolated clients. | spawns stdio servers; HTTP/SSE |
| `mcp-oauth.ts` (532) + `mcp-oauth-session.ts` + `mcp-oauth-operation.ts` | **Native-app OAuth (RFC 8252 loopback)**: fixed `http://127.0.0.1:41390/callback` server, opens system browser, PKCE + dynamic client registration, 5-min timeout; background (non-interactive) refresh never opens a browser. | loopback HTTP + remote IdP |
| `mcp-presets.ts` | Built-in preset catalog: **Composio, Notion, Linear** (streamable HTTP; API-key-in-header or OAuth). Data-only to extend. | remote |
| `mcp-config-lease.ts` | Lease invalidation when MCP config changes (portable file external edits or app writes). | — |
| `mcp-credential-cleanup*.ts` | Transactional preset-key replacement with pending-cleanup journals + startup reconcile. | journals |
| `mcp-tool-result.ts`, `mcp-tool-identity.ts`, `mcp-selection.ts` | Bounded tool-result normalization (size caps, image passthrough), unique tool naming (`mcp_<server>_<tool>`), settings selection validation. | — |

### 4.6 Subagents (`services/subagents/`, 58 files, ~21.3k LOC) — largest domain

Hierarchical, permission-bounded child agents spawned by a parent generation. V2 is the production line (feature flags `AIDEN_SUBAGENTS_*`, on by default with env rollback).

Key pieces:

| File(s) | Role |
|---|---|
| `subagent-supervisor.ts` (1,340) | Per-parent-generation supervisor: builds child runtimes, enforces tree budgets, projects events. |
| `subagent-child-runner.ts` (801), `child-agent-runtime.ts` | Runs a child `Agent` loop with its own tool assembly, deadline + cancellation grace; **runtime registry** tracks active children per chat (abort-all on shutdown). |
| `subagent-nesting-core.ts` (988) | V2 tree scheduler/budget ledger: depth/fanout/concurrency limits, execution leases. |
| `authority-v2.ts` (633), `approval-v2.ts`, `outbound-approval-v2.ts`, `request-capabilities-v2.ts`, `eligibility.ts`, `capability-profile.ts`, `role-catalog.ts` | **Authority model**: signed capability grants (provider fingerprint, workspace revision, owner document), per-request capability projection, outbound tool approval gates, role system prompts. |
| `forked-context.ts` (505) | Child context = forked parent transcript capture or fresh context. |
| `subagent-run-store*.ts` (core 997, v2-core 1,355, dispatcher, production, migration, io) | **Durable run history**: `userData/subagent-runs[-v2]`, writes delegated to the **`aiden-subagent-run-store` native C binary** (base64 stdin protocol, generation-token CAS writes, 8MB cap, FIFO-safe `O_NONBLOCK|O_NOFOLLOW` reads). V1→V2 migration. |
| `subagent-shell.ts` (539) + `subagent-shell-runner-io.ts` | Child shell execution via **`aiden-subagent-shell-runner` C binary**: nonce-authenticated binary protocol, 64KB command cap, 512KB stream caps, process-group cleanup confirmation. |
| `subagent-file-mutator-io.ts` (786) + `subagent-file-mutation-core.ts` | Child file writes via **`aiden-subagent-file-mutator` C binary**: staging+rename, SHA-256 provenance, xattr marking, conflict detection, 200KB content cap. |
| `subagent-mcp-*.ts` (read 1,009, mutation 815, client-core, credential-*, inventory-*, bounded-fetch) | Per-child **isolated MCP clients**: read-only tool projection, approval-gated mutations, credential redaction (tokens never enter child context), bounded fetch wrappers. |
| `subagent-web-proxy.ts` + `-production` | Child web search: bounded Exa proxy (query ≤2KB, response ≤256KB, per-tree network budget ledger `network-budget-v2.ts`). |
| `subagent-workspace-write.ts` (761) | Approval-gated workspace writes for children. |
| `subagent-control-main.ts`, `subagent-control-v2.ts` (644), `subagent-control-ipc-core.ts`, `management-v2.ts`, `background-lifecycle-v2.ts` (626) | Control plane: pause/resume/stop from UI, app-lifetime background lifecycle, renderer management IPC. |
| `subagent-health-metrics*.ts`, `subagent-event-projector.ts`, `subagent-foreground-persistence-v2.ts` (817), `subagent-history-read-core.ts` | Aggregate lifecycle metrics (starts/settlements) + run-event projection into the durable store + history reads for the UI. |
| `subagent-packaged-soak-*.ts` (528) | Packaged-app lifecycle soak harness (used by `index.ts`). Test-only. |
| `safe-text.ts`, `subagent-identifier-privacy.ts`, `concurrency-gate.ts`, `feature-flag.ts`, `contracts.ts`, `subagent-tool*.ts`, `capability-tools.ts` | Secret redaction (high-confidence secret patterns, multi-encoding), id privacy, concurrency ceilings (2 hosted / 1 local child, 32 queued), env flags, request/response contracts, the parent-facing `subagent` agent tool. |

### 4.7 Assistant (`services/assistant/`, ~496 LOC)

In-window "Aiden Assistant" dock: threads are plain chats in a reserved workspace id (`ASSISTANT_WORKSPACE_ID`).

- `system-prompt.ts` — attended/unattended persona prompts.
- `mcp-tool.ts`, `project-tool.ts` — read-only tools to list eligible MCP servers / project (git) status for automations.
- `tool-loop-guard.ts` — attended tool-error recovery (prevents infinite tool loops).

### 4.8 Computer Use (`services/computer-use/`, 16 files, ~4.7k LOC) — macOS 14.4+

Beta GUI-automation tool driven by an external **cua-driver** (vendored `cua-driver` binary v0.8.3, SHA-256 pinned in `binary.ts`, upstream team-id pinned) plus Aiden's own signed **Rust broker** (`native/computer-use-broker`).

| File | Role |
|---|---|
| `binary.ts` | Resolves + **verifies** the driver installation (code-signature identifier/team-id checks, SHA-256 of the bridge binary, `spctl`-style assessment via bounded `runCuaDriverCommand`). |
| `host.ts` (487) | Spawns bridge + broker launcher; startup handshake with 10s timeout; temp dir lifecycle; bounded diagnostics. |
| `session.ts` (669) | **Speaks MCP JSON-RPC** to the bridge over its stdio transport (SDK `Client` with custom in-process transport); tool catalog validation against the compiled-in allowlist. |
| `controller.ts` (1,380) | The agent-facing controller: normalized computer-use actions (click/type/key/screenshot/window ops), 30s action timeout, image caps (60MB b64), grant ledger integration. |
| `safety.ts` (581) | Permission grant ledger, target binding (pid/window), approval summaries, key-chord parsing, fail-closed policy. |
| `settings.ts(-core)`, `status.ts`, `status-core.ts` (463) | Global enablement (durable write required before quit), status probe (`computerUse:status`), permission requests (screen recording + accessibility via the broker). |
| `tool.ts`, `generation-gate.ts`, `schema.ts`, `runtime.ts`, `process.ts`, `contract.ts` | pi `AgentTool` wrapper, per-generation activation gate, arg schema, host factory, bounded process utils, version/tool allowlist contract (must match native side — "fail closed on contract drift"). |
| `fixtures/fake-cua-driver.mjs` | Test double for the bridge protocol. |

### 4.9 Scheduling (`schedule-*.ts`, ~3.2k LOC)

| File | Role | Persistence / externals |
|---|---|---|
| `schedule-service.ts` + `schedule-service-core.ts` | Cron engine (`croner`), global enable gate, `schedule:updated` broadcast. | — |
| `schedule-store.ts` (624) | Tasks + last-50 runs per task (output ≤64KB): `userData/schedules.json` via DataStore. Cron/timezone validation, revision counters. | JSON |
| `schedule-execution.ts` | Runs a task as a **background chat generation** with a synthetic `ChatGenerationOwner` (documentId `scheduled:<streamId>`); macOS `Notification` delivery + in-app navigation to the run chat. | llm-client, Notification |
| `schedule-tool.ts` (1,145) | The approval-gated `schedule_task` / edit-automation agent tools (assistant-created automations); prompt-safety guard, MCP binding validation, provider fingerprint pinning. | — |
| `schedule-guard.ts`, `schedule-mcp-binding.ts`, `schedule-provider-binding.ts`, `scheduled-settings-core.ts`, `schedule-script.ts`, `schedule-notification.ts` | Unattended-run boundary assertions (silent `[SILENT]` runs, read-only profiles), exact MCP server bindings, provider fingerprint, settings patch logic, `~/.aiden/scripts` script-mode runner, notification formatting. | scripts dir |

### 4.10 Git & worktrees (`git.ts` 5,199 LOC + managed-worktree-*, ~5.9k total)

- `git.ts` — **All git ops**: argv-only `spawn` (no shell), isolated process groups, bounded output (1MB default / 64MB snapshot), timeouts (4s read / 20s mutation / 120s push), LRU caches, mutation serialization per common-dir, env scrubbing (`GIT_DIR` etc. stripped). Operations: info/review/diff/commit/push(+capability probe)/compare/branches/checkout/createBranch/worktrees/createWorktree + **managed worktrees** (Aiden-owned `.aiden-worktrees` with ownership tokens, device/inode identity pinning).
- `managed-worktree-creation-core.ts`, `managed-worktree-removal-core.ts`, `managed-worktree-remover.ts`, `managed-worktree-deletion-recovery.ts`, `managed-worktree-admission.ts` — creation/removal journals, startup recovery of interrupted deletions, admission fencing. Removal delegates the actual recursive delete to the **`aiden-worktree-remover` C binary** (manifest + authorization-token protocol, quarantine rename → scan → delete, `com.apple.provenance`-aware).
- Network: `git push`/fetch go through the user's git+credentials (SSH/agent); Aiden never handles git credentials.

### 4.11 Workspaces, files & terminal

- `workspace-files.ts` (453) — bounded workspace-confined file read/write/list for the Files panel (symlink escape protection via realpath confinement).
- `scratch-workspace.ts` — generates `~/aiden/<word>-<word>-<word>` scratch folders for folderless chats.
- `terminal.ts` (service) — **node-pty** sessions owned by renderer document + workspace: `$SHELL` (fallback `/bin/zsh`), max 8 sessions/webContents, 200KB scrollback buffer, resize clamps, epoch-killed on reload.
- `external-editors.ts` (540) — detects installed editors (bundle ids / app names), opens folders via `open -a`/`open -b`.
- `workspace-mutation-gate.ts`, `workspace-operation-registry.ts`, `workspace-record-removal.ts`, `workspace-schedule-restoration.ts` — mutation fencing: changing/removing a workspace cancels generations, blocks schedules, and serializes renderer-initiated ops.

### 4.12 Voice (dictation + transcription, ~621 LOC + parakeet/transcription)

- `dictation.ts` + `dictation-coordinator.ts` + `dictation-paste.ts` — global hotkey state machine (idle→recording→transcribing→idle), pill window lifecycle, paste into focused app (Accessibility API via native paste helper / clipboard fallback, one-prompt-per-session policy).
- `parakeet.ts` — on-device STT via `sherpa-onnx-node` native addon (CommonJS `createRequire`), recognizer cache per model (~600MB ONNX).
- `transcription.ts` — cloud STT: OpenAI-compatible `/audio/transcriptions` or Gemini; records usage.
- Recording happens in the **pill renderer** (getUserMedia); PCM/base64 crosses IPC.

### 4.13 App services (misc)

| Service | Purpose |
|---|---|
| `app-updater.ts` + `app-updater-core.ts` | `electron-updater` autoUpdater: generic provider (app-update.yml), 15s initial delay + 6h interval, prod-only, state machine broadcast as `app:update-state`, quit-and-install orchestration. **Network: update server.** |
| `shortcut.ts` + `shortcut-registration-core.ts` + `shortcut-transaction-core.ts` | Transactional global shortcuts (`globalShortcut`): persist↔register with rollback; recording suspension; command catalog from `renderer/shared/keybindings.ts`. |
| `profile.ts` + `profile-core.ts` | Display name (macOS `id -F` → settings). |
| `profile-share.ts` + `-core` + `-files` | Render usage profile PNG (data URL from renderer) → `ShareMenu`. |
| `dev-log.ts` | Dev-only file log (`logs/aiden-dev.log`, 2MB rotation, 4KB line cap), renderer error forwarding. |
| `quit-barrier.ts` | Close renderer before shutdown; survives webContents invalidation races. |
| `app-navigation.ts` | In-app path opener registry (notifications deep-link into routes). |
| `appearance-preview-core.ts` | Settings appearance preview computation. |
| `renderer-readiness-core.ts`, `superseding-task-core.ts` | Readiness gate; latest-wins task gate. |
| `regular-file-read.ts` | Safe regular-file reads (no FIFO/symlink tricks) used by stores. |
| `types.ts` (641) | All shared DTO types (AppSettings, Provider, Workspace, Chat, ScheduledTask, Usage…). |

---

## 5. Persistence Layer — on-disk layout

**Two roots:**

### A. Portable, user-editable — `~/.aiden/` (prod) or `~/.aiden-dev/` (dev); override `$AIDEN_CONFIG_DIR`
| File/Dir | Contents |
|---|---|
| `config.json` | Provider intent (no secrets), `providerIdAliases`, MCP servers, skills. Hand-editable; re-read on window focus + resume; content-hash change → `app:config-externally-changed` + credential reconciliation. |
| `skill/`, `skills/` | Skill folders (`SKILL.md`). |
| `scripts/` | Scheduled-task script files. |

### B. Machine-local — Electron `userData` (`~/Library/Application Support/Aiden Agent[ Dev]/`)
| File/Dir | Writer | Notes |
|---|---|---|
| `settings.json` | DataStore | UI prefs (AppSettings: appearance, keybindings, thinking levels, feature gates, profileName). |
| `config.json` | DataStore | Workspaces (absolute paths, managed-worktree records), `seeded`, `aidenDirMigratedAt`. |
| `provider-model-cache.json` | DataStore | Regenerable discovered model lists/metadata. |
| `provider-keys.json` | secrets.ts | **safeStorage-encrypted** provider API keys (0600). |
| `pi-provider-credentials.json` | pi-credential-store | **safeStorage-encrypted** Pi OAuth/API credentials. |
| `mcp-oauth.json` | mcp-oauth-store | **safeStorage-encrypted** MCP OAuth sessions. |
| `pi-provider-models.json` | pi-models-store | Pi dynamic catalog snapshots. |
| `artificial-analysis-model-cache.json` | AA cache | Device-local normalized AA catalog (≤32MB). |
| `usage.json` | DataStore | Aggregate usage only (no content). |
| `schedules.json` | DataStore | Scheduled tasks + run history. |
| `chats/index.json` + `chats/<id>.json` | chat-store | Chat metadata + transcripts; transactional journals. |
| `subagent-runs/`, `subagent-runs-v2/` | **native C helper** | Durable subagent run history (CAS generation tokens). |
| `worktrees/` | git subsystem | Managed-worktree deletion journals. |
| `logs/aiden-dev.log` | dev-log | Dev builds only. |
| Parakeet model dirs | local-models | Extracted sherpa-onnx bundles (~620MB each). |

**Keychain usage:** exclusively through Electron `safeStorage` (macOS Keychain-backed AES), ciphertext stored base64 in the JSON files above. No raw keychain items. **Port:** `keyring` crate (or `security-framework`) with the same "ciphertext in JSON" layout, or store ciphertext directly with keychain-held data items.

**Durability conventions to port:** staged-write + rename + fsync(file & dir); `.held`/`.previous` predecessor files with startup reconciliation; corrupt-file preservation (`*.invalid-<ts>`); external-change detection by content hash; mutation queues per store; pending-transaction journals for multi-step credential/deletion operations.

---

## 6. External Processes

| Process | Language | Spawned by | Protocol |
|---|---|---|---|
| **MCP servers (stdio)** | user-provided | `mcp.ts` via SDK `StdioClientTransport` | MCP JSON-RPC over stdio |
| **Aiden Foundation Models Helper.app** | Swift (SwiftPM, `native/apple-foundation-models`) | `foundation-models-connection.ts` per request | Temp-dir file exchange: `request.json` in, JSON on stdout (≤64KB). Methods: `availability`, `generateTitle`. |
| **aiden-cua-broker** (Computer Use) | **Rust** (`native/computer-use-broker`, tokio-free? uses std+objc via `darwin.rs`, `darwin_security.m`) | `computer-use/host.ts` (+ vendored `cua-driver` bridge) | MCP JSON-RPC over stdio between bridge↔session; broker owns TCC permissions (screen recording/accessibility), launch-requirement API (macOS 14.4+). |
| **aiden-subagent-run-store** | C | `subagent-run-store-io.ts` (persistent child) | base64-wrapped JSON commands on stdin/stdout; CAS write with generation tokens; 8MB store cap. |
| **aiden-subagent-shell-runner** | C | `subagent-shell-runner-io.ts` per command | Binary protocol: nonce auth (64B), SHA-256 digests, fixed-size headers, 512KB stream caps, cleanup confirmation. |
| **aiden-subagent-file-mutator** | C | `subagent-file-mutator-io.ts` per mutation | base64 JSON command; staging+rename, provenance SHA-256 + xattr, conflict codes. |
| **aiden-worktree-remover** | C (CommonCrypto) | `managed-worktree-remover.ts` per deletion | argv + manifest files; exit codes (identity-changed/mutation-detected/…); quarantine→authorize→delete dance. |
| **node-pty shells** | native addon | `terminal.ts` | pty master/slave; `$SHELL` in workspace cwd. |
| **sherpa-onnx** | native addon (ONNX Runtime) | `parakeet.ts` in-process | C API via N-API; PCM Float32 in → text out. |
| **git** | system binary | `git.ts` | argv exec, bounded stdout/stderr. |
| **misc `/usr/bin/id`, `tar`, `open`** | system | profile.ts, local-models.ts, external-editors.ts | execFile bounded. |

Native build scripts: `scripts/build-*.mjs` (clang for C, cargo for Rust, swift build for Swift). The C helpers exist for **TOCTOU-safe, resource-fork/xattr-aware, FIFO-immune filesystem operations** that Node can't guarantee — a Rust port can absorb all four C helpers as in-process modules using `std::fs` + `nix` (the safety properties are easier in Rust).

---

## 7. Network Surfaces

| Surface | Owner service | When |
|---|---|---|
| **LLM provider APIs** (OpenAI, Anthropic, Google, xAI, OpenRouter, DeepSeek, Vercel, OpenCode, Z.AI, Kimi, Groq, Mistral, Bedrock, custom endpoints) | Pi transports via `model-runtime.ts` / `provider-registry.ts` / `codex-provider.ts` | Generation, title, transcription, model tests |
| **ChatGPT backend OAuth/API** (`chatgpt.com/backend-api`) | `codex-provider.ts` | Codex auth + requests |
| **Google context caching** (`generativelanguage.googleapis.com/v1beta/cachedContents`) | `gemini-context-cache.ts` | Gemini generations |
| **Google model listing** | `models.ts` | Discovery refresh |
| **Custom/self-hosted discovery** (`/models`, Ollama `/api/tags`,`/api/show`, `/api/ps`, LM Studio state) | `models.ts`, `local-runtime-status.ts` | Explicit refresh / load probes |
| **MCP remote servers** (HTTP/SSE) + presets (Composio/Notion/Linear) + OAuth IdPs | `mcp.ts`, `mcp-oauth.ts` (+ loopback `127.0.0.1:41390`) | Connections, auth |
| **Exa search** (`api.exa.ai/search`) | `tools.ts`, `subagent-web-proxy.ts` | Agent web_search tool (key-gated) |
| **Artificial Analysis** (`artificialanalysis.ai/api/v2/language/models/free`) | `artificial-analysis-runtime-core.ts` | **Only** explicit Connect/Refresh with user key |
| **App updates** (electron-updater, generic provider per `app-update.yml`) | `app-updater.ts` | Prod only: 15s after start, then 6h interval |
| **sherpa-onnx model downloads** (`github.com/k2-fsa/sherpa-onnx/releases`) | `local-models.ts` | User-initiated download |
| **git push/fetch** | `git.ts` via system git | User actions |
| **models.dev** | **build-time only** (`scripts/update-model-capabilities.mjs`); runtime reads bundled `resources/model-capabilities.json` | Never at runtime (AGENTS.md invariant) |

---

## 8. Top 20 largest/most complex files in `main/` (non-test)

| # | LOC | File | One-liner |
|---|---|---|---|
| 1 | 5,199 | `main/services/git.ts` | All structured git operations incl. managed-worktree lifecycle, with bounded argv execution and crash-recovery journals. |
| 2 | 1,860 | `main/services/llm-client.ts` | Chat generation orchestrator: per-turn Pi Agent, streaming, approvals, cancellation, subagent/computer-use gates, shutdown drains. |
| 3 | 1,614 | `main/services/coding-tools.ts` | Workspace-confined agent tools (read/list/glob/grep/write/edit/run_command) with RE2 grep and secret redaction. |
| 4 | 1,380 | `main/services/computer-use/controller.ts` | Agent-facing macOS GUI automation controller over the verified cua-driver session. |
| 5 | 1,355 | `main/services/subagents/subagent-run-store-v2-core.ts` | V2 durable subagent run-history state machine (events, projections, checkpoints). |
| 6 | 1,340 | `main/services/subagents/subagent-supervisor.ts` | Per-generation subagent supervisor: child construction, tree budgets, event projection. |
| 7 | 1,186 | `main/index.ts` | App entry: lifecycle, main window, close-guard protocol, menus, startup reconciliation, shutdown orchestration. |
| 8 | 1,175 | `main/services/portable-config-core.ts` | The portable/machine-local config split + migration, four coordinated DataStores. |
| 9 | 1,145 | `main/services/schedule-tool.ts` | Approval-gated `schedule_task`/edit-automation agent tools with MCP/provider binding pins. |
| 10 | 1,009 | `main/services/subagents/subagent-mcp-read.ts` | Read-only MCP tool projection for child agents with isolated clients. |
| 11 | 997 | `main/services/subagents/subagent-run-store-core.ts` | V1 run-store core (append/query over the native CAS storage). |
| 12 | 988 | `main/services/subagents/subagent-nesting-core.ts` | V2 subagent tree scheduler: depth/fanout/concurrency budgets and execution leases. |
| 13 | 971 | `main/services/provider-auth-flow-core.ts` | Interactive provider auth (API-key/OAuth) coordinator state machine. |
| 14 | 817 | `main/services/subagents/subagent-foreground-persistence-v2.ts` | Foreground run persistence pipeline into the durable store. |
| 15 | 815 | `main/services/subagents/subagent-mcp-mutation.ts` | Approval-gated MCP mutations for child agents. |
| 16 | 801 | `main/services/subagents/subagent-child-runner.ts` | Child agent loop execution with deadlines and cancellation grace. |
| 17 | 786 | `main/services/subagents/subagent-file-mutator-io.ts` | IO side of the native file-mutator protocol (spawn, base64 commands, provenance checks). |
| 18 | 779 | `main/services/config-store-core.ts` | App-facing config API over the four-store split (providers/settings/MCP/skills/workspaces). |
| 19 | 765 | `main/services/codex-provider.ts` | ChatGPT/Codex OAuth provider: credential lifecycle, request-time auth, typed errors. |
| 20 | 761 | `main/services/subagents/subagent-workspace-write.ts` | Approval-gated workspace writes for child agents. |

*(Runner-up: `handlers/workspaces.ts` at 702 LOC — the widest IPC surface.)*

---

## 9. Porting Complexity (Electron/TS → GPUI + Rust)

| Domain | Rating | Notes & Rust crate equivalents |
|---|---|---|
| **Entry/bootstrap/lifecycle** | **Medium** | Single-instance (`single-instance` or manual lockfile), close-guard protocol and two-phase shutdown must be redesigned for GPUI's lifecycle; the *logic* is simple but the close-guard's renderer-dataset handshake needs a new ownership channel. |
| **Runtime profile/config dirs** | **Low** | Pure path/env logic; `dirs` crate. `runtime-profile-core` ports 1:1. |
| **Windows (main + pill)** | **Medium** | GPUI windows; pill needs NSWindow always-on-top/non-focusable/all-spaces via `objc2-app-kit`. Vibrancy/traffic-light positioning are macOS-specific either way. |
| **IPC layer** | **Medium** | Electron IPC disappears entirely in a single-process GPUI app — handlers become direct async function calls; the `unknown`-arg validation (`*-parse.ts`) ports to `serde` + validator types; broadcasts become GPUI events/`async-channel`. The **RendererDocumentOwner** concept becomes a window/entity-handle epoch — keep the pattern, it's central. |
| **DataStore atomic JSON persistence** | **Medium** | `serde_json` + `tempfile` + `fsync` (`std::fs::File::sync_all`, dir fsync via `nix`); the `.held`/`.previous` reconciliation and content-hash external-change detection are portable as-is. |
| **Keychain/secrets (safeStorage)** | **Low-Medium** | `keyring` or `security-framework`; keep "ciphertext-in-JSON" layout or move to keychain items directly (simpler). Rotation/quarantine state machines (`secret-map-core`) are pure logic. |
| **Chat store** | **Low-Medium** | JSON files + serialized op queue (`tokio::sync::Mutex` / dedicated writer task); journals port directly. |
| **Portable config split + watching** | **Low-Medium** | Pure logic already; file watching with `notify` crate replaces focus/resume-triggered re-reads (actually simpler). |
| **Providers via Pi (TS library!)** | **Very-High** | **The biggest port risk.** `@earendil-works/pi-ai` + `pi-agent-core` own: provider transports, OAuth, model catalogs, the agent loop, tool-call orchestration, token accounting, context compaction primitives, typebox schemas. A Rust port must either (a) reimplement an agent loop + per-provider streaming clients (`reqwest` + `eventsource-stream` + `tiktoken`/`tokenizers`), or (b) keep a Node sidecar running Pi (defeats the port), or (c) adopt a Rust agent framework. Budget accordingly. |
| **Anthropic/Google/Codex policy layers** | **Medium** | Thinking-level metadata, base URLs, model pins — plain data/policy. Codex OAuth flow: `oauth2` crate + loopback (`axum`/`tiny-http`). |
| **Model catalogs (models.dev snapshot + AA)** | **Low** | Bundled JSON + optional `reqwest` fetch; parsing/normalization is `-core` pure logic. |
| **MCP client** | **High** | Official SDK is TS. Rust options: `rmcp` (official-ish Rust MCP SDK) covers stdio/HTTP/SSE client; OAuth loopback needs `oauth2` + local server. Presets/credential-lease logic ports cleanly. |
| **MCP OAuth (loopback RFC 8252)** | **Medium** | `oauth2` + `axum` on 127.0.0.1:41390; PKCE built-in. Session store = secrets port. |
| **Subagents (21k LOC)** | **Very-High** | Authority/capability model, tree scheduler, budgets, event projection, durable run store, control plane — all pure logic that *can* port (they're already DI-heavy `-core` modules), but it's the largest single body of code and depends on the agent loop (Pi) and MCP isolation. Plan as a dedicated phase after the agent runtime exists. |
| **Subagent native helpers (run-store, shell-runner, file-mutator C binaries)** | **Medium (simplification!)** | Become in-process Rust modules: `std::fs` + `nix` (O_NOFOLLOW, fstat checks), `sha2`, `base64`; the sandbox/execsimplify since no IPC boundary is needed. |
| **Computer Use** | **High** | The Rust broker (`native/computer-use-broker`) can be linked/embedded directly — a win. But session/host/controller speak MCP JSON-RPC to the vendored `cua-driver` binary, and safety/grant-ledger logic is elaborate; TCC prompts + code-signature verification need `security-framework`/`core-foundation`. |
| **Git + managed worktrees** | **Medium-High** | Keep argv-execution approach (`tokio::process`) or use `git2` (libgit2) for reads; managed-worktree journals/ownership tokens are pure logic; worktree-remover C binary → in-process `walkdir` + `nix` with the same manifest protocol. 5.2k LOC of careful process/buffer management. |
| **Scheduling (croner)** | **Low-Medium** | `cron`/`croner`-equivalent crates (`cron`, `tokio-cron-scheduler`); store/execution/notification logic is clean `-core` code; notifications via `notify-rust` or `objc2-user-notifications`. |
| **Terminal (node-pty)** | **Medium** | `portable-pty` is the direct equivalent; session ownership/buffering logic ports. |
| **Dictation pill + STT** | **High** | Audio capture moves from renderer getUserMedia to native (`cpal` or `coreaudio`); sherpa-onnx has community Rust bindings (`sherpa-rs`) — verify Parakeet TDT support; paste-into-focused-app needs Accessibility APIs (`core-foundation`/`accessibility` crates or CGEvent). Cloud transcription is plain `reqwest`. |
| **Foundation Models helper** | **Medium** | Keep the Swift helper + file-exchange protocol unchanged (it works, signed), or rewrite with `objc2-foundation-models`-style FFI once available. Protocol is versioned JSON — trivial to keep. |
| **App updater** | **Medium** | electron-updater → Sparkle (via `sparkle` bindings) or a custom `reqwest`+sig-check flow; state machine is simple. |
| **Global shortcuts/menus** | **Low-Medium** | `global-hotkey` crate or CGEvent taps; menus via GPUI/`objc2-app-kit`. Transactional rollback logic ports. |
| **Usage/telemetry store** | **Low** | Aggregate JSON; trivial. |
| **Profile/share** | **Low** | `id -F` exec + `objc2-app-kit` NSSharingServicePicker. |
| **Dev log** | **Low** | `tracing` + rolling file appender. |

### Cross-cutting porting guidance

1. **The `-core` convention is the migration map.** Every `-core.ts` is Electron-free with injected dependencies — port those first as pure Rust crates with trait-based DI, then write thin GPUI/Tokio bindings. Tests (`tsx --test`) describe exact expected behavior and can be transliterated to `cargo test`.
2. **Ownership/epoch pattern must survive.** `RendererDocumentOwner` (invalidate-on-navigate/destroy) underpins generation, approvals, terminals, computer-use, and settings writes. Model it as a GPUI entity generation counter + `async` cancellation token.
3. **Async runtime:** `tokio` throughout (process spawning, timeouts, serialized mutation queues as `mpsc` actor tasks). The many "mutationTail" promise chains map to per-store actor mailboxes.
4. **Serialization:** all IPC/persistence is JSON → `serde`/`serde_json`; MCP tool schemas are raw JSON Schema → `serde_json::Value` + `schemars` where typed.
5. **Suggested crate shortlist:** `tokio`, `reqwest` (rustls), `eventsource-stream`, `serde`, `serde_json`, `schemars`, `keyring`/`security-framework`, `rusqlite` (only if you consolidate JSON stores — not required), `notify`, `portable-pty`, `cron`, `oauth2`, `axum` (loopback), `rmcp`, `sha2`, `base64`, `walkdir`, `nix`, `objc2-*`/`core-foundation` (macOS integration), `cpal` (audio), `tracing`, `tempfile`, `uuid`, `regex`/`regex-automata` (RE2 semantics — keep ReDoS safety).
6. **Biggest unknowns to spike first:** (a) Pi replacement — agent loop + provider transports; (b) sherpa-onnx Rust bindings maturity; (c) cua-driver session protocol from Rust (it's MCP-over-stdio — `rmcp` may just work); (d) GPUI window behaviors for the pill (all-workspaces + non-focusable).
