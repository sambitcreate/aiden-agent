# Bots Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Aiden Bots as Grok-style, mom-simple single-thread chats on desktop, iOS and Android, with per-Bot Pi Durable sessions, explicit Resume, per-Bot routines and consent-first connection cards.

**Architecture:** Each Bot gets its own Pi Durable harness (`<profile>/bots/<botId>/session.sqlite`), hosted in Electron main behind one profile lock and driven by an `aiden-bot` extension that reuses Aiden's existing tools, policy and approvals. The renderer and native clients project that conversation through IPC/Remote. The UI collapses to List → Chat → Profile, with everything else behind ••• → Advanced.

**Tech Stack:** Electron + React/TanStack (renderer), Node `node:sqlite`, `@earendil-works/pi-durable@1.0.3` + `@earendil-works/chord@1.0.3`, pi-ai 1.0.3 faux provider for tests, `tsx --test`, Testing Library, Playwright, SwiftUI/XCTest, Kotlin Compose/JUnit.

**Spec:** `docs/superpowers/specs/2026-10-07-bots-rework-design.md`. Every implementer reads the spec section named by their task before starting.

## Global Constraints

- Pre-1.0: no migrations. Delete legacy Bot conversations/transcripts and removed fields outright.
- Pin `@earendil-works/pi-durable` and `@earendil-works/chord` exactly at `1.0.3`, matching the existing pi-ai/pi-agent-core pins.
- `packages/cli` must never import `main/services/bot-runtime/**`.
- Recovery is explicit: never call `harness.resume()` or `submit` on an interrupted Bot without a user Resume/new-message action.
- Every ingress passes a stable `requestId`: desktop send UUID; Remote request UUID; `tg:<bot>:<chat>:<thread>:<message>`; `routine:<taskId>:<scheduledFireTime>`.
- UI rules from `AGENTS.md`:
  - shared squircle buttons;
  - semantic tokens only;
  - no decorative borders on cards, badges, alerts or choice cards;
  - keep `focus-visible` rings;
  - text inputs get no focus ring;
  - no brain icons;
  - review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` before restyling.
- Copy is plain language: no "Pi", "provider", "workspace", "capability", or "canonical" in default Bot surfaces.
- Delete copy, exact: `Delete {name}? This permanently erases {name}'s chat, memory, instructions, routines, files, and photo. This can't be undone.` Button: `Delete Bot`.
- Interrupted copy, exact: `I got interrupted while working on this.` with `Resume` and `Dismiss`.
- Silent routine token: `[SILENT]`.
- Tests:
  - must be behavioural; no source-grep oracles and no tautologies;
  - register every new test file in the appropriate `package.json` script and CI registry (`scripts/run-ci-tests.mjs`);
  - resolve `test` chain conflicts by union.
- Remote protocol revision: the next number after `main`'s, claimed at merge, with iOS, Android and fixtures updated together.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Delete while a turn is running.** Delete must abort the live submission, close the harness, then remove `bots/<id>/`, with no orphaned scheduler or reopened file. Test lives in Task 1.3.
2. **A routine fires while its Bot is interrupted.** The routine must not resume or dismiss the paused turn. It is recorded as skipped (`status: "skipped", reason: "bot_paused"`) and surfaces nothing. Test lives in Task 4.1.
3. **Resume tapped twice, or by two clients.** The second Resume is an idempotent no-op that returns the current state, with no second provider request. Test lives in Task 1.3 (IPC) and Task 5.3 (Remote).
4. **A second Aiden process or the CLI opens the profile.** The lock is refused with "Bots are open in another Aiden window." Data is not touched. Test lives in Task 1.1.
5. **Creating a Bot with no AI model configured.** Creation succeeds; the chat shows "Needs an AI model" with Set up; no turn and no self-intro is attempted until a model exists. Test lives in Task 2.2 and Task 5.2.

---

## Execution waves and file ownership

Run the tasks inside a wave in parallel, each in its own git worktree branched from this branch. Merge back in task order. A task may only edit files it owns; anything else goes in its report as a request.

| Wave | Task | Owns |
| --- | --- | --- |
| 1 | 1.1–1.3 Durable runtime | `main/services/bot-runtime/**`, `package.json` deps, Bot send path in `main/services/llm-client.ts` / `bot-application-service.ts`, `main/handlers/bots.ts` (runtime and delete channels), `main/services/telegram/**` (Bot ingress/outbox) |
| 1 | 2.1–2.2 Desktop UI | `renderer/main/bots-view.tsx` (rewrite into `renderer/main/bots/*`), `renderer/main/chat-pane.tsx` (Bot mode only), `renderer/components/bot-avatar.tsx`, `bot-face-studio.tsx`, `renderer/shared/bots.ts` avatar types, `main/services/ask-user-question-extension.ts`, `renderer/shared/ask-user-question.ts`, `bot-avatar-generator-core.ts` (delete) |
| 1 | 3.1 iOS UI | `ios/AidenOnTheGo/Features/Bots/**`, Bot parts of `Features/Remote/AidenChatFeature.swift`, `AidenBotChatToolsView.swift`, `AidenProductShellView.swift` (notice gate), `Models/AidenBot.swift`, iOS tests |
| 1 | 3.2 Android UI | `android/.../features/bots/**`, `features/remote/AidenBotChatToolsView.kt`, Bot parts of `features/chat/AidenChatDetailScreen.kt`, `models/AidenBot.kt`, Android tests |
| 1 | 4.1 Routines backend | `main/services/schedule-*`, `scheduled-*`, `main/services/types.ts` (`ScheduledTask`), schedule tool |
| 1 | 5.1 Presets + connections core | new `renderer/shared/bot-presets.ts`, new `renderer/shared/bot-connections.ts`, new `main/services/bot-runtime-tools/suggest-connection.ts`, new `renderer/components/bots/connect-card.tsx`, `connection-chips.tsx` |
| 2 | 1.4 Live projection + desktop wiring | `main/services/bot-runtime/live-projection.ts`, preload channels, `renderer/lib/queries` Bot hooks |
| 2 | 2.3 Desktop integration | `renderer/main/bots/*` (routines, connections, onboarding, live projection), `renderer/components/onboarding-flow.tsx`, onboarding asset |
| 2 | 5.2 Remote contract rev | `main/services/aiden-remote-*` Bot routes, fixtures, iOS and Android DTOs/clients and their consumers for resume/dismiss/routines/connection-requests/presets |
| 3 | 6.1 Docs, memory, final verification | `docs/plans/**`, `.memory/**` |

---

### Task 1.1: Harness host, profile lock, per-Bot storage

**Spec:** §6.1, §6.2, §10.

**Files:**
- Create:
  - `main/services/bot-runtime/profile-lock.ts`
  - `main/services/bot-runtime/harness-host.ts`
  - `main/services/bot-runtime/profile-lock.test.ts`
  - `main/services/bot-runtime/harness-host.test.ts`
  - `main/services/bot-runtime/test-support/kill-harness.mjs` (child process for SIGKILL tests)
- Modify:
  - `package.json` (deps and the `test:bot-runtime` script)
  - CI registry in `scripts/run-ci-tests.mjs`

**Interfaces (Produces):**

```ts
// profile-lock.ts
export type ProfileLockResult =
  | { ok: true; release(): Promise<void> }
  | { ok: false; reason: "held_by_live_process"; pid: number };
export function acquireBotProfileLock(dir: string): Promise<ProfileLockResult>;

// harness-host.ts
export interface BotHarnessHostOptions {
  profileDir: string;                       // <profile>; host uses <profile>/bots/
  buildRegistry(botId: string): Registry;   // from Task 1.2
  models: ModelsOption;                     // pi-durable Harness.open option
  idleCloseMs?: number;                     // default 600_000
  now?: () => number;
}
export interface BotHarnessHost {
  open(botId: string): Promise<{ harness: Harness; conversation: Conversation }>; // root conversation
  interruptedBots(): Promise<Array<{ botId: string; submissionId: string }>>;      // startup scan, never resumes
  close(botId: string): Promise<void>;
  destroy(botId: string): Promise<void>;    // abort live submission, close, rm -rf bots/<id>/
  sweepOrphans(knownBotIds: ReadonlySet<string>): Promise<string[]>;
  shutdown(): Promise<void>;
}
export function createBotHarnessHost(opts: BotHarnessHostOptions): Promise<BotHarnessHost | { unavailable: "held_by_live_process" }>;
```

- [ ] **Step 1:** Add the pinned deps.
  - Run `npm install --save-exact @earendil-works/pi-durable@1.0.3 @earendil-works/chord@1.0.3`.
  - Confirm `npm ls @earendil-works/pi-ai` shows a single 1.0.3.
  - Read `node_modules/@earendil-works/pi-durable/README.md`, `CHANGELOG.md` and its `.d.ts` exports to confirm the names used below (`Harness.open`, `harness.root`, `harness.inspect`, `harness.submission`, `openNodeSqliteStorage` from `@earendil-works/pi-durable/storage/sqlite/node`, `BACKGROUND_CONTEXT`). Record any differences in your report.
- [ ] **Step 2: Failing lock tests.**
  - First `acquireBotProfileLock` succeeds.
  - A second call in another child process returns `{ok:false, reason:"held_by_live_process"}`.
  - A stale lock whose pid is dead (write a lock file with pid 999999) is reclaimed.
  - `release()` removes the file.
- [ ] **Step 3:** Implement `profile-lock.ts`:
  - `fs.open(path, "wx")`;
  - JSON `{pid, startedAt}`;
  - liveness check via `process.kill(pid, 0)`.

  Run `tsx --test main/services/bot-runtime/profile-lock.test.ts` and expect PASS.
- [ ] **Step 4: Failing host tests** using the pi-ai faux provider:
  - (a) `open(botId)` twice returns the same root conversation id across a `close`/reopen.
  - (b) A SIGKILL mid-stream in `kill-harness.mjs` followed by a new host shows `interruptedBots()` containing that bot, and **no provider request is made** by the scan (the faux provider counts calls).
  - (c) `destroy(botId)` during a live slow stream aborts, closes, and leaves no `bots/<id>` directory. The faux provider stops receiving requests. (Review Focus 1)
  - (d) `sweepOrphans` deletes a directory with no known id.
  - (e) A second host in another process gets `{unavailable:"held_by_live_process"}`. (Review Focus 4)
  - (f) A corrupt `session.sqlite` (write garbage) is moved to `session.sqlite.corrupt-<ts>`, and a fresh conversation opens.
- [ ] **Step 5:** Implement `harness-host.ts`:
  - lazy open map;
  - idle timer reset on every open/submit;
  - never call `resume()` or `waitForIdle()` from the scan;
  - corrupt handling as in (f).

  Run `tsx --test main/services/bot-runtime/*.test.ts` and expect PASS.
- [ ] **Step 6:** Add the `test:bot-runtime` script, append it to the root test chain and the CI registry, then commit `feat(bot-runtime): per-Bot pi-durable harness host and profile lock`.

### Task 1.2: `aiden-bot` extension and tool adapter

**Spec:** §6.3.

**Files:**
- Create:
  - `main/services/bot-runtime/tool-adapter.ts`
  - `main/services/bot-runtime/bot-extension.ts`
  - their `*.test.ts` files
- Read:
  - `main/services/llm-client.ts` (Bot turn assembly)
  - `main/services/bot-system-prompt.ts`
  - Bot policy and `protectAdmittedBotTool`
  - the tool-approval coordinator
  - `bot-mcp-inventory.ts`
  - the companion vision tool

**Interfaces:**
- Consumes: `Registry`, `defineExtension`, `defineTool` from pi-durable.
- Produces:

```ts
export function adaptAidenTool(tool: AgentTool, opts: { replay: "safe" | "unsafe" }): DurableTool;
export interface BotExtensionDeps {
  loadBot(botId: string): Promise<BotDefinition>;                 // re-read every turn
  systemSections(bot: BotDefinition): Promise<string[]>;          // base, persona, authority — in this order
  currentTools(bot: BotDefinition): Promise<Array<{ tool: AgentTool; replay: "safe" | "unsafe" }>>;
  checkPolicy(botId: string, toolName: string): Promise<{ allowed: true } | { allowed: false; reason: string }>;
  requestApproval(req: { botId: string; waitId: string; toolCallId: string; summary: string }): Promise<"allow" | "deny">;
  readmit(botId: string): Promise<{ ok: true } | { ok: false; reason: "access_changed" | "bot_missing" }>;
}
export function createBotRegistry(botId: string, deps: BotExtensionDeps): Registry;
```

- [ ] **Step 1: Failing adapter tests.**
  - An adapted tool receives its TypeBox-validated args.
  - `onUpdate` chunks reach `api.output`.
  - Aborting the chord context aborts the `AbortSignal`.
  - The replay flag is preserved.
- [ ] **Step 2:** Implement the adapter. Run the tests and expect PASS.
- [ ] **Step 3: Failing extension tests** with the faux provider and a real harness on a temp dir:
  - (a) The provider receives system sections in the order base, then persona, then authority.
  - (b) A disallowed tool returns a "blocked" result without executing.
  - (c) An approval-gated tool calls `requestApproval` once with a stable `waitId`.
  - (d) SIGKILL while waiting for approval, then resume: `requestApproval` is called again with the **same** `waitId`, and the tool executes once after "allow".
  - (e) Resume when `readmit` returns `access_changed` makes no provider request and surfaces `access_changed`.
  - (f) An unsafe tool killed mid-run yields the interrupted error result. A safe tool reruns.
- [ ] **Step 4:** Implement the extension:
  - persist `waitId` in a task memo (`api.memo`);
  - `beforeRequest` calls `readmit` on the first request after open;
  - MCP tools are always `unsafe`.

  Run the tests and expect PASS. Then commit.

### Task 1.3: Bot turn path, Resume/Dismiss, Telegram, delete

**Spec:** §6.2, §6.4, §6.5 (Telegram), §4.7.

**Files:**
- Create:
  - `main/services/bot-runtime/bot-session-service.ts` and its test
  - `main/services/telegram/bot-reply-outbox.ts` and its test
- Modify:
  - `main/services/bot-application-service.ts`: Bot sends go through `bot-session-service`; `delete` replaces archive/restore.
  - `main/handlers/bots.ts`: add `bots:resume`, `bots:dismiss`, `bots:delete`; remove `archive`, `restore`, `listChats`, `createChat`, `suggestAvatar`.
  - Telegram Bot ingress.
  - Bot chat persistence: Bot chats no longer write Pi JSONL turns; `ChatStore` keeps title, preview, `updatedAt`, unread.
- Delete on startup: existing Bot transcript data, i.e. Bot-tagged chats and their journals (pre-1.0).

**Interfaces:**

```ts
export type BotSessionState =
  | { kind: "idle" } | { kind: "running"; submissionId: string }
  | { kind: "interrupted"; submissionId: string } | { kind: "needs_model" } | { kind: "unavailable"; reason: "held_by_live_process" };
export interface BotSessionService {
  send(botId: string, input: { text: string; attachments?: AttachmentRef[]; requestId: string; whenBusy?: "steer" | "followUp" }): Promise<{ submissionId: string; deduped: boolean }>;
  resume(botId: string, requestId: string): Promise<BotSessionState>;     // idempotent
  dismiss(botId: string, requestId: string): Promise<BotSessionState>;    // idempotent
  state(botId: string): Promise<BotSessionState>;
  deleteBot(botId: string): Promise<void>;  // host.destroy + routines + home workspace + photo + telegram binding + summaries
}
```

- [ ] **Step 1: Failing tests:**
  - `send` with the same `requestId` twice gives one user entry, `deduped:true`.
  - `send` while interrupted dismisses first: the partial is kept and marked interrupted, and the new turn runs.
  - `resume` called twice concurrently makes one fresh provider request. (Review Focus 3)
  - `dismiss` after restart makes zero provider requests. If pi-durable 1.0.3 requires `resume()` before `abort()`, use the pre-armed abort and assert zero provider requests either way. Record the observed behaviour in `.memory/bot-durable-runtime.md`.
  - `deleteBot` while running leaves no directory, no routine, no photo, no binding. (Review Focus 1)
  - No model configured: `state` is `needs_model` and `send` rejects with `needs_model`.
- [ ] **Step 2:** Implement `bot-session-service.ts` and wire it into `bot-application-service.ts` and the IPC handlers. Bot chats keep a stable `chatId` mapped 1:1 to `botId`.
- [ ] **Step 3: Failing Telegram tests:**
  - Duplicate update id makes one submission (`requestId` `tg:…`).
  - The offset advances only after admission.
  - A crash after the reply is generated but before send redelivers the persisted reply without regenerating it.
  - A send cut off mid-way is redelivered once with the `(may be a duplicate)` prefix.
- [ ] **Step 4:** Implement the outbox and ingress changes. Run `npm run test:bot-runtime` and the Telegram suite; expect PASS.
- [ ] **Step 5:** Update `main/services/bot-runtime` startup wiring: create the host after the inventory is ready, run `sweepOrphans`, and run the interrupted scan into the `state` cache. Run `npm run type-check`. Commit.

### Task 1.4 (wave 2): Live projection to renderer

**Spec:** §6.5 (desktop).

**Files:**
- Create: `main/services/bot-runtime/live-projection.ts` and its test.
- Modify:
  - preload channel allowlist (`renderer/preload-channels.ts` and its test);
  - Bot query hooks in `renderer/lib/queries`.

**Interfaces:**

```ts
export interface BotLiveSnapshot { botId: string; epoch: string; seq: number; entries: BotTranscriptEntry[]; partial: string | null; state: BotSessionState; }
export type BotLiveEvent = { epoch: string; seq: number } & ({ type: "entry"; entry: BotTranscriptEntry } | { type: "partial"; text: string } | { type: "state"; state: BotSessionState });
// IPC: "bots:live:subscribe" (botId) -> BotLiveSnapshot, then push events on "bots:live:event"; "bots:live:unsubscribe".
```

- [ ] Failing tests:
  - Subscribe mid-stream returns a snapshot with partial text.
  - Re-subscribe after the renderer drops returns a fresh snapshot with a higher `seq`.
  - Reopening the harness changes `epoch`.
  - Events are bounded: more than 100 pending collapses to a snapshot.
- [ ] Implement via `conv.watch(ctx)`. Wire `useBotLive(botId)`. Run the tests and commit.

### Task 2.1: Desktop Bot list, chat mode, avatar consolidation, quick replies

**Spec:** §4.1, §4.4, §5, §9 (Desktop).

**Files:**
- Create:
  - `renderer/main/bots/bot-list.tsx`
  - `renderer/main/bots/bot-chat-header.tsx`
  - `renderer/main/bots/bot-character-card.tsx`
  - `renderer/main/bots/*.test.tsx`
- Modify:
  - `renderer/main/bots-view.tsx`: route shell only; target under 300 lines.
  - `renderer/main/chat-pane.tsx`: when `chat.botId`, render `BotChatHeader` and hide the workspace/git/permission/model/thinking pickers, fork, side questions, export, rename, review and environment panels; collapse tool activity into one "Updates" disclosure, porting the iOS `AidenBotReplyProjection` rule (progress before the final answer folds).
  - `renderer/components/bot-avatar.tsx`: colour + shape + one fixed eye mark.
  - `renderer/shared/bots.ts`: drop eyes, detail and legacy ids; colours become 12 swatches.
  - `main/services/ask-user-question-extension.ts`: allow for Bots.
  - `renderer/shared/ask-user-question.ts`: max options 5.
- Delete:
  - `BotFaceStudio` tabs (replaced by `bot-character-card.tsx`);
  - `main/services/bot-avatar-generator-core.ts` and its test;
  - the generator IPC and renderer glue.

- [ ] Failing tests (Testing Library):
  - Clicking a list row navigates to `/bots/$botId/chat/$chatId`.
  - A row shows the preview and relative time, and "Paused — tap to resume" when the state is interrupted.
  - Bot chat mode renders none of the hidden controls (query by accessible name).
  - The header pill opens the profile.
  - Tool activity is collapsed by default.
  - The Character card "Reset to default" restores `DEFAULT_BOT_AVATAR`.
  - A Bot turn receives `ask_user_question` with 5 options (main extension test).
- [ ] Implement. Run `tsx --test` on the new files plus `npm run test:ask-user-question`. Update or remove `renderer/main/bots-view.test.tsx` for deleted surfaces. Commit.

### Task 2.2: Desktop Profile, Instructions editor, Advanced, Delete, create flow

**Spec:** §4.3, §4.5, §4.6, §4.7.

**Files:**
- Create:
  - `renderer/main/bots/bot-profile.tsx`
  - `bot-instructions-editor.tsx`
  - `bot-advanced.tsx` (moves the model, vision and access sections from `BotEditor`, and the Telegram binding from the old detail page)
  - `bot-delete-dialog.tsx`
  - `bot-create-flow.tsx`
  - their tests
- Delete: `BotEditor` wizard, `BotAccessSummary`, the Conversations section.

- [ ] Failing tests:
  - Create with just a name and "What should it help with?" makes a Bot whose subtitle is that answer, using the auto-picked model.
  - With no models, creation succeeds and the chat shows "Needs an AI model". (Review Focus 5)
  - The instructions editor Save persists and Back without saving discards.
  - Advanced shows the model, image model, access, greeting and Telegram controls.
  - The delete dialog shows the exact copy, and confirm calls `bots:delete` then navigates to `/bots`.
- [ ] Implement using the shared Settings design primitives (`docs/settings-design-system.md`) for Advanced. Run the tests and commit.

### Task 2.3 (wave 2): Desktop integration — live, routines, connections, onboarding

**Spec:** §4.2, §4.3 step 2, §7, §8 UI.

- [ ] Switch the Bot chat transcript to `useBotLive`. Add the interrupted card with exact copy, Resume and Dismiss calling `bots:resume` / `bots:dismiss`.
- [ ] Add the Profile Routines list and editor:
  - frequency-first picker (Once / Every day / Weekdays / Weekly with days / Monthly, time, local timezone);
  - row label in the form "Every Sunday at 8:41 AM";
  - calls the Task 4.1 IPC.
- [ ] Add create-flow connection chips (`connection-chips.tsx`) and transcript connect cards (`connect-card.tsx`) from Task 5.1.
- [ ] Add the "Meet Your First Bot" empty state and onboarding step using `BOT_PRESETS`:
  - Start Chat calls `bots:createFromPreset` (idempotent `preset:<id>`);
  - the self-intro runs once on create only.
- [ ] Update the onboarding bento Bots tile copy and add a 1024×1024 transparent PNG at `renderer/assets/onboarding/` covered by the onboarding asset test.
- [ ] Tests:
  - interrupted card actions;
  - routine create/list labels;
  - preset Start Chat twice gives one Bot;
  - self-intro not re-sent on reopen;
  - Playwright e2e: preset, then Start Chat, then a quick reply.

### Task 3.1: iOS Bots rework (UI + deletions; no new Remote routes)

**Spec:** §4, §5, §9 (iOS).

- [ ] Delete `Features/Bots/Prototype/BotFirstPrototype.swift`, `AidenBotPrototypeSnapshotTests`, and the `--bot-first-prototype` wiring in `AidenOnTheGoApp.swift`. Remove them from `project.pbxproj`.
- [ ] Home:
  - remove Favorites (UI and mutation), the compose chooser and the bottom dock;
  - search and + go in the top bar;
  - rows: avatar with activity dot, name, subtitle pill, preview, time;
  - context menu: Profile, Delete.
- [ ] Profile:
  - merge `AidenBotProfileView` and `AidenBotEditorView` into a single `AidenBotProfileView`: avatar ••• (Choose Photo / Generate via Image Playground / Remove), inline name and subtitle, Character (12 swatches, 8 shapes, Reset), Instructions row pushing a full-screen editor with Save, ••• with Advanced / Delete;
  - Advanced reuses the access sections once;
  - delete `AidenBotCustomAccessFlowView`, the per-chat access sheet and its model types, the Full Access notice gate in `AidenProductShellView`, and the dead delete-selection helpers.
- [ ] Chat:
  - header pill with small avatar and name (to Profile);
  - ••• with Profile, Files, Delete;
  - remove the "Set Up Image Understanding" alert and the 60pt floating avatar.
- [ ] Move the contract fixtures out of `Models/AidenBot.swift` into the test target.
- [ ] Tests:
  - update `AidenBotContractTests` and snapshot/UI tests for the new structure;
  - add XCTest for delete confirmation copy and Character reset;
  - run the iOS unit suite (`xcodebuild test` on a simulator per `ios/` README).

  The Remote archive route stays until Task 5.2 swaps it to delete. Gate the Delete action on the host capability, and hide it if it's not advertised.

### Task 3.2: Android Bots rework (UI + deletions; no new Remote routes)

**Spec:** §4, §5, §9 (Android).

- [ ] Delete `AidenBotCustomAccessFlowScreen.kt`, `features/remote/AidenBotChatToolsView.kt` (and its androidTest usage), `AidenBotImagePlaygroundView.kt` plus its editor hook, `features/bots/prototype/BotFirstPrototype.kt`, and the dead delete helpers.
- [ ] Home and Profile mirror Task 3.1. Photo source is a Gallery picker (`PickVisualMedia`) feeding the existing canonical photo upload.
- [ ] Bot chat top bar:
  - back, avatar + name pill (to Profile), •••;
  - remove the raw model id;
  - placeholder `Ask {name}`.
- [ ] Tests: update JUnit/Compose tests and run `./gradlew testDebugUnitTest` (see `.memory/android-unit-test-dns.md`).

### Task 4.1: Routines backend

**Spec:** §8, Review Focus 2.

- [ ] `ScheduledTask` gains `botId?: string`. A Bot routine targets the Bot session (`BotSessionService.send` with `requestId = routine:<taskId>:<fireTime>`), not a workspace chat. Until Task 1.3 merges, depend on an injected `sendToBot` port.
- [ ] IPC:
  - `bots:routines:list(botId)`;
  - `bots:routines:create({botId, name, schedule, prompt})`;
  - `bots:routines:update`;
  - `bots:routines:delete`.

  The schedule tool, when called inside a Bot turn, binds `botId` automatically; a routine run cannot create routines.
- [ ] Prompt suffix: `If there is nothing new to report, reply exactly [SILENT].` A final reply equal to `[SILENT]` (trimmed) is stored, but no notification, unread or preview is produced. Failures always notify.
- [ ] Tests:
  - fire targets the Bot;
  - a duplicate fire time dedupes;
  - `[SILENT]` suppresses notification and unread;
  - a fire while the Bot is interrupted records `skipped/bot_paused` and calls neither resume nor dismiss (Review Focus 2);
  - deleting a Bot deletes its routines;
  - friendly label formatter cases ("Every day at 9:00 AM", "Weekdays at 7:30 AM", "Every Sunday at 8:41 AM", "Once on Oct 9 at 5:00 PM").

### Task 5.1: Presets and connection core

**Spec:** §4.2, §7.

- [ ] `renderer/shared/bot-presets.ts`: `BOT_PRESETS` with 4 entries (Chief of Staff, Meal Planner, Inbox Helper, Researcher), each `{id, name, subtitle, avatar, instructions, suggestedConnections: pluginId[], suggestedRoutine?}`, plus `createFromPreset` main handler logic (idempotent key `preset:<id>`).
- [ ] `renderer/shared/bot-connections.ts`:
  - `connectionSuggestionFor(pluginId)` returns `{pluginId, name, iconPath, setupEntry}` from `plugin-catalog.ts` and `mcp-preset-icons.tsx`;
  - `rankConnections(text, presetIds)` uses a keyword map (email, inbox, mail → gmail/outlook; calendar, meeting → googlecalendar; notes, docs, wiki → notion; apps, everything → composio).
- [ ] `main/services/bot-runtime-tools/suggest-connection.ts`:
  - Bot-only tool `suggest_connection({pluginId, reason})` that appends a typed `connect_card` entry `{pluginId, reason, status: "pending"|"connected"|"dismissed"}`;
  - refuses already-connected plugins and plugins dismissed for that Bot;
  - per-Bot dismissal store.
- [ ] `renderer/components/bots/connect-card.tsx` (icon in a squircle tile, `Connect {name}`, reason, Connect / Not now, "Connected ✓") and `connection-chips.tsx`.
- [ ] Tests:
  - rank cases;
  - suggestion for an unknown id returns null;
  - the tool refuses connected and dismissed plugins;
  - card renders three states and calls handlers;
  - chips toggle.

### Task 5.2 (wave 2): Remote contract revision + native consumers

**Spec:** §6.5 (Remote), §7 (mobile), §8.

- [ ] Claim the next revision. Add:
  - Bot snapshot `{entries window, partial, interrupted}`;
  - `(epoch, seq)` on Bot stream events;
  - `POST /bots/{id}/resume` and `/dismiss` (idempotent per request UUID);
  - `DELETE /bots/{id}` (replaces archive/restore);
  - `GET/POST/PATCH/DELETE /bots/{id}/routines`;
  - `POST /bots/{id}/connection-requests`, which raises a Mac notification opening setup;
  - `GET /bot-presets` and `POST /bots/from-preset`;
  - `connect_card` entries in Bot transcripts.

  Remove `/bot-favorites`, `/chats/:chatId/capabilities` for Bots, and `/bots/:id/restore`.
- [ ] Shared TS/Swift/Kotlin fixtures. iOS and Android:
  - DTOs and strict parsers;
  - interrupted card (exact copy) with Resume/Dismiss;
  - Delete;
  - Profile Routines list and editor;
  - connect card with "Finish on your Mac";
  - "Meet Your First Bot" carousel on an empty home.
- [ ] Tests:
  - fixture round-trips on three platforms;
  - double Resume is idempotent (Review Focus 3);
  - no-model preset Start Chat shows "Needs an AI model" (Review Focus 5);
  - older-client stream Stop unchanged.

### Task 6.1 (wave 3): Docs, memory, verification, PR

- [ ] Update:
  - `docs/plans/README.md`: add the Bots Rework entry; mark the durable-jobs Bot slice superseded;
  - `pi-1.0.3-upgrade-plan.md`: note the Bot exception;
  - `bot-first-aiden-on-the-go-plan.md`: Favorites, Archive and per-chat access removed;
  - `.memory/bot-durable-runtime.md` and `.memory/bots-rework-ui.md`.
- [ ] Run:
  - `npm run type-check`;
  - `npm run lint`;
  - `npm run test:bot-runtime`;
  - affected suites;
  - `npm test`;
  - the iOS and Android unit suites;
  - `npm run test:e2e` for the Bot spec.
- [ ] Open the PR against `main` with a summary, test evidence and remaining physical-device acceptance items.
