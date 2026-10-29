# Bot autonomy B: proactive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bots respect quiet hours and a daily cap, learn from declined proposals, follow up on dated promises, and wake up on file changes, webhooks, new email and upcoming calendar events.

**Architecture:** Quiet hours and the cap are a gate in Plan A's delivery funnel. Proposal learning extends the existing proposal store and the `routines` tool. Follow-ups add one add-only tool to the existing memory review and propose through the existing proposal service.

Event triggers add a `routineTrigger` beside `routineSchedule` on Bot routines, a new `event` run trigger, and one dispatcher that enforces limits. Each source is a small adapter: a folder watch, a webhook route, and connector watches.

**Tech Stack:** TypeScript, Electron, Node `fs.watch` (recursive), Aiden Remote server (`aiden-remote-router.ts`), MCP client (`mcp.ts`), Swift, Kotlin, `tsx --test`.

**Spec:** [`docs/superpowers/specs/2026-10-27-bot-autonomy-design.md`](../specs/2026-10-27-bot-autonomy-design.md) §3 (D2, D3, D4), §6, §8, §10.

**Depends on:** Plan A Tasks 2 and 3 (the delivery funnel and Bot issues). It can start after those merge.

## Global Constraints

- Everything in Plan A's Global Constraints applies.
- The only new background network calls are connector watches (D2). They make no model call per poll, poll at most every 15 minutes, run only while the Mac is awake and Bots are open, and call read-only tools only. Nothing runs at startup beyond re-arming timers. The owner approved D2 on 2026-10-27, so Task 9 is blocked only on Task 8's spike passing.
- Webhooks are served only on Aiden Remote's LAN and Tailscale listeners (D3). There is no public relay.
- Event runs are unattended. Mutating MCP calls stay blocked (`bot-tool-assembly.ts:10-16`), and the `routines`, `hand_off` and memory tools stay withheld (`bot-tool-policy.ts:76-83`).
- Event payloads are untrusted data. Render them inside the existing escaped data-block style (`escapePromptText`, `bot-system-prompt.ts`). Never write them to memory.
- Older phones throw on an unknown schedule kind (`ios/AidenOnTheGo/Models/AidenBotRoutine.swift:100-127`, Android sealed class `models/AidenBotRoutine.kt:62`). Send `schedule: null` to clients without `bot:routine-triggers`.
- Interruption defaults (D4): `{ quietHours: { enabled: true, start: "22:00", end: "07:00" }, dailyLimit: 5 }`, in the Mac's time zone.

## Review Focus

1. **Quiet hours that cross midnight, plus a DST change.** 22:00–07:00 must hold on the night clocks change. Task 1 tests this.
2. **A file-change storm.** A sync client rewrites 500 files in the watched folder. Expect one coalesced run, with the payload capped at 50 paths. Task 6 tests this.
3. **A webhook replay or flood.** The same body arrives 100 times a minute. Expect at most one run per 5 minutes, and a 202 every time with no information leak. Task 7 tests this.
4. **A commitment due on a date the store would reject.** A promise made on 28 December, due 3 January. Expect the proposal to be accepted and to fire in January. Task 4 tests this.
5. **The person declines without choosing a reason.** Expect the dismissal to count toward cooling off, with `reason` absent. Task 3 tests this.

---

### Task 1: The interruption setting and the delivery gate (P4, part 1)

**Files:**
- Modify: `renderer/shared/bots.ts:115-160`. Add `BotInterruptions`, `DEFAULT_BOT_INTERRUPTIONS`, `parseBotInterruptions`, `BotDefinition.interruptions?` and `BotUpdateInput.interruptions?`, following `chatActivity`.
- Modify: `main/services/bot-store-core.ts:112,264-280`. Normalize on read, place the field last, and handle it in `update`.
- Modify: `main/handlers/bot-params.ts:34,108` (strict IPC keys)
- Create: `main/services/bot-delivery/gate.ts`, `main/services/bot-delivery/gate.test.ts`, `main/services/bot-delivery/flush.ts`
- Modify: `main/services/bot-delivery/funnel-main.ts`. Replace `ALWAYS_NOW_GATE` with the real gate and start the flush.

**Interfaces:**
- Produces:
  ```ts
  export interface BotInterruptions { quietHours: { enabled: boolean; start: string; end: string }; dailyLimit: number } // HH:MM; dailyLimit 0–20
  export const DEFAULT_BOT_INTERRUPTIONS: BotInterruptions;
  export function parseBotInterruptions(value: unknown): BotInterruptions; // throws "Invalid interruption settings."
  export function decideBotDelivery(input: {
    settings: BotInterruptions; class: BotDeliveryClass; now: number; timeZone: string; sentToday: number;
  }): { kind: "now" } | { kind: "defer"; until: number } | { kind: "suppress"; reason: "daily_limit" };
  export function createBotDeliveryGate(deps: { settings(botId: string): Promise<BotInterruptions>; sentToday(botId: string, now: number, timeZone: string): Promise<number>; timeZone(): string }): BotDeliveryGate;
  export function createBotDeliveryFlush(deps: { log: BotDeliveryLog; funnelSend(row: BotDeliveryRow): Promise<void>; now(): number; setTimer(fn: () => void, ms: number): { cancel(): void } }): { rearm(): Promise<void>; dispose(): void };
  ```
- Rules (spec §6 P4):
  - `issue` ignores the limit but is deferred during quiet hours.
  - `routine_result` and `proposal` are deferred during quiet hours, and suppressed when `sentToday >= dailyLimit`.
  - The first suppressed item of a day logs one `digest` row: "More updates are in the chat".
  - When quiet hours end, the flush sends due deferred rows as one digest per Bot ("While you were away: {n} updates") instead of n banners. Phones still see each row.
- `sentToday` counts rows with a `sentAt` in the Bot's local day, classes `routine_result | proposal | digest`.

- [ ] **Step 1: Failing gate tests** in `gate.test.ts`, with explicit time zones through `Intl` (no local-machine time zone):
  - `defers a routine result at 23:00 until 07:00 the next day`.
  - `quiet hours across the spring DST change still end at 07:00 local` (Review Focus 1). Use `America/New_York` on 2027-03-14.
  - `issues ignore the daily limit but wait out quiet hours`.
  - `suppresses the sixth routine result of the day`.
  - `quietHours.enabled false never defers`.
  - `start equal to end means no quiet hours`.
  - `parseBotInterruptions rejects 24:00, dailyLimit 21 and extra keys`.
- [ ] **Step 2: Failing flush test:** `three deferred rows produce one digest banner and stay three rows for phones`.
- [ ] **Step 3: Implement** `decideBotDelivery` as a pure function over local wall time computed with `Intl.DateTimeFormat(…, {timeZone})`, then the gate, the flush and the store field. Extend `bot-store-core` tests: `interruptions round-trips and an absent value reads as the default`.
- [ ] **Step 4: Run** `npx tsx --test main/services/bot-delivery/*.test.ts main/services/bot-store-core.test.ts`. Expected: PASS.
- [ ] **Step 5: Register in a new `"test:bot-proactive"` script and the CI registry, then commit:** "Hold Bot messages during quiet hours and over a daily limit".

### Task 2: Interruption settings UI and Remote (P4, part 2)

**Files:**
- Create: `renderer/main/bots/bot-interruptions-page.tsx`, `renderer/main/bots/bot-interruptions-page.test.tsx`
- Modify: `renderer/main/bots/bot-advanced.tsx` (a row "Interruptions" opening the page), `renderer/main/bots-view.tsx:147-170` (the sub-page switch)
- Modify: `main/services/aiden-remote-protocol.ts`:
  - the capability `bot:interruptions`;
  - `AidenRemoteBotDetail.interruptions?`;
  - PATCH through `parseAidenRemoteBotIdentityPatchRequest(…, { allowInterruptions })`, beside `allowChatActivity` at `:2820`.
- Modify: `main/services/aiden-remote-bots.ts:251,489,713`, iOS `Features/Bots/AidenBotAdvancedView.swift` plus a new `AidenBotInterruptionsView.swift`, Android `features/bots/AidenBotAdvancedScreen.kt` plus a new `AidenBotInterruptionsScreen.kt`

- [ ] **Step 1: Failing renderer tests:**
  - `shows Quiet hours on, 10:00 PM to 7:00 AM, and Up to 5 a day by default`;
  - `turning quiet hours off saves enabled false`;
  - `the limit stepper stays within 0 and 20`.
- [ ] **Step 2: Implement** with the settings design system: one grouped card, a switch row, two time rows and a stepper row. Footnote: "Alerts that need you still arrive after quiet hours." Keep the focus-visible rings.
- [ ] **Step 3: Remote and native:**
  - `PATCH with interruptions is rejected unless bot:interruptions was negotiated`;
  - `detail carries interruptions`;
  - native decode and save tests.
- [ ] **Step 4: Run** the renderer, Remote and native suites. Expected: PASS.
- [ ] **Step 5: Commit:** "Let people set a Bot's quiet hours and daily limit".

### Task 3: Learn from accepted and declined proposals (P3)

**Files:**
- Modify: `renderer/shared/bot-routine-proposals.ts` (decline reasons)
- Modify: `main/services/bot-routine-proposals.ts:35,81,250-330` (store the reason; `recentDecisions`; `cooling_off` and `declined_before` refusals)
- Modify: `main/services/schedule-tool.ts:1817-1847` (`list` returns `recentDecisions`; `propose` surfaces the new codes)
- Modify: `renderer/components/bots/routine-proposal-card.tsx` ("Not now" reveals four optional chips)
- Modify: `main/services/aiden-remote-protocol.ts:1273` (respond body `{ decision, reason? }` behind `bot:proposal-reasons`), `main/services/aiden-remote-bot-session.ts:1585`
- Modify: the iOS `AidenBotRoutineProposalCardView` (`AidenBotSessionChatView.swift:1307`) and the Android `AidenBotRoutineProposalCard` (`AidenBotSessionScreen.kt:790`)
- Test: `main/services/bot-routine-proposals.test.ts`, `main/services/schedule-tool.test.ts` (the Bot routines tool cases), `renderer/components/bots/routine-proposal-card.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type BotRoutineProposalDeclineReason = "not_useful" | "wrong_time" | "already_have" | "other";
  export interface BotRoutineProposalRespondInput { botId: string; proposalId: string; decision: BotRoutineProposalDecision; reason?: BotRoutineProposalDeclineReason }
  export interface BotRoutineProposalDecisionSummary { name: string; label: string; status: "accepted" | "dismissed"; reason?: BotRoutineProposalDeclineReason; decidedAt: number }
  export const BOT_ROUTINE_PROPOSAL_COOLING = { window: 5, dismissals: 3, coolMs: 7 * 86_400_000, sameNameMs: 30 * 86_400_000, recent: 10 } as const;
  // propose result adds: { ok: false; code: "cooling_off"; until: number } | { ok: false; code: "declined_before"; name: string }
  ```
- Names are normalized for `declined_before` by lower-casing, trimming and collapsing whitespace.
- Chip labels (exact): "Not useful", "Wrong time", "Already have this", "Something else". The chips appear only after "Not now". Tapping a chip, or "Skip", settles the proposal.

- [ ] **Step 1: Failing store tests:**
  - `a dismissal keeps its reason`;
  - `a dismissal without a reason still counts toward cooling off` (Review Focus 5);
  - `three dismissals in the last five proposals refuse new proposals for 7 days`;
  - `an accepted proposal in between does not reset the window early`. Count the five most recent settled proposals.
  - `the same name dismissed within 30 days is refused`;
  - `recentDecisions lists at most 10, newest first`.
- [ ] **Step 2: Failing tool test:** `routines list returns routines and recentDecisions; propose returns cooling_off with until`.
- [ ] **Step 3: Failing card test:** `Not now reveals four chips; choosing Wrong time responds dismiss with reason wrong_time; Skip responds with no reason`.
- [ ] **Step 4: Implement.** Update the `routines` tool description so the model reads `recentDecisions` and avoids the same idea or time.
- [ ] **Step 5: Remote and native:**
  - `reason is dropped unless bot:proposal-reasons is negotiated`;
  - `unknown reason is 400`;
  - native chip tests.
- [ ] **Step 6: Run** the proposal, tool, card, Remote and native suites. Expected: PASS.
- [ ] **Step 7: Commit:** "Learn from routine proposals the person declines".

### Task 4: Follow-ups on dated promises (P2)

**Files:**
- Create: `renderer/shared/bot-commitments.ts`, `main/services/bot-commitments/store.ts`, `main/services/bot-commitments/proposer.ts`, `main/services/bot-commitments/tool.ts`
- Create: `main/services/bot-commitments/proposer.test.ts`, `main/services/bot-commitments/tool.test.ts`
- Modify: `main/services/bot-memory/review.ts:94,152-200`. Give the review the `note_follow_up` tool next to the add-only memory tool, and add review prompt lines for dated promises.
- Modify: `main/services/schedule-store-core.ts:172` (`once` dates are accepted within the next 366 days instead of the current year only), `renderer/shared/bot-routine-label.ts:54` (a year shown when it is not the current year, as `currentYear` already allows)
- Modify: `main/services/bot-runtime/bot-session-main.ts:204` (wire the store and proposer; Bot delete calls `forgetBot`)

**Interfaces:**
- Produces:
  ```ts
  export interface BotCommitment { id: string; botId: string; text: string; dueDate: string; dueTime?: string; createdAt: number; status: "waiting" | "proposed" | "accepted" | "dismissed" | "expired"; proposalId?: string }
  export const BOT_COMMITMENT_LIMITS = { waiting: 32, textChars: 200, maxDaysAhead: 60 } as const;
  export function createBotCommitmentStore(options: { profileDir(): string; now?(): number }): { add(botId: string, input: { text: string; dueDate: string; dueTime?: string }): Promise<{ ok: true; commitment: BotCommitment } | { ok: false; code: "invalid" | "full" | "duplicate"; error: string }>; list(botId: string): Promise<BotCommitment[]>; update(botId: string, id: string, patch: Partial<Pick<BotCommitment, "status" | "proposalId">>): Promise<void>; forgetBot(botId: string): Promise<void> };
  export function createBotCommitmentProposer(deps: { commitments: ReturnType<typeof createBotCommitmentStore>; proposals: { propose(botId: string, input: BotRoutineCreateInput & { reason?: string }): Promise<{ ok: boolean; code?: string; proposalId?: string }>; pendingCount(botId: string): Promise<number> }; timeZone(): string; now(): number }): { pump(botId: string): Promise<void>; onProposalSettled(botId: string, proposalId: string, status: "accepted" | "dismissed"): Promise<void> };
  export function createNoteFollowUpTool(deps: { botId: string; store: …; onAdded(botId: string): void }): AgentTool; // name "note_follow_up", params { text, due_date, due_time? }
  ```
- Proposal shape:
  - name `"Follow up: {text, first 40 chars}"`;
  - schedule `{ kind: "once", date: dueDate, time: dueTime ?? "09:00" }`;
  - prompt `"Follow up on: {text}. Check whether it is done and tell the person briefly. If there is nothing to say, reply [SILENT]."`;
  - reason `"You asked me to follow up on this."`
- A `waiting` commitment whose due date has passed becomes `expired` during `pump`.

- [ ] **Step 1: Failing tests:**
  - `tool rejects a due date in the past or more than 60 days ahead`.
  - `proposes the oldest waiting commitment when fewer than two proposals are pending`.
  - `waits while two proposals are pending and proposes when one settles`.
  - `a 28 December promise due 3 January is proposed and accepted by the store` (Review Focus 4). Run it through `schedule-store-core` normalization with a fake clock.
  - `an expired commitment is never proposed`.
  - `duplicate text and due date is refused`.
  - In the review suite: `the review can note a follow-up only from person turns`. Reuse the existing provenance fixtures and show that a routine input's promise is ignored.
- [ ] **Step 2: Implement.** Wire `onProposalSettled` from the proposal service's `respond`.
- [ ] **Step 3: Run** `npx tsx --test main/services/bot-commitments/*.test.ts main/services/bot-memory/review.test.ts main/services/schedule-store-core.test.ts`. Expected: PASS.
- [ ] **Step 4: Register and commit:** "Turn a Bot's dated promises into follow-up proposals".

### Task 5: The routine trigger model and event runs (P1 foundation)

**Files:**
- Create: `renderer/shared/bot-routine-trigger.ts`, `renderer/shared/bot-routine-trigger.test.ts`
- Create: `main/services/bot-routine-events/dispatcher.ts`, `main/services/bot-routine-events/dispatcher.test.ts`
- Modify: `main/services/types.ts:516` (`ScheduledTask.routineTrigger?`, `pendingRoutineEvents?: Array<{ eventId: string; payload: string; at: number; requestId: string }>`, at most 4)
- Modify: `main/services/schedule-store-core.ts:137,172,354` (a Bot routine has exactly one of `routineSchedule` or `routineTrigger`; an event routine has `cron: ""` and no `nextRunAt`)
- Modify: `main/services/schedule-service-core.ts:16,274,411,570`:
  - the trigger `{ kind: "event"; eventId: string; source: BotRoutineTrigger["kind"] }`;
  - `schedule()` skips event routines;
  - `dispatch` admits a pending event;
  - startup replays pending events.
- Modify: `main/services/scheduled-bot-routines.ts:35,53,156,401-640`:
  - request id `routine:<taskId>:event-<eventId>`;
  - `botRoutineMessage(prompt, notes, eventBlock?)`;
  - `routineLabel`;
  - `parseBotRoutineCreate` and `parseBotRoutineUpdate` accept `trigger` in place of `schedule`;
  - `projectBotRoutine` exposes `trigger`.
- Modify: `renderer/shared/bot-routine-label.ts` (trigger labels), `main/services/schedule-tool.ts:1767` (the TypeBox schema; `propose` keeps time schedules only, since event routines are created by the person)

**Interfaces:**
- Produces:
  ```ts
  export type BotRoutineTrigger =
    | { kind: "file_change"; folder: string; pattern?: string }
    | { kind: "webhook"; tokenHash: string }
    | { kind: "new_email"; connectionId: string; filter: string; everyMinutes: 15 | 30 | 60 }
    | { kind: "calendar_soon"; connectionId: string; leadMinutes: 10 | 30 | 60; everyMinutes: 15 | 30 };
  export function parseBotRoutineTrigger(value: unknown): BotRoutineTrigger; // folder: relative, no "..", ≤ 200; pattern ≤ 64; filter ≤ 200
  export function formatBotRoutineTriggerLabel(trigger: BotRoutineTrigger, connectionName?: string): string;
  export const BOT_ROUTINE_EVENT_LIMITS = { minGapMs: 5 * 60_000, perDay: 24, payloadChars: 4_000, coalesceMs: 30_000, seenIds: 200 } as const;
  export function botRoutineEventBlock(source: BotRoutineTrigger["kind"], payload: string): string; // escaped untrusted block, ≤ payloadChars
  export interface BotRoutineEventDispatcher { emit(taskId: string, event: { eventId: string; payload: string }): Promise<"queued" | "duplicate" | "too_soon" | "daily_limit" | "not_event_routine" | "disabled"> }
  export function createBotRoutineEventDispatcher(deps: { store: …; dispatch(taskId: string, trigger: ScheduledRunTrigger): Promise<void>; now(): number }): BotRoutineEventDispatcher;
  ```
- `tokenHash` is host-owned. `parseBotRoutineCreate` and `parseBotRoutineUpdate` accept `{ kind: "webhook" }` only. The host mints the token on save (Task 7) and never accepts a hash or token from IPC or Remote input.
- Labels (exact):
  - `"When files change in {folder}"`
  - `"When this routine's link is called"`
  - `"When new email matches “{filter}”"`
  - `"{lead} min before calendar events"`
- A `too_soon` event is not dropped. It is held as the single pending event and runs when the gap allows, so the newest payload wins.

- [ ] **Step 1: Failing trigger tests:**
  - `parse rejects a folder with ..`;
  - `parse rejects everyMinutes 5`;
  - `labels read as above`;
  - `a routine with both schedule and trigger is rejected by parseBotRoutineCreate`.
- [ ] **Step 2: Failing dispatcher tests:**
  - `dedupes an event id`;
  - `holds an event that arrives within 5 minutes and runs it when the gap passes`;
  - `the 25th event of the day is refused`;
  - `a disabled or paused routine refuses events`.
  - Through `schedule-service-core` with a fake clock: `a pending event replays once after restart`, and `an event routine never gets a cron job`.
- [ ] **Step 3: Failing executor test:** `an event run's input has notes, then the escaped event block, then the prompt and the silence rule`. Assert the order and that `</` sequences in the payload are escaped.
- [ ] **Step 4: Implement.** Keep `routineSchedule` behavior byte-for-byte for time routines. The existing schedule tests are the guard.
- [ ] **Step 5: Run** `npx tsx --test renderer/shared/bot-routine-trigger.test.ts main/services/bot-routine-events/dispatcher.test.ts main/services/schedule-service-core.test.ts main/services/schedule-store-core.test.ts main/services/scheduled-bot-routines.test.ts renderer/shared/bot-routine-label.test.ts` and `npm run test:scheduled`. Expected: PASS.
- [ ] **Step 6: Register and commit:** "Let Bot routines run when something happens".

### Task 6: File-change triggers

**Files:**
- Create: `main/services/bot-routine-events/folder-watch.ts`, `main/services/bot-routine-events/folder-watch.test.ts`, `main/services/bot-routine-events/sources-main.ts`

**Interfaces:**
- Produces:
  ```ts
  export function createBotFolderWatches(deps: {
    routines(): Promise<ScheduledTask[]>;                 // enabled event routines with kind file_change
    homePath(botId: string): Promise<string>;             // botManagedWorkspace.resolve(botId).homePath
    watch(path: string, options: { recursive: true }, listener: (event: string, file: string | null) => void): { close(): void }; // fs.watch
    dispatcher: BotRoutineEventDispatcher; now(): number; setTimer(fn: () => void, ms: number): { cancel(): void };
  }): { rearm(): Promise<void>; dispose(): void };
  ```
- Behavior:
  - The resolved folder must stay inside the Bot home, after `realpath`; otherwise the routine raises a `routine_failed` issue and is not watched.
  - Changes are coalesced for 30 s. Up to 50 relative paths go in the payload, with `"and {n} more"` after that.
  - The event id is the sha256 of the sorted path list plus the window start.
  - Changes under `.aiden/` inside the home are ignored, so the Bot's own skills and state don't trigger it.
  - On a platform where recursive `fs.watch` is unavailable (check `main/services/host-platform-capabilities.ts`), the trigger kind is not offered.

- [ ] **Step 1: Failing tests**, with a fake `watch` and timers:
  - `500 rapid changes produce one event with 50 paths and "and 450 more"` (Review Focus 2);
  - `a folder that resolves outside the home is refused and raises one issue`;
  - `changes under .aiden are ignored`;
  - `rearm closes watches for deleted routines`.
- [ ] **Step 2: Implement and wire** in `sources-main.ts`. It re-arms on `bots:changed`, and only once Bots are open, never during onboarding.
- [ ] **Step 3: Run** the folder-watch tests. Expected: PASS.
- [ ] **Step 4: Commit:** "Run a Bot routine when files change in its folder".

### Task 7: Webhook triggers

**Files:**
- Create: `main/services/bot-routine-events/webhook.ts`, `main/services/bot-routine-events/webhook.test.ts`
- Modify: `main/services/aiden-remote-router.ts:460` (route template `POST /hooks/bot-routines/:token`, unauthenticated except for the token, like `/health`), `main/services/aiden-remote-service.ts` (body limit)
- Modify: `main/handlers/` (IPC `bots:routines:webhook:rotate` returns the URL once)
- Modify: `docs/aiden-remote-api-v1.md` §2 (the list of unauthenticated routes)

**Interfaces:**
- Produces:
  ```ts
  export const BOT_WEBHOOK_LIMITS = { tokenBytes: 32, bodyBytes: 16_384 } as const;
  export function mintBotWebhookToken(): { token: string; tokenHash: string }; // base64url token; sha256 hex hash stored in routineTrigger.tokenHash
  export function createBotWebhookHandler(deps: { findRoutineByTokenHash(hash: string): Promise<ScheduledTask | undefined>; dispatcher: BotRoutineEventDispatcher; now(): number }): (request: { token: string; contentType?: string; body: Uint8Array }) => Promise<{ status: 202 | 404 | 413 | 415 }>;
  ```
- Behavior:
  - An unknown token returns 404.
  - Too large returns 413. Accepted types are `application/json` and `text/plain`; anything else returns 415.
  - Otherwise it returns 202, whatever the dispatcher says. The response has no body and does not reveal whether the event ran.
  - The payload is the body text, or pretty-printed JSON, capped by the event limits.
  - The event id is the sha256 of the body plus a 1-minute time bucket, so identical replays within a minute dedupe.
- URL shown to the person: `http://{the Mac's Remote LAN or Tailscale address}:{port}/hooks/bot-routines/{token}`, with copy "Works on your network or Tailscale while this Mac is awake." Rotating the token invalidates the old URL.

- [ ] **Step 1: Failing tests:**
  - `a valid token queues one event and returns 202`;
  - `the same body 100 times in a minute queues once and always returns 202` (Review Focus 3);
  - `an unknown token is 404`, `17 KiB is 413`, `image/png is 415`;
  - `the token is compared by hash only`: the stored task has no raw token.
  - A router register-and-invoke test (in the existing router test style): `the hooks route needs no device credential but other routes still do`.
- [ ] **Step 2: Implement.** The route exists only when Aiden Remote is listening (LAN or Tailscale). Nothing new listens on the network.
- [ ] **Step 3: Run** the webhook tests and `npx tsx --test main/services/aiden-remote-router.test.ts`. Expected: PASS.
- [ ] **Step 4: Commit:** "Run a Bot routine when its link is called".

### Task 8: Spike for email and calendar watches

**Files:**
- Create: `docs/research/bot-connector-watch-spike.md`

- [x] **Step 1:** D2 confirmed by the owner on 2026-10-27: allow, as a visible watch.
- [ ] **Step 2:** With a test Composio account and the iMCP calendar connector, record:
  - the exact read-only tool names and input schemas for "list recent email matching a query" and "list events in a time range";
  - their stable item ids;
  - pagination;
  - what each poll costs in Composio rate limits.

  Use `inspectConfiguredMcpToolsForBotCatalog` (`main/services/mcp.ts:255`) output and one manual call per tool. Record no personal data in the doc.
- [ ] **Step 3:** Decide which connectors get an adapter. Write the adapter table: connector id, tool, arguments template, item id path, summary fields (sender, subject and time; or title and start time).
- [ ] **Step 4: Commit** the spike doc.

### Task 9: Email and calendar watches (blocked on Task 8)

**Files:**
- Create: `main/services/bot-routine-events/connector-watch.ts`, `main/services/bot-routine-events/connector-adapters.ts`, `main/services/bot-routine-events/connector-watch.test.ts`
- Modify: `main/services/bot-routine-events/sources-main.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ConnectorWatchAdapter { id: string; matches(serverId: string, toolNames: readonly string[]): boolean; kind: "new_email" | "calendar_soon"; poll(call: (tool: string, args: unknown, signal: AbortSignal) => Promise<unknown>, trigger: BotRoutineTrigger, cursor: string | undefined, signal: AbortSignal): Promise<{ items: Array<{ id: string; summary: string }>; cursor: string }> }
  export function createBotConnectorWatches(deps: { routines(): Promise<ScheduledTask[]>; adapters: readonly ConnectorWatchAdapter[]; callReadOnlyTool(botId: string, connectionId: string, tool: string, args: unknown, signal: AbortSignal): Promise<unknown>; cursors: { get(taskId: string): Promise<string | undefined>; set(taskId: string, cursor: string): Promise<void> }; dispatcher: BotRoutineEventDispatcher; awake(): boolean; now(): number; setTimer(fn: () => void, ms: number): { cancel(): void } }): { rearm(): Promise<void>; dispose(): void };
  ```
- `callReadOnlyTool` goes through the Bot's grant (`botMcpLiveToolMatchesGrant`, `bot-tool-sources-main.ts:318-347`) and refuses any tool the adapter doesn't name.
- The first poll seeds the cursor and never fires. Seen item ids are kept, at most 200.
- A poll failure counts as a `temporary` failure for that routine and backs off to twice the interval. After three failed polls in a row it raises an issue through Plan A's recovery.

- [ ] **Step 1: Failing tests:**
  - `first poll seeds and does not fire`;
  - `new items fire one event with summaries`;
  - `no poll while asleep or before Bots open`;
  - `a tool outside the adapter is refused`;
  - `three failed polls raise one issue`;
  - `a revoked connection stops the watch and raises an issue`.
- [ ] **Step 2: Implement** the adapters from the spike's table only.
- [ ] **Step 3: Run** the tests. Expected: PASS.
- [ ] **Step 4: Commit:** "Run a Bot routine on new email or an upcoming event".

### Task 10: The trigger editor on desktop, labels on phones

**Files:**
- Modify: `renderer/main/bots/bot-routine-editor.tsx:69-96,225-291`. Add a "When" choice: "At a time" or "When something happens", with source rows shown only when available:
  - file: always on supported platforms;
  - link: when Aiden Remote is on;
  - email and calendar: when the Bot has a connection that a Task 9 adapter matches.
- Modify: `renderer/main/bots/bot-routines.tsx:113-126` (the routine row shows the trigger label)
- Modify: `main/services/aiden-remote-protocol.ts:1508,5868` (`trigger` behind `bot:routine-triggers`; `schedule: null` for other clients), `main/services/aiden-remote-bot-session.ts:2223`
- Modify: iOS `Models/AidenBotRoutine.swift` (decode `trigger`; the label is read-only), `Features/Bots/AidenBotRoutinesView.swift`. Android `models/AidenBotRoutine.kt`, `features/bots/AidenBotRoutines.kt`.
- Modify: `packages/cli/src/bots.ts` (list shows the trigger label)
- Test: `renderer/main/bots/bot-routine-editor.test.tsx`, the Remote protocol tests, native decode tests

- [ ] **Step 1: Failing tests:**
  - `choosing When files change asks for a folder inside the Bot's folder and saves a file_change trigger`;
  - `the link option shows the URL once after saving, with Copy`;
  - `email is hidden when the Bot has no matching connection`;
  - `a client without bot:routine-triggers receives schedule null`;
  - `iOS and Android decode a trigger routine and show its label`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** the editor, Remote and native suites. Expected: PASS.
- [ ] **Step 4: Commit:** "Edit routines that run when something happens".

### Task 11: Docs, memory and the plan index

**Files:**
- Modify:
  - `README.md` and `PRODUCT.md` (event routines, quiet hours, follow-ups);
  - `docs/aiden-remote-api-v1.md` (three capabilities, the webhook route, the revision);
  - `packages/cli/README.md`;
  - the network-posture paragraph in `docs/superpowers/specs/2026-10-09-bot-memory-soul-proactivity-design.md` §11.5/§13: add a dated amendment line pointing to D2/D3, without rewriting history.
- Modify: `docs/plans/README.md` (Plan B status), `.memory/bot-proactivity.md` (new sections: triggers, interruptions, commitments, proposal learning)
- Modify: `renderer/components/onboarding-feature-gallery.tsx` only if the owner wants event routines in the tour. Ask; there is no default tile.

- [ ] **Step 1:** Search for stale claims: `rg -n "no hidden heartbeat|long-polling only|current year" docs README.md PRODUCT.md`. Update or amend each.
- [ ] **Step 2:** Run `npm run test:bot-proactive`, `npm run test:scheduled`, `npm run test:bots` and `node --test scripts/ci-test-registry.test.mjs`. Expected: PASS.
- [ ] **Step 3: Commit:** "Document proactive Bots".
