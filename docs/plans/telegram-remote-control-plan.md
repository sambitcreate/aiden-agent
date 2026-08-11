# Telegram Remote Control Plan

Status: implemented on 2026-08-11; Phases 0–5 complete; Phase 6 (onboarding bento) deferred pending a 1024×1024 PNG asset
Date: 2026-08-11
UI reference: ChatGPT/Codex settings surfaces and Aiden's existing settings tokens; the Telegram operator UI is provided by the ported `pi-telegram` adapter (menus rendered as Telegram inline keyboards, not Aiden UI).
License basis: `pi-telegram` is MIT-licensed (a fork of `badlogic/pi-telegram`). Vendor with attribution.

Source basis: the `pi-telegram` TypeScript adapter (`https://github.com/llblab/pi-telegram`, MIT) built as an extension for the Earendil Works Pi coding agent (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`); the Hermes Agent messaging gateway (`/Users/sambitbiswas/projects/opp/hermes-agent`: `gateway/platforms/`, `gateway/run.py`, `tools/send_message_tool.py`) as a second reference for behavior; and current Aiden source — in particular the already-shipped headless-turn precedent in `main/services/schedule-execution.ts`.

## Verdict

`pi-telegram` is an excellent fit and we **port** it into Aiden; we do **not** install it. It is an extension for the Pi coding agent, and Aiden does not expose Pi's extension loader (repo grep for `pi-telegram`, `.pi/agent`, `pi install`, `agent_settled` returns zero) — even though Aiden's agent core is itself the Pi runtime (it embeds `@earendil-works/pi-coding-agent` behind `llmClient`, per the root README). Because that is the same runtime `pi-telegram` was built against, its event vocabulary maps onto primitives Aiden already uses internally; we re-host the adapter as a library wired to `llmClient`, not through Pi's extension loader. The port is low-risk in the place that matters: `pi-telegram`'s host-agent contract is tiny, and Aiden already implements that exact contract headlessly today through the scheduled-tasks pipeline (`main/services/schedule-execution.ts` runs full agent turns with no `BrowserWindow`).

The build reduces to: keep `pi-telegram`'s Telegram layer verbatim (with attribution), drop its Pi-SDK boundary and Threaded-Mode bus, and write one thin Aiden shim that exposes `pi-telegram`'s expected host ports (`sendUserMessage`, idle/pending gates, lifecycle events) against Aiden's `llmClient` + the `createBackgroundOwner` pattern.

Hermes is a secondary reference for behavior (long-poll transport, owner allowlists, queue discipline). `pi-telegram` is the code basis.

## Confirmed product decisions (frozen)

1. **Port, not install.** Vendor `pi-telegram`'s Telegram layer under `main/services/telegram/`; replace its Pi-SDK boundary with an Aiden shim. MIT license retained with attribution.
2. **Full unattended authority after enablement.** Once the user enables Telegram in Settings and creates/pairs the bot, Telegram-originated turns run with `permission: "full"` and an unattended mode (no approval surface). This matches the existing scheduled-tasks trust boundary. Pairing is restricted to a single configured owner.
3. **One persistent chat.** A single Aiden chat backs the Telegram surface (`chatStore.create({ id: "telegram-<ownerId>", ... })` on first inbound), reused across turns. No per-thread or multi-session binding in v1.
4. **Transport = Telegram long-polling.** Outbound `getUpdates` only — no inbound HTTP server, no tray, no public URL. Works behind NAT and while the Aiden window is closed (Aiden already runs window-less on macOS).
5. **Owner pairing.** First user to `/start` the bot becomes the allowed owner (`allowedUserId`); all other users are ignored, mirroring `pi-telegram`'s built-in flow.
6. **Settings-gated enablement.** The service starts polling only when Telegram is enabled in Settings and a bot token is present; otherwise it stays dormant.

## What `pi-telegram` provides (reference)

- **Transport**: Telegram Bot API long-polling (`getUpdates`), single-user pairing, offset persistence after successful handling.
- **Inbound turn flow**: poll → filter to paired user → coalesce media groups / split long text → download files → build a `PendingTelegramTurn` → enqueue in a local queue → dispatch when idle gates pass.
- **Queue + dispatch safety**: separate `control` / `priority` / `default` lanes; dispatch requires no active turn, no pending dispatch, and idle host.
- **Outbound**: streaming draft previews (Rich/HTML), final Markdown reply delivery, file/artifact delivery, voice, inline keyboards, `/start` operator menu, status/queue controls.
- **Config**: `~/.pi/agent/telegram.json` (profiles, handlers, assistant/voice/time/threads settings). Aiden will store this under its own config roots instead.
- **Host contract** (the only Pi-coupled surface): `ExtensionAPI.sendUserMessage(content)`, `ctx.isIdle()`, `ctx.hasPendingMessages()`, lifecycle events (`agent_start` / `agent_end` / `agent_settled`, `AssistantMessageEvent`, tool execution events), and `setModel` / `compact` / `exec` controls. All defined in `lib/pi.ts`.

## What Aiden adds

- The bridge runs inside Electron main as a module-scoped service singleton (mirroring `geminiLiveService` / `scheduleService`), started at the tail of `app.whenReady()` and torn down on quit.
- Turn injection reuses the proven headless pattern: synthetic `ChatGenerationOwner` + `llmClient.start` + `await terminal`, exactly as scheduled LLM tasks already do.
- Credentials use `safeStorage` (macOS Keychain); enable/owner state uses `configStore` settings — copying the existing Exa web-search settings template.
- One persistent Aiden chat per owner instead of Pi's active-session binding.

## Contract mapping (the heart of the port)

| `pi-telegram` host API | Aiden primitive (verified) | Source |
| --- | --- | --- |
| `ExtensionAPI.sendUserMessage(content)` | `chatStore.appendMessage` → `llmClient.beginChatTurn` → `llmClient.start(streamId, params, bgOwner, opts)` → `await bgOwner.terminal` | `schedule-execution.ts:32-61, 291-368`; `llm-client.ts:750` |
| `ctx.isIdle()` | `!llmClient.isChatBusy(chatId)` | `llm-client.ts:1907` |
| `ctx.hasPendingMessages()` / turn admission | `llmClient.beginChatTurn(chatId, turnId, ownerId)` returns null while a turn is in flight | `llm-client.ts:2011` |
| `agent_start` / `agent_end` | `llmClient.start(...)` resolves; `bgOwner.terminal` settles on `chat:done` / `chat:error` | `schedule-execution.ts:49, 344` |
| `agent_settled` | `bgOwner.terminal` (terminal state) — **not** the `chats:settled` broadcast | broadcast only reaches windows |
| `AssistantMessageEvent` (streaming preview) | capture `chat:delta` in the synthetic owner's `send()` | currently ignored at `:49`; extend the switch |
| Tool execution events | `chat:tool` phase events via `owner.send` | optional; deferred to v2 activity mode |
| `ctx.cwd` / session binding | one persistent chat via `chatStore.create({ id: "telegram-<ownerId>" })` | `schedule-execution.ts:129` |
| `api.exec` / `setModel` / `compact` | deferred (v2) | — |

**Mode/permission (load-bearing):** Telegram turns use main-only unattended modes (`assistant-unattended` / `assistant-automation`) with `permission: "full"`, identical to the scheduled path, so phone-originated turns never block on a GUI approval. Headless code must use `bgOwner.terminal` + `llmClient.waitForChatIdle`; it must **not** rely on `ipcMain.broadcast` (`chats:settled` and friends only reach `BrowserWindow.getAllWindows()`).

## Architecture and files

```
main/services/telegram/                 # NEW — ported pi-telegram layer + Aiden shim
  api/                                  # vendored: Bot API helpers, retries, uploads/downloads
  lib/                                  # vendored host-agnostic domains:
    polling.ts inbound.ts queue.ts      #   receive, prompt intake, queue + dispatch gates
    outbound.ts delivery.ts             #   reply/file delivery, chunking
    preview.ts replies.ts rendering.ts  #   streaming drafts, final reply, Markdown/HTML
    config.ts setup.ts commands.ts menu.ts sections.ts   # config, pairing, menus (trimmed)
    aiden-pi-shim.ts                    # NEW — host ports backed by llmClient (replaces lib/pi.ts)
    aiden-lifecycle.ts                  # NEW — start/stop wiring (replaces lib/bindings.ts + lifecycle.ts)
  service.ts                            # TelegramService singleton (start/stop/status), mirrors gemini-live
  service-main.ts                       # production singleton + DI (token store, connector factory)
  telegram-config.ts                    # config read/write under Aiden config roots (replaces ~/.pi/agent/telegram.json)
main/handlers/
  telegram.ts                           # NEW — telegram:get/setKey/setEnabled/setAllowedUser/connect/disconnect/status
  index.ts                              # register registerTelegramHandlers()
renderer/
  preload-channels.ts                   # + "telegram:" INVOKE_PREFIX; + any new notification channel
  lib/ipc.ts                            # + telegramApi
  lib/queries.ts                        # + useTelegramSettings, useTelegramStatus
  components/settings/telegram-settings.tsx   # NEW — mirrors web-search-settings.tsx
  shared/settings-section.ts            # + Telegram nav entry
  main/settings-view.tsx                # + route binding
  assets/onboarding/telegram.png        # NEW — 1024x1024 transparent PNG
  (onboarding bento gallery data)       # + Telegram tile
```

Dropped from the vendor: `lib/pi.ts`, `lib/bindings.ts`, `lib/lifecycle.ts`, `lib/prompts.ts` (Pi-SDK boundary — replaced by the shim); the Threaded-Mode multi-instance bus (`bus*`, `ownership`, `target`, `thread-reconciler`, `sync`, `threads`); and companion-extension platform code (`sections`/`status`/`activity`/`voice` provider registries) — all v2+.

### Service lifecycle (`service.ts`)

- Constructed as `export const telegramService = new TelegramService({...})` in `service-main.ts` (DI: token store via `secrets`, connector factory).
- `start()` in `app.whenReady()` after `createMainWindow()` (next to `scheduleService.start()`). Idempotent; no-op unless enabled + token present.
- `stopAndSettle()` in `shutdownAndQuit` (async settle, unref'd timeout); `stop()` in `cleanupApplication` — mirroring `geminiLiveService` and `scheduleService`.
- Polling loop runs as a long-lived async task in main; offset persisted only after successful handling (pi-telegram rule).

### Turn injection (`lib/aiden-pi-shim.ts`)

`sendUserMessage(content)`:

1. Ensure the persistent chat exists (`chatStore.create` once, reuse).
2. `const bg = createTelegramOwner(streamId)` — clone `createBackgroundOwner`; extend `send()` to also surface `chat:delta` for previews.
3. `const turn = llmClient.beginChatTurn(chatId, streamId, bg.owner.documentId)` — if null, the bridge queues the prompt (busy).
4. `chatStore.appendMessage(chatId, { role: "user", content })`.
5. `await llmClient.start(streamId, { chatId, workspaceId, providerId, model, mode: "assistant-unattended", messages: [user] }, bg.owner, { permission: "full", usageSource: "telegram", turnId: streamId })`.
6. `const terminal = await bg.terminal` → `terminal.content` is the final assistant text; deliver via the ported outbound layer.
7. `finally { turn.release(); bg.destroy(); }`.

## Config and secrets (copy the Exa web-search template)

- **Bot token** → `main/services/secrets.ts` (`setKey` / `getKeyStrict`): `safeStorage` (Keychain) → base64 in `<userData>/provider-keys.json`.
- **Enable flag + `allowedUserId` + runtime `lastUpdateId`** → `configStore.setSettings` into local `<userData>/settings.json` (`AppSettings` additions) or a dedicated `<userData>/telegram.json` via a `DataStore`.
- **IPC handlers** (`main/handlers/telegram.ts`): `telegram:get` → `{ enabled, hasToken, allowedUserId, status }`; `telegram:setKey`; `telegram:setEnabled`; `telegram:setAllowedUser`; `telegram:connect`; `telegram:disconnect`; `telegram:status`. Modeled on the `exa:*` block in `main/handlers/phase2.ts`.

### Settings added to `AppSettings`

```ts
telegramEnabled?: boolean;       // default false; gates polling
telegramAllowedUserId?: number;  // paired owner; undefined until first /start
```

`lastUpdateId` / bot identity stays in a runtime store, not `AppSettings`.

## UI plan

A **Telegram** section under the **Agent** (or Integrations) nav group, mirroring `web-search-settings.tsx`:

- Enable `Switch` (off until the user opts in).
- Bot token input (password field) + Save — stored via `secrets`; never returned to the renderer.
- Status row: connected / polling / idle, paired owner id, last error.
- "How to connect" steps: create a bot via @BotFather, paste the token, enable, then `/start` the bot from Telegram to pair.
- Disconnect + re-pair controls.

There is no Aiden-side chat surface for Telegram; the persistent backing chat is reachable from the normal chat list once created.

## Onboarding (per AGENTS.md)

A durable new capability requires a feature-tour bento tile and a `1024x1024` transparent PNG in `renderer/assets/onboarding/`. Add a "Telegram remote control" tile to the data-driven bento gallery, keep it cohesive with Aiden's visual language, and cover the asset contract in the onboarding test.

## Security model

| Concern | Mitigation |
| --- | --- |
| No live approver | `permission: "full"` + unattended mode; no `"ask"` path (same as scheduled tasks). Documented in Settings before enable. |
| Unauthorized users | Single paired owner (`allowedUserId`); all others ignored; pairing only via `/start` after enablement. |
| Credential exposure | Bot token in `safeStorage`/Keychain, never sent to renderer (`telegram:get` returns `hasToken`, not the token). |
| Token in Telegram webhook URL | N/A — long-polling only, no inbound webhook URL, no password-in-URL (unlike Hermes BlueBubbles). |
| Always-on surface | Polling starts only when enabled + token present; `disconnect` and disable stop it immediately. |
| Headless broadcast pitfall | Use `bgOwner.terminal` + `waitForChatIdle`; never `ipcMain.broadcast` for control flow. |
| License/attribution | MIT; retain `pi-telegram` / `badlogic/pi-telegram` attribution in vendored files and NOTICE. |

## Implementation phases

### Phase 0 — Vendor the Telegram layer

1. Copy `pi-telegram` `api/` and the host-agnostic `lib/` domains into `main/services/telegram/` with MIT attribution headers.
2. Delete Pi-SDK + Threaded-Mode + companion-platform files; strip `@earendil-works/*` imports.
3. Re-point config to Aiden roots; stub the host ports so it compiles.

Acceptance: the vendored tree type-checks in isolation with no Pi dependencies.

### Phase 1 — Aiden shim + persistent chat

1. `lib/aiden-pi-shim.ts`: `createTelegramOwner` (extends `createBackgroundOwner` to capture `chat:delta`), `sendUserMessage`, idle/pending gates, lifecycle event mapping.
2. `lib/aiden-lifecycle.ts`: start/stop registration.
3. Persistent chat creation (`telegram-<ownerId>`).
4. Wire `sendUserMessage` → ported inbound queue → ported outbound final-reply delivery.

Acceptance: in a dev build, an injected prompt produces a final reply string delivered through the outbound layer (mock transport).

### Phase 2 — Service lifecycle

1. `service.ts` + `service-main.ts` singleton; polling start/stop/status.
2. Start in `whenReady`; `stopAndSettle`/`stop` in the two shutdown paths.
3. Owner pairing (`/start` → `allowedUserId`).

Acceptance: with a real bot token, `/start` pairs; a text message from the owner triggers a headless Aiden turn and a Telegram reply; works with the Aiden window closed.

### Phase 3 — Config, secrets, IPC contract

1. `secrets.ts` token storage; `AppSettings` fields; `telegram-config.ts` runtime store.
2. `main/handlers/telegram.ts` handlers; register in `handlers/index.ts`.
3. `renderer/preload-channels.ts` `telegram:` prefix + any notification channel.
4. Satisfy `main/handlers/ipc-contract.test.ts` (prefix + broadcast allowlists).

Acceptance: enable/token/owner flow works end-to-end from Settings; `npm run test` passes including the IPC-contract guard.

### Phase 4 — Settings UI

1. `telegram-settings.tsx` mirroring `web-search-settings.tsx`.
2. `lib/ipc.ts` `telegramApi`, `lib/queries.ts` hooks, nav + route binding.

Acceptance: full enable/pair/disable flow from the UI; status reflects polling state.

### Phase 5 — Queue + hardening

1. Port the queue lanes and dispatch gates; verify queued messages wait while busy and dispatch on idle.
2. Markdown reply chunking at Telegram limits; basic `/start` menu + `/stop` (abort).
3. Usage accounting (`usageSource: "telegram"`).
4. Full verification: `npm run type-check`, `npm run lint`, `npm run test`, `npm run build`, packaged smoke.

### Phase 6 — Onboarding

1. Bento tile + `1024x1024` PNG; data-driven gallery entry; onboarding test coverage.

## Deferred (not v1)

Threaded Mode + multi-instance bus; compaction menu; activity/thinking/tool rendering; voice in/out; prompt-template commands; the `telegram_attach` / `telegram_message` / `telegram_help` agent tools; streaming Rich draft previews (`sendRichMessageDraft`); model/thinking switching from Telegram; companion-extension platform (sections/status/activity/voice provider registries); guest mode.

## Risks

- **Full unattended authority from a phone** is the one real security call. It matches the scheduled-tasks boundary but grants the paired owner silent mutating-tool access. Mitigated by single-owner pairing + explicit Settings opt-in; still worth a one-line warning in the UI.
- **Hidden Pi assumptions** in host-agnostic-looking `lib/` files may surface during Phase 0 (sized from the architecture/public-API docs, not a file-by-file audit of all ~100 modules).
- **Delta-capture extension** to `createBackgroundOwner`'s `send()` is a real code change, not a copy, if streaming previews ship in v1 (otherwise defer previews to v2 and keep `send()` as-is).
- **Bundling**: the vendored TypeScript must esbuild cleanly into the main-process bundle (no native deps; `pi-telegram` is pure TS). Verify in Phase 5 packaged smoke.
- **Chat visibility**: the persistent backing chat is created from main without renderer involvement; emit the existing `chats:metadata-updated` broadcast so the sidebar reflects it.

## Implementation summary (2026-08-11)

Phases 0–5 shipped as a clean-slate port on branch `feature/text-control`.
Rather than vendoring pi-telegram's 57-file, ~1.5 MB tree (deeply entangled
with Threaded-Mode, Pi-SDK, and companion-extension code), we wrote a focused
implementation that captures the same behaviour with MIT attribution.

**Files created** (`main/services/telegram/`):
- `telegram-bot-api.ts` — Bot API HTTP client (getUpdates, sendMessage, getMe, etc.)
- `telegram-markdown.ts` — Markdown → Telegram HTML conversion + 4096-char chunking
- `telegram-queue.ts` — control/priority/default lane queue with dispatch gates
- `telegram-turn.ts` — headless turn injection shim (createTelegramBackgroundOwner, sendTelegramTurn)
- `telegram-config.ts` — runtime config store (lastUpdateId via DataStore, settings bridge)
- `telegram-service-core.ts` — pure service factory (polling loop, pairing, dispatch, delivery)
- `telegram-service.ts` — production singleton with DI wiring

**Files modified**:
- `main/handlers/telegram.ts` — IPC handlers (telegram:get/setKey/setEnabled/connect/disconnect/resetPairing)
- `main/handlers/index.ts` — registerTelegramHandlers
- `main/index.ts` — lifecycle anchors (start/stop/stopAndSettle)
- `main/services/types.ts` — AppSettings: telegramEnabled, telegramAllowedUserId
- `main/services/usage-store-core.ts` — UsageRequestSource: "telegram"
- `main/services/portable-config-core.ts` — keepBoolean: telegramEnabled
- `renderer/preload-channels.ts` — INVOKE_PREFIXES: "telegram:"
- `renderer/lib/ipc.ts` — telegramApi
- `renderer/lib/queries.ts` — queryKeys.telegram, useTelegramSettings
- `renderer/components/settings/telegram-settings.tsx` — settings UI
- `renderer/shared/settings-section.ts` — nav entry
- `renderer/main/settings-view.tsx` — NAV_ICONS + CONTENT binding
- `package.json` — test:telegram script
- `resources/telegram/LICENSE.pi-telegram.md` — MIT attribution

**Tests** (50 passing): bot API (10), turn injection (9), queue (10), markdown (10), service core (11).

**Phase 6 (onboarding)** deferred: requires a 1024×1024 transparent PNG asset for the bento gallery tile.
