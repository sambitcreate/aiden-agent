# Bot autonomy A: self-healing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bots catch broken routines before they fire, classify and retry failures, pause a routine after three failures in a row of the same kind, show one health status, recover stuck runs, and flag replies that claim success over a failed step.

**Architecture:** Plan A also builds the three foundations that Plans B and C reuse:
- failure kinds on run records (F1);
- host-owned Bot issues with a chat card and delivery (F2);
- one delivery funnel with a per-Bot delivery log (F4).

The healing features (S1–S5) sit on top of them. All new logic lives in focused main-process modules with injectable ports, so the CLI's Bot host can share them.

**Tech Stack:** TypeScript, Electron main and renderer (React), Pi Durable 1.4.0 (pinned, unchanged), `node:test` through `tsx --test`, Swift (iOS), Kotlin (Android).

**Spec:** [`docs/superpowers/specs/2026-10-27-bot-autonomy-design.md`](../specs/2026-10-27-bot-autonomy-design.md) §2, §3 (D1), §4.1–4.3, §5, §8, §10. Section numbers (§n) below refer to it.

## Global Constraints

- Read `AGENTS.md` first. Tests are behavioral only: never `readFileSync` production source and `assert.match` against it, and no tautological or change-detector tests.
- Register every new test file twice: in its `package.json` `test:bot-*` script, and in a lane of `scripts/ci-test-registry.json`. `scripts/ci-test-registry.test.mjs` fails if either is missing.
- New `test:` scripts that touch the Bot runtime get `"pretest:<name>": "npm run build:lease-flock"`, like `test:bot-pause`.
- Pi packages stay pinned. Do not patch `node_modules`.
- Pre-1.0: delete legacy shapes rather than migrate them (owner memory `pre-1-0-no-migrations`).
- Remote: claim the next contract revision after `main`'s at merge time. Today it is 40, in `main/services/aiden-remote-protocol.ts:118`. Update iOS, Android, `protocol/aiden-remote/v1/fixtures/contract.json`, `protocol/aiden-remote/v1/openapi.json`, `docs/aiden-remote-api-v1.md` and `ios/AidenOnTheGoTests/AidenRemotePhase0Tests.swift:151` together.
- Network: the pre-fire check may refresh OAuth and connect the Bot's granted MCP servers (D1). It must never boot, clone or download a Bot computer, contact models.dev, or run at startup or during onboarding.
- UI follows `GUI.md`, `docs/design-guide.md` and `docs/settings-design-system.md`. Keep status colors as soft semantic fills, with no decorative borders, and keep `focus-visible` rings. No brain icons. Copy stays minimal.
- Modules under `main/services/` must not import `electron`, except `*-main.ts` wiring files. The CLI bundles these sources.
- Update docs in the same PR: `README.md`, `PRODUCT.md`, `docs/aiden-remote-api-v1.md`, `docs/plans/README.md`, and `.memory/bot-proactivity.md`. That memory file's "Remote revision 27" is stale.
- Never use bare `git stash`. Update a shared PR branch by merging `origin/main`.

## Review Focus

1. **A routine that keeps failing for different reasons**, for example temporary, then sign-in, then temporary. Expect no auto-pause, because the kinds differ, but an immediate sign-in issue. Task 5 tests this.
2. **The pre-fire check finds a problem, the person fixes it, and the routine then fires.** Expect the issue to resolve on the next passing check or on a successful run. It must never stay stale. Task 6 tests this.
3. **The Mac sleeps through a check window.** On wake, a fire due in under 2 minutes skips its check rather than delaying the fire. Task 6 tests this.
4. **A watchdog false positive while the Bot waits on a hand-off, approval or question card.** It must never stop or flag the run. Task 8 tests this.
5. **A one-time routine whose fire failed temporarily.** Retries must still run even though the one-time routine is now disabled. Task 5 tests this.

---

### Task 1: Failure kinds on routine run records (F1)

**Files:**
- Create: `renderer/shared/bot-routine-failure.ts`
- Create: `renderer/shared/bot-routine-failure.test.ts`
- Modify: `main/services/bot-runtime/bot-session-service.ts:571-580` (`settledOutcome` keeps `detail`)
- Modify: `main/services/scheduled-bot-routines.ts:238-260` (classify a failed outcome), `:357` (record it)
- Modify: `main/services/types.ts:570` (`ScheduledRun.failure?`)
- Modify: `main/services/schedule-store-core.ts:808` (`recordRun` persists `failure`, bounded)
- Test: `main/services/scheduled-bot-routines.test.ts` (extend)

**Interfaces:**
- Produces, in `renderer/shared/bot-routine-failure.ts`:
  ```ts
  export type BotRoutineFailureKind = "temporary" | "sign_in" | "access_changed" | "model_setup" | "tool_error" | "stalled" | "other";
  export interface BotRoutineFailure { kind: BotRoutineFailureKind; code: string; detail?: string; toolName?: string }
  export const BOT_ROUTINE_FAILURE_DETAIL_CHARS = 500;
  export function classifyBotRoutineFailure(input: {
    reason?: string;                          // Pi reason: model_error | no_model | restart_limit | run_failed | …
    detail?: string;                          // Pi detail text (provider message)
    authority?: string;                       // a BOT_RUNTIME_AUTHORITY_FAILURE_MESSAGES key
    sessionReason?: string;                   // a BotSessionErrorReason
  }): BotRoutineFailure
  ```
- Produces: `ScheduledRun.failure?: BotRoutineFailure`, and the bot-session outcome `{ kind: "failed"; error: string; reason?: string; detail?: string }`.
- Consumes: `providerFailureFromLegacyPiMessage(value)` from `main/services/provider-failure.ts:142`. The mapping table is spec §4.1.

- [ ] **Step 1: Write the failing tests** in `renderer/shared/bot-routine-failure.test.ts`:
  - `classifies provider timeouts and overloads as temporary`: `classifyBotRoutineFailure({reason: "model_error", detail: "503 Service Unavailable"}).kind === "temporary"`.
  - `classifies an expired token as sign_in`: a detail of `"401 Unauthorized: token expired"` gives `"sign_in"`.
  - `classifies authority drift as access_changed`: `{authority: "model_changed"}` gives `"access_changed"` with `code === "model_changed"`.
  - `classifies a missing model as model_setup`: `{sessionReason: "needs_model"}` gives `"model_setup"`.
  - `bounds and redacts detail`: a 2,000-character detail containing `sk-abc123…` gives `detail.length <= 500` and no `sk-` secret, using the existing redaction helper in `main/services/diagnostics` or `renderer/shared/redact*.ts`. Find the one used by `bot-routine-notifications.ts` previews and reuse it.
  - `falls back to other`: `{reason: "restart_limit"}` gives `"other"`.
- [ ] **Step 2: Run and see them fail.** `npx tsx --test renderer/shared/bot-routine-failure.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `classifyBotRoutineFailure`** with the precedence authority, then session reason, then provider failure from detail, then reason. `quota` maps to `model_setup`. `network`, `timeout`, `service_unavailable`, `rate_limit` and `interrupted` map to `temporary`. `authentication` maps to `sign_in`.
- [ ] **Step 4: Add the executor test** in `main/services/scheduled-bot-routines.test.ts`, `records a classified failure on the run`. Use a fake `ports.awaitReply` that resolves `{kind: "failed", error: "model_error", reason: "model_error", detail: "429 rate limit"}`. Expect the recorded run to have `result === "error"` and `failure.kind === "temporary"`, and its `error` to contain the detail, not only `"model_error"`.
- [ ] **Step 5: Implement.** In `settledOutcome`, pass Pi's `detail` and `reason` through. In the executor, classify before `recordRun` and keep the existing `error` text (it is still the detail, sliced to 4,096). `recordRun` stores `failure`.
- [ ] **Step 6: Run the tests.** `npx tsx --test renderer/shared/bot-routine-failure.test.ts main/services/scheduled-bot-routines.test.ts`. Expected: PASS. Run `npm run test:bot-runtime`. Expected: PASS.
- [ ] **Step 7: Register and commit.** Add `renderer/shared/bot-routine-failure.test.ts` to a new `"test:bot-health"` script and to the `ci-test-registry.json` lane that holds `bot-routine-*` tests. Then:
  ```bash
  git add renderer/shared/bot-routine-failure.ts renderer/shared/bot-routine-failure.test.ts main/services package.json scripts/ci-test-registry.json
  git commit -m "Record why a Bot routine failed"
  ```

### Task 2: One delivery funnel and the per-Bot delivery log (F4)

**Files:**
- Create: `main/services/bot-delivery/log.ts`, `main/services/bot-delivery/funnel.ts`, `main/services/bot-delivery/funnel-main.ts`
- Create: `main/services/bot-delivery/funnel.test.ts`
- Modify: `main/services/scheduled-bot-routines.ts:369-385` (the surfaced-outcome branch calls the funnel)
- Modify: `main/services/bot-routine-notifications.ts` (the phone feed reads the delivery log; drop the projection from run records)
- Modify: `main/services/aiden-remote-service-main.ts:930` (wiring)
- Test: `main/services/bot-routine-notifications.test.ts` (rewrite to log-backed fixtures)

**Interfaces:**
- Produces:
  ```ts
  export type BotDeliveryClass = "routine_result" | "issue" | "proposal" | "digest";
  export interface BotDeliveryRow {
    id: string; botId: string; class: BotDeliveryClass; dedupeKey: string;
    title: string; body: string; routineId?: string; requestId?: string;
    status: "succeeded" | "failed" | "info";  // phone feed status
    createdAt: number; deliverAfter: number; sentAt?: number;
  }
  export interface BotDeliveryLog {
    append(row: Omit<BotDeliveryRow, "id">): Promise<{ row: BotDeliveryRow; created: boolean }>; // dedupe by (botId, dedupeKey)
    due(since: number | undefined, now: number): Promise<BotDeliveryRow[]>;                       // newest first, ≤ 100
    markSent(botId: string, id: string, at: number): Promise<void>;
    forgetBot(botId: string): Promise<void>;
  }
  export function createBotDeliveryLog(options: { profileDir(): string; now?(): number }): BotDeliveryLog; // <profile>/bots/<dir>/deliveries.json, newest 200 rows per Bot
  export interface BotDeliveryInput { botId: string; class: BotDeliveryClass; dedupeKey: string; title: string; body: string; status: BotDeliveryRow["status"]; routineTask?: ScheduledTask; requestId?: string; chatId?: string }
  export interface BotDeliveryGate { decide(input: BotDeliveryInput, now: number): Promise<{ kind: "now" } | { kind: "defer"; until: number } | { kind: "suppress"; reason: "daily_limit" }> }
  export const ALWAYS_NOW_GATE: BotDeliveryGate; // Plan B replaces it
  export interface BotDeliveryFunnel { deliver(input: BotDeliveryInput): Promise<"sent" | "deferred" | "suppressed" | "duplicate"> }
  export function createBotDeliveryFunnel(deps: { log: BotDeliveryLog; gate: BotDeliveryGate; mac(input: BotDeliveryInput): Promise<void>; telegram(input: BotDeliveryInput): Promise<void>; now(): number }): BotDeliveryFunnel;
  ```
- Consumes: `notifyBotRoutine` (`schedule-execution.ts:120`), `telegramService.deliverBotRoutineResult` (`telegram-service.ts:1048`). For non-routine classes, Telegram is called with `requestId = "bot-delivery:" + row.id` and `routineName = title`.

- [ ] **Step 1: Write the failing tests** in `funnel.test.ts`:
  - `sends a routine result to mac, telegram and the phone feed once`: delivering the same `dedupeKey` twice returns `"sent"` and then `"duplicate"`, calls `mac` and `telegram` once each, and `log.due(undefined, now)` has one row.
  - `a deferred row is invisible to phones until it is due`: a gate returning `{defer, until: now + 1h}` means `due(undefined, now)` is empty and `due(undefined, now + 1h)` has the row, and `mac` is not called.
  - `suppressed rows are logged but never notified`.
  - `forgetBot removes the Bot's rows`.
- [ ] **Step 2: Run and see them fail.** `npx tsx --test main/services/bot-delivery/funnel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `createBotDeliveryLog` (atomic JSON through `writeJsonAtomic`, per-Bot serial writes using `createKeyedSerial` from `bot-routine-notes.ts:40`) and `createBotDeliveryFunnel`. Deferred rows are sent later by the flush in Plan B. In Plan A, `ALWAYS_NOW_GATE` never defers.
- [ ] **Step 4: Rewrite the phone feed.** `createBotRoutineNotificationFeed` becomes `createBotNotificationFeed({ log, botName, now })`, with `list(since)` mapping due rows to `AidenRemoteBotRoutineNotification`. The existing shape stays: rows with class `routine_result` map to `status: "succeeded" | "failed"`. Other classes stay out of this feed until Task 4 adds `kind`. Update `bot-routine-notifications.test.ts`: `lists due rows newest first, at most 100, after since`, and `never lists silent, skipped or blocked runs`. The second test is now enforced by the executor not calling the funnel; prove it through the executor with a silent reply.
- [ ] **Step 5: Route the executor** through `funnel.deliver({class: "routine_result", dedupeKey: requestId, …})` in place of the separate `notify` and `deliverResult` calls. Bot delete calls `log.forgetBot`; find the Bot-delete fan-out next to the routine notes `clear`.
- [ ] **Step 6: Run the tests.** `npx tsx --test main/services/bot-delivery/funnel.test.ts main/services/bot-routine-notifications.test.ts main/services/scheduled-bot-routines.test.ts`, then `npm run test:bots`. Expected: PASS.
- [ ] **Step 7: Register in `test:bot-health` and the CI registry, then commit:** "Send every Bot message through one delivery funnel".

### Task 3: Bot issues: store, chat card, sidebar and Mac notification (F2)

**Files:**
- Create: `renderer/shared/bot-issues.ts`
- Create: `main/services/bot-issues/store.ts`, `main/services/bot-issues/service.ts`, `main/services/bot-issues/service-main.ts`
- Create: `main/services/bot-issues/service.test.ts`
- Create: `renderer/components/bots/bot-issue-card.tsx`, `renderer/components/bots/bot-issue-card.test.tsx`
- Modify: `main/services/bot-runtime/live-projection.ts:~350` (project `aiden.bot-issue` the way `routine_proposal` is projected)
- Modify: `renderer/shared/bot-live.ts:~179` (a `BotTranscriptEntry` variant `{ type: "issue"; issue: BotIssue; status: "open" | BotIssueResolution }`)
- Modify: `renderer/main/bots/bot-transcript-rows.ts:139`, `renderer/main/bots/bot-chat-pane.tsx:771` (render the card)
- Modify: `main/handlers/` (a new `bot-issues.ts` with IPC `bots:issues:act`, `bots:issues:list`)
- Modify: `main/services/bot-runtime/bot-session-main.ts:453` (the existing `wireBotAttention` also counts open issues toward "Needs you")

**Interfaces:**
- Produces, in `renderer/shared/bot-issues.ts`:
  ```ts
  export type BotIssueKind = "preflight_failed" | "routine_failed" | "routine_paused" | "run_stalled";
  export type BotIssueAction =
    | { kind: "open_settings"; section: "model" | "access" | "connections" | "providers" }
    | { kind: "resume_routine"; routineId: string }
    | { kind: "stop_run" }
    | { kind: "keep_waiting" }
    | { kind: "open_chat" };
  export type BotIssueResolution = "fixed" | "dismissed" | "superseded";
  export interface BotIssue {
    id: string; botId: string; kind: BotIssueKind; dedupeKey: string;
    title: string; body: string; routineId?: string;
    actions: BotIssueAction[];              // 0–2
    createdAt: number; resolvedAt?: number; resolution?: BotIssueResolution;
  }
  export const BOT_ISSUE_LIMITS = { openPerBot: 8, retainedResolved: 50, titleChars: 80, bodyChars: 280 } as const;
  export const BOT_ISSUE_ENTRY_KIND = "aiden.bot-issue";
  export const BOT_ISSUE_STATUS_ENTRY_KIND = "aiden.bot-issue-status";
  export const BOT_ISSUE_CHANNELS = { act: "bots:issues:act", list: "bots:issues:list" } as const;
  ```
- Produces, in `main/services/bot-issues/service.ts`:
  ```ts
  export interface BotIssueService {
    raise(input: Omit<BotIssue, "id" | "createdAt" | "resolvedAt" | "resolution">): Promise<BotIssue>; // existing open issue with the same dedupeKey is returned unchanged
    resolve(botId: string, dedupeKey: string, resolution: BotIssueResolution): Promise<boolean>;
    act(botId: string, issueId: string, action: BotIssueAction): Promise<"done" | "not_open" | "invalid">;
    list(botId: string, options?: { open?: boolean }): Promise<BotIssue[]>;
    onChange(listener: (botId: string) => void): () => void;
    forgetBot(botId: string): Promise<void>;
  }
  export function createBotIssueService(deps: {
    store: BotIssueStore;
    appendEntry(botId: string, kind: string, data: unknown): Promise<void>; // runtime.appendEntry; no submission
    funnel: BotDeliveryFunnel;                                              // Task 2, class "issue"
    actions: { resumeRoutine(botId: string, id: string): Promise<void>; stopRun(botId: string): Promise<void>; snoozeStall(botId: string): void; openSettings(botId: string, section: string): void };
    now(): number;
  }): BotIssueService;
  ```
  Opening the eighth issue resolves the oldest as `superseded`.

- [ ] **Step 1: Write the failing tests** in `service.test.ts`:
  - `raise dedupes by key and appends one chat entry`.
  - `resolve appends a status entry and frees the key for a new issue`.
  - `act resume_routine resumes then resolves as fixed`, with a fake `actions.resumeRoutine` called exactly once with `(botId, routineId)`.
  - `act on a resolved issue returns not_open and does nothing`.
  - `raising past 8 open supersedes the oldest`.
  - `raise delivers once through the funnel with class issue`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** the store (`<profile>/bots/<dir>/issues.json`, `writeJsonAtomic`, per-Bot serial) and the service.
- [ ] **Step 4: Card test** in `bot-issue-card.test.tsx`, using Testing Library with the `bot-chat-pane` test helpers:
  - `an open issue shows its title, body and action buttons and calls onAct`;
  - `a resolved issue shows a quiet resolved line and no buttons`;
  - `buttons keep focus-visible styling`: assert they are focusable and reachable in tab order, not the class names.
- [ ] **Step 5: Implement** `BotIssueCard` on `BotNoticeCard`, the same base as `RoutineProposalCard`, plus the projection, the transcript row and the IPC handler (strict parsing like `main/handlers/bot-params.ts`). Add a handler register-and-invoke test, `main/handlers/bot-issues.test.ts`, that `bots:issues:act` rejects unknown action kinds.
- [ ] **Step 6: Sidebar.** Open issues count toward the existing "Needs you" sidebar state. Extend the `wireBotAttention` test (find it beside `bot-session-main.ts`) to cover `an open issue marks the Bot as needing the person; resolving it clears that`. The Mac banner when no window is focused comes from the funnel's `mac` port, following `createBotHandoffNotifier` (`bot-handoff-notifications.ts:49`).
- [ ] **Step 7: Run** `npx tsx --test main/services/bot-issues/service.test.ts renderer/components/bots/bot-issue-card.test.tsx main/handlers/bot-issues.test.ts`, then `npm run test:bot-runtime` and `npm run test:bot-handoffs`. Expected: PASS.
- [ ] **Step 8: Register and commit:** "Let the host tell a person a Bot needs them".

### Task 4: Bot issues on phones (Remote `bot:issues`)

**Files:**
- Modify: `main/services/aiden-remote-protocol.ts`:
  - the capability `bot:issues`;
  - `AidenRemoteBotIssue`;
  - the Bot session `issues` field;
  - `AidenRemoteBotSummary.issueCount?`;
  - the notification item `kind?: "routine" | "issue"`;
  - the revision bump at merge.
- Modify: `main/services/aiden-remote-bot-session.ts` (issue cards in session frames, as `toRemoteBotHandoff` does), `main/services/aiden-remote-router.ts` (`POST /bots/:botId/issues/:issueId/act`), `main/services/aiden-remote-bots.ts:186` (`issueCount`)
- Modify: `protocol/aiden-remote/v1/openapi.json`, `protocol/aiden-remote/v1/fixtures/contract.json`, `docs/aiden-remote-api-v1.md`
- Modify (iOS): `ios/AidenOnTheGo/Models/AidenBot.swift`, `Models/AidenBotSession.swift`, `Features/Bots/AidenBotSessionChatView.swift` (an issue card next to `AidenBotRoutineProposalCardView` at `:1307`), `Networking/AidenRemoteContract.swift`
- Modify (Android): `models/AidenBot.kt`, `models/AidenBotSession.kt`, `features/bots/AidenBotSessionScreen.kt` (next to `AidenBotRoutineProposalCard` at `:790`), `protocol/AidenRemoteProtocol.kt`
- Test: `main/services/aiden-remote-bot-session.test.ts`, `main/services/aiden-remote-protocol.test.ts`, iOS `AidenOnTheGoTests` (issue decode plus a card action), Android `AidenBotContractTest.kt`

**Interfaces:**
- Produces: `AidenRemoteBotIssue = { id; kind; title; body; routineId?; actions: Array<{ kind: "open_chat" | "resume_routine" | "stop_run" | "keep_waiting"; routineId? }>; createdAt; resolved: boolean }`. `open_settings` is shown on phones as "Open on your Mac" (desktop-only settings) and is not sent as an action. `act` body: `{ action: { kind; routineId? } }` gives 200 `{ result: "done" | "not_open" }`.

- [ ] **Step 1: Failing host tests:**
  - `issues are omitted unless bot:issues is negotiated`;
  - `act stop_run reaches BotIssueService.act once`;
  - `unknown action kind is 400`.
- [ ] **Step 2: Implement the host side.** Add the capability under `AIDEN_REMOTE_MAX_SERVER_FEATURES` (32 tokens); check the count stays within it.
- [ ] **Step 3: Native.** iOS and Android decode `issues` and render a card with up to two buttons. Older hosts that don't send `issues` render nothing. Tests: decode the fixture, and tapping an action posts the right body.
- [ ] **Step 4: Run** `npx tsx --test main/services/aiden-remote-bot-session.test.ts main/services/aiden-remote-protocol.test.ts main/services/aiden-remote-operation-contract.test.ts`, the iOS focused tests (`xcodebuild test -only-testing:AidenOnTheGoTests/AidenBotIssueTests` or the project's documented test command in `ios/README.md`), and Android `./gradlew :app:testDebugUnitTest --tests '*AidenBotIssue*'`. Expected: PASS.
- [ ] **Step 5: Commit:** "Show Bot issues on phones".

### Task 5: Retries and pause after three same-kind failures (S2)

**Files:**
- Create: `main/services/bot-routine-recovery.ts`, `main/services/bot-routine-recovery.test.ts`
- Modify: `main/services/schedule-service-core.ts:16` (the trigger `{ kind: "retry"; failedRunId: string; attempt: 1 | 2 }`), `:274` (`dispatch` admits retries like catch-up), `:570` (startup replays `pendingRoutineRetries`)
- Modify: `main/services/types.ts:516` (`ScheduledTask.pendingRoutineRetries?: Array<{ failedRunId: string; attempt: 1 | 2; at: number; requestId: string }>`)
- Modify: `main/services/schedule-store-core.ts` (`addRoutineRetry`, `settleRoutineRetry`; a one-time routine's retry is admitted while it is disabled, like the paused catch-up rule)
- Modify: `main/services/scheduled-bot-routines.ts:35` (`botRoutineRequestId` for retry: `routine:<taskId>:retry-<failedRunId>-<attempt>`), `:357` (call recovery after `recordRun`)

**Interfaces:**
- Produces:
  ```ts
  export const BOT_ROUTINE_RETRY_DELAYS_MS = [5 * 60_000, 20 * 60_000] as const;
  export const BOT_ROUTINE_FAILURE_PAUSE_THRESHOLD = 3;
  export interface FireOutcome { fireKey: string; failed: boolean; kind?: BotRoutineFailureKind } // fireKey groups a fire and its retries
  export function fireOutcomes(runs: readonly ScheduledRun[]): FireOutcome[];          // newest first; skipped/silent/blocked runs excluded
  export function failureStreak(outcomes: readonly FireOutcome[]): { count: number; kind?: BotRoutineFailureKind };
  export function retryPlan(input: { failure: BotRoutineFailure; attempt: 0 | 1 | 2; finishedAt: number; nextRunAt?: number }): { at: number; attempt: 1 | 2 } | undefined;
  export function createBotRoutineRecovery(deps: { store: Pick<ScheduleStore, "runs" | "addRoutineRetry">; routines: Pick<BotRoutineService, "pause">; issues: BotIssueService; routineName(taskId: string): Promise<string>; now(): number }): { afterRun(task: ScheduledTask, run: ScheduledRun): Promise<void> };
  ```
- Issue copy (exact):
  - Immediate: title `"{routine} needs you"`, body by kind:
    - sign_in: `"Sign in to {provider} again so it can run."`
    - access_changed: `"This Bot's model or access changed. Check its settings."`
    - model_setup: `"This Bot needs a working AI model."`
  - Pause: title `"Paused {routine}"`, body `"It failed 3 times in a row. {kind sentence}"` with action `resume_routine`.

- [ ] **Step 1: Failing tests** in `bot-routine-recovery.test.ts`:
  - `retries a temporary failure at 5 then 20 minutes`: `retryPlan({failure: {kind: "temporary"}, attempt: 0, finishedAt: t})` gives `{at: t + 300000, attempt: 1}`; attempt 1 gives `t + 1200000`; attempt 2 gives `undefined`.
  - `skips a retry when the next regular fire comes first`: `nextRunAt = t + 60000` gives `undefined`.
  - `never retries sign_in, access_changed or model_setup`.
  - `counts a fire and its retries as one failure`: runs `[retry-2 error, retry-1 error, fire error]` give one failed FireOutcome.
  - `pauses after three failed fires of the same kind and raises one issue`.
  - `different kinds do not pause` (Review Focus 1). Temporary, then sign_in, then temporary gives no pause and one sign_in issue.
  - `a success resets the streak`.
  - `a one-time routine's temporary failure still retries while disabled` (Review Focus 5). Do this through `schedule-service-core` with the fake clock used by its existing tests.
  - `resume resolves the paused issue`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** the pure functions, then `createBotRoutineRecovery`. Wire `afterRun` in the executor after `recordRun`. When `run.result === "success"`, resolve open `routine_failed:<taskId>` issues as `fixed`.
- [ ] **Step 4: Retry trigger.** Add the trigger kind. `dispatch` admits it only if the matching `pendingRoutineRetries` entry exists. Startup replays due retries through the existing catch-up queue (`createCatchUpQueue`, `:75`). Extend `schedule-service-core` tests: `a due retry replays once after restart`.
- [ ] **Step 5: Run** `npx tsx --test main/services/bot-routine-recovery.test.ts main/services/schedule-service-core.test.ts main/services/scheduled-bot-routines.test.ts` and `npm run test:scheduled`. Expected: PASS.
- [ ] **Step 6: Register and commit:** "Retry passing routine failures and pause after three".

### Task 6: Health checks and the pre-fire check (S1)

**Files:**
- Create: `renderer/shared/bot-health.ts`, `main/services/bot-health/checks.ts`, `main/services/bot-health/preflight.ts`, `main/services/bot-health/health-main.ts`
- Create: `main/services/bot-health/checks.test.ts`, `main/services/bot-health/preflight.test.ts`
- Modify: `main/services/bot-capability-store.ts:581` (a public `refreshModelBinding(botId): Promise<"current" | "repaired" | "drifted">` that reuses `refreshStaleModelBindings`)
- Modify: `main/services/mcp-failure-diagnostics.ts:460` (a public `degradedServerIds(): ReadonlySet<string>`)

**Interfaces:**
- Produces, in `renderer/shared/bot-health.ts`:
  ```ts
  export type BotHealthCheckId = "bot_state" | "model" | "provider_auth" | "connections" | "computer";
  export interface BotHealthCheckResult { id: BotHealthCheckId; status: "ok" | "repaired" | "needs_you" | "skipped"; failure?: BotRoutineFailure; label: string }
  export interface BotHealthReport { botId: string; checkedAt: number; trigger: "pre_fire" | "manual" | "after_failure"; routineId?: string; results: BotHealthCheckResult[] }
  export type BotHealthStatus = "ok" | "needs_you" | "paused";
  export function botHealthStatus(input: { paused: boolean; sessionState: string; openIssues: number; report?: BotHealthReport }): BotHealthStatus;
  ```
- Produces, in `main/services/bot-health/checks.ts`:
  ```ts
  export interface BotHealthCheckDeps {
    sessionState(botId: string): Promise<string>;
    refreshModelBinding(botId: string): Promise<"current" | "repaired" | "drifted">;
    providerAuth(botId: string, signal: AbortSignal): Promise<"ok" | "refreshed" | "signed_out">;            // preflightBotModelAuth
    connections(botId: string, signal: AbortSignal): Promise<{ degraded: Array<{ id: string; label: string }> }>; // resolveBotMcpInventory + degradedServerIds
    computer(botId: string): Promise<"none" | "ready" | "stale">;                                        // computer(botId), baseReady(): reads only
  }
  export function runBotHealthChecks(botId: string, deps: BotHealthCheckDeps, options: { trigger: BotHealthReport["trigger"]; routineId?: string; signal: AbortSignal; now(): number }): Promise<BotHealthReport>;
  ```
  The first `needs_you` stops the network checks after it. Bot state and model come first, then auth, connections and computer.
- Produces, in `preflight.ts`:
  ```ts
  export const BOT_ROUTINE_PREFLIGHT_LEAD_MS = 30 * 60_000;
  export const BOT_ROUTINE_PREFLIGHT_MIN_LEAD_MS = 2 * 60_000;
  export function createBotRoutinePreflight(deps: { routines(): Promise<ScheduledTask[]>; run(botId: string, routineId: string, signal: AbortSignal): Promise<BotHealthReport>; issues: BotIssueService; reports: { set(report: BotHealthReport): void; get(botId: string): BotHealthReport | undefined }; now(): number; setTimer(fn: () => void, ms: number): { cancel(): void } }): { rearm(): Promise<void>; dispose(): void };
  ```
  It keeps one armed timer per enabled Bot routine with `nextRunAt`, and checks each fire at most once (keyed `${taskId}:${nextRunAt}`). `rearm` runs on schedule changes (`bots:changed`) and on resume from sleep (`powerMonitor` in `health-main.ts` only).

- [ ] **Step 1: Failing check tests** in `checks.test.ts`:
  - `a stale model fingerprint is repaired, not reported`: `refreshModelBinding` returns `"repaired"`, so the result is `status: "repaired"` and no `needs_you`.
  - `a signed-out provider stops the network checks after it`: `connections` and `computer` are never called.
  - `a degraded connection names the connection`.
  - `the computer check never starts a VM`: the fake deps object has no start method, and only the `computer` read is called.
  - `botHealthStatus prefers paused, then needs_you`.
- [ ] **Step 2: Failing pre-fire tests** in `preflight.test.ts`, with a fake clock and timer:
  - `checks once 30 minutes before a fire`.
  - `a fire under 2 minutes away is not checked` (Review Focus 3).
  - `a needs_you result raises one issue keyed preflight:<check> with the routine's name`.
  - `a later passing check resolves the issue as fixed` (Review Focus 2).
  - `editing the routine's time rearms the timer`.
  - `a disabled routine is never checked`.
- [ ] **Step 3: Run and see them fail.**
- [ ] **Step 4: Implement** the two capability seams (`refreshModelBinding`, `degradedServerIds`) with unit tests in their existing suites: `refreshModelBinding repairs only a model-fingerprint drift and leaves Custom bindings drifted` (the drift-memory rule in `.memory/bot-model-fingerprint-drift.md`). Then implement checks and preflight, and wire them in `health-main.ts`. Also call `run(…, "after_failure")` from Task 5's recovery for `sign_in` and `access_changed` failures.
- [ ] **Step 5: Run** `npx tsx --test main/services/bot-health/*.test.ts` and `npm run test:bot-runtime`. Expected: PASS.
- [ ] **Step 6: Register and commit:** "Check a Bot's routine needs before it fires".

### Task 7: Health status on desktop and phones (S3)

**Files:**
- Modify: `renderer/shared/bot-live.ts:278` (`BotLiveSummary.health: BotHealthStatus`, `issueCount: number`), `main/handlers/bot-live.ts:107`
- Modify: `renderer/main/bots/bot-sidebar-rows.ts:15,54` (a status dot; "Needs you" text only when `needs_you`)
- Create: `renderer/main/bots/bot-health-section.tsx`, `renderer/main/bots/bot-health-section.test.tsx`
- Modify: `renderer/main/bots/bot-profile.tsx:151` (mount the Health group)
- Modify: `main/handlers/` (IPC `bots:health:check` runs `runBotHealthChecks` with trigger `"manual"`, `bots:health:report` returns the last report)
- Modify: `main/services/aiden-remote-bots.ts:186` (`issueCount` when `bot:issues`), iOS `Features/Bots/AidenBotProfileView.swift`, Android `features/bots/AidenBotProfileScreen.kt` (dot and count only)

- [ ] **Step 1: Failing renderer tests:**
  - `bot-health-section.test.tsx`: `lists the last check's results with plain labels`, `Check now calls the IPC and shows the new report`, `a repaired check reads as fixed, not as a problem`.
  - In the sidebar rows suite: `a Bot that needs the person shows Needs you; an OK Bot shows no extra text`.
- [ ] **Step 2: Implement.** The dot uses semantic status fills from `renderer/styles.css`, with no border. Labels: "Ready", "Needs you", "Paused". The Health group follows `docs/settings-design-system.md` (grouped card, inset separators, a trailing button).
- [ ] **Step 3: Run** `npx tsx --test renderer/main/bots/bot-health-section.test.tsx renderer/main/bots/bot-sidebar-rows.test.ts` plus the phone tests. Expected: PASS.
- [ ] **Step 4: Commit:** "Show one health status per Bot".

### Task 8: Stuck-run watchdog (S4)

**Files:**
- Create: `main/services/bot-runtime/bot-run-watchdog.ts`, `main/services/bot-runtime/bot-run-watchdog.test.ts`
- Modify: `main/services/bot-runtime/bot-session-service.ts` (`noteProgress(botId)` on every live frame and entry commit; `lastProgressAt(botId)`; `runKind(botId): "routine" | "attended" | null`, from the running submission's request id prefix `routine:`)
- Modify: `main/services/bot-runtime/bot-session-main.ts` (wire the watchdog; `isWaitingOnPerson` = an open hand-off in `botHandoffs.pending(botId)`, a pending approval or question card, or a computer give-back in progress)
- Modify: `main/services/scheduled-bot-routines.ts:256` (a run stopped by the watchdog records `failure: {kind: "stalled", code: "no_progress"}`)

**Interfaces:**
- Produces:
  ```ts
  export const BOT_RUN_STALL_MS = 10 * 60_000;
  export const BOT_RUN_WATCHDOG_INTERVAL_MS = 60_000;
  export function createBotRunWatchdog(deps: {
    running(): string[]; lastProgressAt(botId: string): number | undefined; runKind(botId: string): "routine" | "attended" | null;
    isWaitingOnPerson(botId: string): boolean; stopForStall(botId: string): Promise<void>; raiseStall(botId: string): Promise<void>;
    now(): number; setInterval(fn: () => void, ms: number): { cancel(): void };
  }): { snooze(botId: string): void; dispose(): void };
  ```
  `stopForStall` calls `BotSessionService.stop(botId)` and marks the stop as a stall, so the executor classifies it `stalled`. `raiseStall` raises a `run_stalled` issue with `stop_run` and `keep_waiting`. Snoozing adds another `BOT_RUN_STALL_MS`.

- [ ] **Step 1: Failing tests:**
  - `stops a routine run after 10 minutes without progress`;
  - `never stops or flags a run that waits on the person` (Review Focus 4);
  - `an attended run raises one issue and is not stopped`;
  - `keep waiting snoozes for another 10 minutes`;
  - `progress resets the timer`.
  - Then, through the executor with fakes: `a stalled routine records stalled and gets a retry`.
- [ ] **Step 2: Implement and wire.**
- [ ] **Step 3: Run** `npx tsx --test main/services/bot-runtime/bot-run-watchdog.test.ts main/services/scheduled-bot-routines.test.ts` and `npm run test:bot-runtime`. Expected: PASS.
- [ ] **Step 4: Register in `test:bot-runtime` and the CI registry, then commit:** "Recover Bot runs that stop making progress".

### Task 9: Claim check for Bot replies and routine results (S5)

**Files:**
- Create: `main/services/bot-runtime/bot-claim-check.ts`, `main/services/bot-runtime/bot-claim-check.test.ts`
- Modify: `main/services/scheduled-bot-routines.ts` (after a visible reply: check, record `ScheduledRun.claimCheck?: { stepIds: string[]; toolNames: string[] }` plus `failure: {kind: "tool_error", code: "unverified_success", toolName}`, and add the fixed line)
- Modify: `main/services/bot-runtime/live-projection.ts` (attach `claimCheck` to the projected assistant entry)
- Modify: `renderer/main/bots/bot-chat-pane.tsx` (show the existing chat "couldn't confirm" chip component; find it where `llm-client.ts` claim checks render in chats and reuse that component)

**Interfaces:**
- Produces:
  ```ts
  export function botRunTimeline(entries: readonly BotTranscriptSourceEntry[], requestId: string): GenerationTimeline; // tool steps from the pi.assistant/pi.tool entries between that request's pi.user and its answer
  export function checkBotRunClaims(text: string, entries: readonly BotTranscriptSourceEntry[], requestId: string, options?: ClaimCheckOptions): GenerationClaimCheck | undefined;
  export const BOT_ROUTINE_UNVERIFIED_LINE = "One step didn't work: {step}. Check the chat.";
  ```
- Consumes: `detectUnverifiedSuccessClaim` (`renderer/shared/claim-check.ts:150`), `ClaimCheckOptions.isConnectorTool` (connector tools are the Bot's MCP tools).

- [ ] **Step 1: Failing tests**, with Pi entry fixtures built the way `live-projection.test.ts` builds them:
  - `flags "I've sent the email" when the send tool failed`;
  - `does not flag when the matching step succeeded`;
  - `only reads the run's own steps`: a failed step from an earlier request is ignored.
  - Through the executor: `a flagged routine result stays success, records tool_error and adds the fixed line once`.
- [ ] **Step 2: Implement** using only the timeline adapter and the existing detector. Do not copy the detector's patterns.
- [ ] **Step 3: Run** `npx tsx --test main/services/bot-runtime/bot-claim-check.test.ts main/services/scheduled-bot-routines.test.ts renderer/shared/claim-check.test.ts`. Expected: PASS.
- [ ] **Step 4: Commit:** "Flag Bot replies that claim a failed step worked".

### Task 10: Docs, memory and the plan index

**Files:**
- Modify: `README.md` and `PRODUCT.md` (a Bots section: health, retries, auto-pause), `docs/aiden-remote-api-v1.md` (`bot:issues`, issue routes, the revision)
- Modify: `packages/cli/README.md` (the CLI Bot host shares retries, pause and failure kinds; issues are not shown in the CLI yet)
- Modify: `docs/plans/README.md` (a row for the three-plan program; Plan A status), and `.memory/bot-proactivity.md` (fix the stale revision 27 claim; add a "Self-healing (2026-10)" section with the new files and constants)
- Create: `.memory/bot-self-healing.md` (layout, constants, seams, known limits from spec §9)

- [ ] **Step 1:** Search the docs for statements this plan made stale: `rg -n "routine" README.md PRODUCT.md docs/*.md | rg -i "fail|retry|notification"`. Fix each one.
- [ ] **Step 2:** Run `npm run test:bot-health`, `npm run test:bot-runtime`, `npm run test:bots`, `npm run test:scheduled` and `node --test scripts/ci-test-registry.test.mjs`. Expected: PASS.
- [ ] **Step 3: Commit:** "Document Bot self-healing".
