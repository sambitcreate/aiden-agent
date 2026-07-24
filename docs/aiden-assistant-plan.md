# Aiden — Proactive In-App Assistant Plan

Status: draft plan (no code yet). Date: 2026-07-23.

## Vision

"Aiden" is a standalone, compact assistant chat window (inspired by the ChatGPT
desktop compact window) that lives alongside the main app. It is an assistant
*about the app and the user's work*, not a general coding chat:

- Chat with the user about the app — answer questions, explain settings.
- Read and change app settings/config via tools (with approval for mutations).
- Proactively nudge the user:
  - uncommitted changes in workspace projects,
  - projects not touched in a while,
  - notable file changes in watched projects,
  - settings/config drift and reminders the user asked for.
- Surface nudges as macOS notifications and as messages in the assistant chat;
  replying to a nudge continues the conversation.

Proactivity patterns are borrowed from hermes-agent (Nous Research), adapted to
an in-app Electron context. Key hermes ideas adopted: `[SILENT]` contract with a
strict parser, consent-first suggestion store with permanent dismiss latching,
mechanical-collector/judgment-LLM split, idle gating, first-run deferral,
fail-closed unattended runs, and no recursive self-scheduling.

## Relationship to existing plans

Scheduled Tasks is implemented through Phase 4; its original plan remains
frozen in `docs/scheduled-tasks-plan.md`. The shipped implementation establishes
the `croner` dependency, main-owned lifecycle and shutdown barriers, macOS
`Notification` delivery, dedicated task chats, usage attribution, and the
`schedule:` IPC surface. Aiden should **reuse those proven boundaries without
turning private assistant polling into hidden user schedules**:

- Use the same main-owned notification, navigation, cancellation, shutdown, and
  dedicated-chat patterns.
- Reuse `croner` for the assistant ticker, but keep assistant state and cadence
  separate from user-authored `ScheduledTask` records and `/scheduled`.
- Preserve the scheduler's fail-closed unattended-execution rules: no recursive
  scheduling, no silent provider fallback, and no work after permission
  revocation or shutdown.

## UX

### Assistant window

- New frameless compact window modeled on `main/windows/pill-window.ts`, but
  focusable, closable, and resizable (closer to ChatGPT's compact window than
  the dictation pill): roughly 400×640, `titleBarStyle: hidden`, transparent +
  vibrancy, `alwaysOnTop` default off (a setting can enable it).
- Content (matching the reference screenshot):
  - Header: "Aiden" title, expand-to-main-window button, close/minimize.
  - Chat transcript + compact composer (reuse pieces of
    `renderer/components/composer.tsx`; no attachments/Computer Use in v1).
  - "Recent" section listing recent assistant threads; each nudge thread is
    continuable.
  - Empty state with 2–3 suggested prompts ("Any uncommitted changes?",
    "What did I change today?", "Summarize my settings").
- Entry points: menu bar/tray item, a global hotkey (third registration in
  `main/services/shortcut.ts`, e.g. ⌘⌥A), a sidebar affordance in the main
  window, and clicking a nudge notification.
- UI conventions: semantic tokens only (`renderer/styles.css`,
  `renderer/shared/appearance.ts`), entry mirrors `renderer/pill/main.tsx`
  (imports `styles.css`, calls `applyCachedAppearance()`), review
  `docs/chatgpt-desktop-ui-inspiration.md` + specimen HTML before building.

### Settings section

New "Aiden" section in Settings (group "Agent"), following the established
4-touch-point pattern:

1. add id `assistant` to `SETTINGS_SECTIONS` in `renderer/lib/settings-section.ts`,
2. `NAV` + `CONTENT` entries in `renderer/main/settings-view.tsx`,
3. new `renderer/components/settings/assistant-settings.tsx`,
4. whitelist the new keys in the `settings:set` handler
   (`main/handlers/providers.ts`) and extend `AppSettings`
   (`main/services/types.ts`).

Settings (all under a nested `assistant?: AssistantConfig`):

- `enabled` (master switch, default off — proactivity is opt-in)
- `hotkeyEnabled` / `hotkeyAccelerator`
- Model: reuse `lastProviderId/lastModel` by default; optional override pins
  (`providerId`, `model`) so unattended runs never silently follow a global
  switch (hermes fail-closed pattern)
- Signal toggles: `watchUncommitted`, `watchUntouchedProjects`,
  `watchFileChanges`, `watchConfigChanges`
- Cadence: `pollIntervalMinutes` (default 30), `untouchedThresholdDays`
  (default 14)
- Anti-spam: `quietHoursEnabled` + start/end, `maxNudgesPerDay` (default 5)
- `fileWatchEnabled` (off by default; see dependency decision below)
- Permission posture for settings mutations: reuse workspace-style
  `"full" | "ask" | "none"`, default `"ask"`

## Architecture

### New window plumbing (3 build touch points + window module)

1. `vite.config.ts` — third `rollupOptions.input` (pattern: `pill:` entry).
2. Root `assistant.html` (pattern: `pill.html` — CSP meta + script entry).
3. `scripts/build-electron.mjs` — esbuild entry for
   `renderer/preload-assistant.ts` → `build/preload/preload-assistant.cjs`.
4. `main/windows/assistant-window.ts` — modeled on `pill-window.ts`:
   module-level singleton + loading promise, `setWindowOpenHandler` deny,
   `will-navigate` lockdown, `showInactive()`/hide, show-or-focus helper like
   `showMainWindow()` (`main/index.ts`). Reuse the sender-validation pattern
   from `main/windows/pill-window-security.ts` for privileged channels.
5. `renderer/preload-assistant-channels.ts` + test (pattern:
   `pill-preload-channels.ts` + its test) — exact channel names, not prefixes:
   a subset of `chat:*` (start/cancel/deltas), `chats:list/get`,
   `settings:get`, `assistant:*` invoke + notification channels.
6. `main/handlers/ipc-contract.test.ts` picks the new allowlist up — add
   channels there or the contract test fails.

### Chat and generation

- Assistant threads are plain `Chat`s via `chatStore`
  (`main/services/chat-store-core.ts`), kept in a dedicated workspace id
  (e.g. reserved `"assistant"`) so they don't clutter the main sidebar; the
  assistant window lists only its own threads.
- Streaming reuses `startGeneration` (`renderer/lib/ipc.ts`) and the
  `chat:delta/done/...` channels. Generation ownership
  (`rendererDocumentOwner`) works naturally: the assistant window's document
  owns its generations. One thing to verify: `chat:start` currently requires
  the "active application document" — confirm the assistant document passes
  this check or extend it deliberately.
- System prompt: `buildSystemPrompt` (`main/services/llm-client.ts`) is
  workspace-hardcoded. Add a params-driven variant (e.g.
  `ChatStartParams.mode: "assistant"`) that builds the Aiden persona: what the
  app is, what settings exist, what signals it watches, how to use its tools,
  and the `[SILENT]` contract when running unattended.

### Assistant tools

New tools registered in `buildAgentTools` (`main/services/tools.ts`),
gated to assistant mode:

- `get_settings` — returns `configStore.getSettings()` (redacted; no secrets).
- `set_setting` — patch via `configStore.setSettings`; field whitelist shared
  with the `settings:set` handler; routed through `ToolApprovalCoordinator`
  (`main/services/tool-approval.ts`) so mutations ask in `"ask"` mode. Never
  touches `secrets.ts` (API keys stay out of the assistant's reach in v1).
- `list_projects` — workspaces with `updatedAt`, `gitInfo` summary
  (uncommitted, ahead/behind, branch).
- `get_project_status` — deeper `gitInfo`/`gitDiff --stat` for one workspace.
- `dismiss_nudge` / `snooze_nudge` — writes to the nudge store (below).
- `remember` — small assistant-scoped memory file (facts the user asks Aiden
  to remember), stored as JSON in userData.

Out of scope for v1: changing provider keys, MCP servers, skills; running
arbitrary shell; Computer Use.

### Proactive engine (`main/services/assistant/`)

```
main/services/assistant/
  ticker.ts          — croner-backed interval loop (default 30 min)
  signals.ts         — mechanical collectors (no LLM)
  nudge-store.ts     — DataStore<NudgeRecord[]> (<userData>/assistant-nudges.json)
  decide.ts          — builds the decision prompt, runs the LLM, parses [SILENT]
  deliver.ts         — Notification + broadcast + chat thread mirroring
```

**Signal collectors (mechanical, deterministic — hermes "script does the
mechanical work" pattern):**

- *Uncommitted changes*: poll `configStore.listWorkspaces()` → `gitInfo()`
  (`main/services/git.ts`; `GitInfo.uncommitted` already exists, argv-only,
  cached). Emit candidates like `{ workspace, uncommitted: 12, ahead: 2 }`.
- *Untouched projects*: `Workspace.updatedAt` older than
  `untouchedThresholdDays`.
- *Config changes*: diff `getSettings()` snapshot vs. last-seen snapshot
  (stored in the nudge store); surface meaningful diffs only (e.g. provider
  removed, defaults changed).
- *File changes* (optional, off by default): no watcher exists today — no
  chokidar, no fs.watch. v1: skip real-time watching; the git poll covers the
  honest version of this. If real watching is wanted later, decide between
  adding `chokidar` (dependency decision — the project favors zero-dep,
  argv-only, bounded operations) or a careful bounded `fs.watch`. Do not bolt
  on silently.

**Decision (judgment LLM — hermes classify pattern):**

- Each tick collects candidates, filters out latched/dismissed ones locally,
  and only calls the model if candidates remain.
- One cheap batched call: candidates as JSON + user criteria → per-candidate
  urgency 0–10; only ≥ threshold (default 7) becomes a nudge. Model slot:
  assistant-pinned model or the user's current model; if the pin is missing/
  invalid, skip the run and surface a one-line alert (fail-closed, never spend
  silently).
- `[SILENT]` contract for open-ended assistant runs: parse silence strictly
  (whole response, first line, or last line only — never substring; hermes
  regression history shows substring matching both leaks and over-swallows).

**Anti-spam (improving on hermes gaps):**

- `NudgeRecord`: `{ id, dedupKey, kind, title, body, status:
  pending|delivered|dismissed|snoozed, snoozeUntil?, createdAt, chatId? }`.
- Dismissed latches forever by `dedupKey` (records retained — they are the
  dedup memory). Snooze sets `snoozeUntil`.
- Caps: max 5 pending undelivered nudges (backlog full → drop new, never a nag
  wall); `maxNudgesPerDay`; quiet hours suppress *delivery* (records stay
  pending and deliver when quiet hours end).
- Idle gating: skip LLM decision calls while the user is actively in a
  generation; first-run deferral — on first enable, seed `lastRunAt = now` and
  wait one full interval so enabling never triggers an immediate barrage.
- Ticker resilience: per-tick try/catch so one bad tick never kills the loop;
  record `lastTickAt` / `lastSuccessAt` in the store (hermes heartbeat split)
  so settings UI can show "watching: healthy/degraded".

**Delivery:**

- macOS `new Notification({ title, body })` from main, following the shipped
  Scheduled Tasks delivery and navigation boundary; click → show/focus the
  assistant window and open the nudge's thread.
- Broadcast `assistant:nudge` (add to `NOTIFICATION_CHANNELS` in
  `renderer/preload-channels.ts` + contract test) so the main window can
  show a subtle badge/toast.
- Every delivered nudge is mirrored as a message in a dedicated assistant
  chat thread (continuable — replying continues with the nudge context
  seeded), mirroring hermes `_maybe_mirror_cron_delivery`.

**Safety rails (from hermes):**

- Assistant-initiated runs cannot create new proactive jobs or change the
  ticker's own cadence (no recursive self-scheduling).
- Settings mutations through tools always respect the approval posture;
  destructive or identity-affecting fields (provider removal, key material)
  are excluded from tool reach entirely in v1.
- Decision-call failures alert once (not silently swallow), then back off.

### IPC surface (new)

- Invoke: `assistant:toggle-window`, `assistant:get-state` (ticker health,
  pending nudges), `assistant:dismiss-nudge`, `assistant:snooze-nudge`,
  `assistant:set-config`.
- Notifications: `assistant:nudge`, `assistant:state-changed`.
- Reuse existing: `chat:*` subset, `chats:list/get`, `settings:get`,
  `app:navigate`-style focus broadcast for notification clicks.

## Phasing

- **Phase 1 — Window + chat**: assistant window plumbing, preload allowlist,
  contract-test updates, assistant-mode system prompt, dedicated workspace for
  threads, hotkey + entry points. Manual chat only, no tools, no proactivity.
- **Phase 2 — Settings tools + settings section**: `get_settings` /
  `set_setting` with approvals, `list_projects` / `get_project_status`,
  Assistant settings UI, `AssistantConfig` in `AppSettings` + whitelist.
- **Phase 3 — Proactivity**: ticker, uncommitted + untouched + config-diff
  collectors, nudge store with dismiss/snooze latching, decision call with
  `[SILENT]` + urgency threshold, Notification + broadcast + thread mirroring,
  quiet hours + daily cap + first-run deferral, ticker health surface.
- **Phase 4 (optional)**: real file watching (dependency decision: chokidar
  vs. bounded fs.watch), assistant memory tool, urgency criteria
  customization, tray presence.

## Testing

- Unit (colocated `*.test.ts`, `tsx --test`): nudge-store latching/dedup,
  `[SILENT]` parser edge cases (mid-sentence quotes must deliver), quiet-hours
  and daily-cap logic, settings diffing, schedule/interval math.
- Contract: extend `main/handlers/ipc-contract.test.ts` expectations; new
  `renderer/preload-assistant-channels.test.ts`.
- Manual acceptance: enable assistant → no nudge before first interval
  elapses; make uncommitted change in a workspace → nudge within one
  interval; dismiss → never re-nudged for same dedupKey; notification click →
  assistant window opens on the right thread; settings change via chat in
  "ask" mode → approval prompt appears.

## Open questions

1. Should the assistant share the user's current chat model by default, or
   require an explicit pin before proactivity can run? (Plan assumes:
   default to current, but block unattended runs on a broken pin.)
2. Real-time file watching: worth the `chokidar` dependency, or is the git
   poll cadence enough for the honest feature? (Plan defers to Phase 4.)
3. Menu-bar tray presence for Aiden, or window-only?
4. Should nudges appear in the main window sidebar too, or only in the
   assistant window + notifications?
