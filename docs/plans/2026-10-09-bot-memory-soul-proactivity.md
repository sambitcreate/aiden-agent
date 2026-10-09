# Bot memory, soul and proactivity: implementation plan

- **Status:** In progress (planned 2026-10-09).
- **Spec:** [`docs/superpowers/specs/2026-10-09-bot-memory-soul-proactivity-design.md`](../superpowers/specs/2026-10-09-bot-memory-soul-proactivity-design.md). Section numbers below (§n) refer to the spec.
- **Branch:** `feature/bots-memory-soul`, stacked on PR #428.
- **Tracks:** Three tracks run in parallel worktrees cut from that branch after **Step 0** lands.
- **File ownership:** Each file has exactly one owner (listed at the end). A track never edits a file it does not own. Where it needs something from a file it doesn't own, this plan states the exact interface, and the owner delivers it.

Rules for every track: read `AGENTS.md` first (test rules, onboarding rule, Remote revision rule, settings design system, no brain icons, `MemoryCardIcon`); behavioural tests only; do not commit (the orchestrator commits); never use `git stash`; pre-1.0, delete legacy shapes rather than migrate. Each track writes its own memory note (A `.memory/bot-memory-soul.md`, B `.memory/bot-proactivity.md`, C `.memory/bot-memory-clients.md`). `package.json` is **orchestrator-owned**: each track lists its new test files in its definition of done, and the orchestrator registers them (A in `test:bot-runtime`, B in `test:bots`, desktop C in the script that already runs `bot-chat-pane.test.tsx`), resolving the `test` chain by union.

## Contracts

### Step 0: orchestrator lands this before forking the tracks

1. **Create** `renderer/shared/bot-memory.ts`. Ownership passes to A afterwards.

```ts
export type BotMemoryTarget = "memory" | "user";
export const BOT_MEMORY_LIMITS = { memoryChars: 2_200, userChars: 1_375, entryChars: 500 } as const;
export const BOT_MEMORY_ENTRY_DELIMITER = "\n§\n";
/** Conversation entry written by background review / compaction flush. */
export const BOT_MEMORY_REVIEW_ENTRY_KIND = "aiden.memory-review";
export type BotMemorySource = "turn" | "review" | "compaction";
export interface BotMemoryReviewEntryData {
  source: Exclude<BotMemorySource, "turn">;
  added: number;
  targets: BotMemoryTarget[];
  failed?: true;
}
/** `id` = first 16 hex of sha256(target + "\0" + text); content-addressed. */
export interface BotMemoryEntry { id: string; text: string }
export interface BotMemoryStoreView {
  entries: BotMemoryEntry[];
  usedChars: number;
  limitChars: number;
  overBudget: boolean;
}
export interface BotMemoryView {
  botId: string;
  /** First 16 hex of sha256 over both files. */
  revision: string;
  /** False when a file could not be read/decoded; only "clear" is offered. */
  readable: boolean;
  memory: BotMemoryStoreView;
  user: BotMemoryStoreView;
  /** Epoch ms of the newest write, or null when nothing was ever saved. */
  updatedAt: number | null;
}
export type BotMemoryEdit =
  | { kind: "replace"; target: BotMemoryTarget; entryId: string; text: string }
  | { kind: "remove"; target: BotMemoryTarget; entryId: string }
  | { kind: "clear" };
export interface BotMemoryEditInput { botId: string; edit: BotMemoryEdit }
export type BotMemoryEditErrorCode = "entry_not_found" | "over_budget" | "blocked" | "invalid";
export type BotMemoryEditResult =
  | { ok: true; view: BotMemoryView }
  | { ok: false; code: BotMemoryEditErrorCode; message: string; view: BotMemoryView };
export interface BotMemoryChangedEvent { botId: string; revision: string }
export const BOT_MEMORY_CHANNELS = {
  get: "bots:memory:get",       // invoke(botId) → BotMemoryView
  edit: "bots:memory:edit",     // invoke(BotMemoryEditInput) → BotMemoryEditResult
  changed: "bots:memory:changed", // push BotMemoryChangedEvent
} as const;
```

2. **Create** `renderer/shared/bot-routine-proposals.ts`. Ownership passes to B afterwards.

```ts
import type { BotRoutineSchedule } from "./bot-routine-schedule.js";
export const BOT_ROUTINE_PROPOSAL_ENTRY_KIND = "aiden.routine-proposal";
export const BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND = "aiden.routine-proposal-status";
export type BotRoutineProposalStatus = "pending" | "accepted" | "dismissed";
export interface BotRoutineProposalEntryData {
  proposalId: string;           // UUID minted by the tool
  name: string;                 // ≤ BOT_ROUTINE_NAME_LIMIT
  prompt: string;               // ≤ BOT_ROUTINE_PROMPT_LIMIT
  schedule: BotRoutineSchedule;
  timezone: string;
  label: string;                // host label, e.g. "Every day at 9:00 AM"
  reason?: string;              // ≤ 280
}
export interface BotRoutineProposalStatusEntryData {
  proposalId: string;
  status: Exclude<BotRoutineProposalStatus, "pending">;
  routineId?: string;
}
export type BotRoutineProposalDecision = "accept" | "dismiss";
export interface BotRoutineProposalRespondInput {
  botId: string; proposalId: string; decision: BotRoutineProposalDecision;
}
export interface BotRoutineProposalRespondResult {
  status: Exclude<BotRoutineProposalStatus, "pending">; routineId?: string;
}
export const BOT_ROUTINE_PROPOSAL_CHANNELS = { respond: "bots:routineProposals:respond" } as const;
export interface BotRoutineSuggestion {
  id: "daily-check-in"; name: string; prompt: string; schedule: BotRoutineSchedule;
}
export const BOT_DAILY_CHECKIN_SUGGESTION: BotRoutineSuggestion = {
  id: "daily-check-in",
  name: "Daily check-in",
  schedule: { kind: "daily", time: "09:00" },
  prompt: "Check in briefly. Using what you remember about me and anything new you can see, share one or two things worth knowing today.",
};
```

3. **Edit** `renderer/shared/bot-live.ts` (additive; ownership stays A). Add these variants to `BotTranscriptEntry`:

```ts
  | { id: string; type: "memory_update"; targets: BotMemoryTarget[]; source: BotMemorySource; at?: number }
  | { id: string; type: "routine_proposal"; proposal: BotRoutineProposalEntryData;
      status: BotRoutineProposalStatus; routineId?: string; at?: number }
```

   Then run `npm run type-check`. For every exhaustive switch the compiler flags, add a no-op branch (`return null` or `break`) and nothing else. Expected sites are `renderer/main/bots/bot-transcript-rows.ts` and `main/services/aiden-remote-bot-session.ts`.

4. **Create** the stub `main/services/bot-memory/bot-memory-main.ts`. Ownership passes to A, who replaces the body.

```ts
import type { BotMemoryEditInput, BotMemoryEditResult, BotMemoryView, BotMemoryChangedEvent } from "../../../renderer/shared/bot-memory.js";
export interface BotMemoryService {
  view(botId: string): Promise<BotMemoryView>;
  edit(input: BotMemoryEditInput): Promise<BotMemoryEditResult>;
  onChanged(listener: (event: BotMemoryChangedEvent) => void): () => void;
}
const unavailable = () => Promise.reject(new Error("Bot memory is not available yet."));
export const botMemoryService: BotMemoryService = { view: unavailable, edit: unavailable, onChanged: () => () => {} };
```

5. **Fixtures** (`protocol/aiden-remote/v1/fixtures/contract.json`; ownership passes to B):
   - Remove `openingGreeting` from `botDetail` and from any `botCreate`/`botIdentity` request.
   - Add the keys in the next section verbatim.
   - Do **not** bump `contractRevision` (B does that together with the TypeScript constant).

6. Run `npm run type-check` and `npm run test:aiden-remote`. Both must be green before the tracks fork.

### Remote wire shapes (revision 27, provisional; claimed at merge)

- Tokens: `bot-memory-v1` and `bot-proactive-v1`.
- Negotiable device capability: `bot:cards`.
- Timestamps are ISO-8601.
- Fixture keys and exact JSON:

```json
"botMemory": {"botId":"bot_fixture_01","revision":"9f2c1a0b7d3e4f51","readable":true,
  "memory":{"entries":[{"id":"a1b2c3d4e5f60718","text":"Weekly meal plan is vegetarian except Fridays."}],"usedChars":46,"limitChars":2200,"overBudget":false},
  "user":{"entries":[{"id":"0f1e2d3c4b5a6978","text":"Prefers short answers."},{"id":"1122334455667788","text":"Has two kids, Mia (8) and Leo (5)."}],"usedChars":58,"limitChars":1375,"overBudget":false},
  "updatedAt":"2026-08-19T15:00:00.000Z"},
"botMemoryEdit": {"request":{"edit":{"kind":"replace","target":"user","entryId":"0f1e2d3c4b5a6978","text":"Prefers short, friendly answers."}},
  "response":{"ok":true,"view":{"botId":"bot_fixture_01","revision":"7a7a7a7a7a7a7a7a","readable":true,
    "memory":{"entries":[{"id":"a1b2c3d4e5f60718","text":"Weekly meal plan is vegetarian except Fridays."}],"usedChars":46,"limitChars":2200,"overBudget":false},
    "user":{"entries":[{"id":"5e5e5e5e5e5e5e5e","text":"Prefers short, friendly answers."},{"id":"1122334455667788","text":"Has two kids, Mia (8) and Leo (5)."}],"usedChars":68,"limitChars":1375,"overBudget":false},
    "updatedAt":"2026-08-19T15:05:00.000Z"}},
  "errors":[{"status":404,"code":"memory_entry_not_found"},{"status":422,"code":"memory_over_budget"},{"status":422,"code":"memory_blocked"}]},
"botRoutineProposalRespond": {"request":{"decision":"accept"},"response":{"status":"accepted","routineId":"task_fixture_routine_03"}},
"botRoutineSuggestions": {"suggestions":[{"id":"daily-check-in","name":"Daily check-in","prompt":"Check in briefly. Using what you remember about me and anything new you can see, share one or two things worth knowing today.","schedule":{"kind":"daily","time":"09:00"},"label":"Every day at 9:00 AM"}]},
"botRoutineNotifications": {"notifications":[{"id":"run_fixture_bot_01","botId":"bot_fixture_01","botName":"Scout","routineId":"task_fixture_routine_01","routineName":"Morning brief","status":"succeeded","finishedAt":"2026-08-19T15:00:09.000Z","preview":"Your first meeting is at 9:30 with Priya."}],"now":"2026-08-19T15:01:00.000Z"},
"botSessionCards": {"botId":"bot_fixture_01","epoch":"epoch_fixture_01","seq":3,"state":"idle","interrupted":false,"partial":null,
  "entries":[{"type":"memory_update","id":"entry_20","createdAt":"2026-08-19T15:02:00.000Z"},
    {"type":"routine_proposal","id":"entry_21","proposalId":"7d0c5c8e-2f0b-4c4e-9a59-3b6f1f0e9a11","name":"Daily check-in","prompt":"Check in briefly…","label":"Every day at 9:00 AM","status":"pending","createdAt":"2026-08-19T15:02:05.000Z"},
    {"type":"routine_proposal","id":"entry_22","proposalId":"0b6b7a52-6d0a-4a59-8a1e-2a8b0c4f7e22","name":"Weekly meal plan","prompt":"Plan this week's meals.","label":"Every Sunday at 9:00 AM","status":"accepted","routineId":"task_fixture_routine_02","createdAt":"2026-08-19T15:03:00.000Z"}],
  "hasOlder":false,"question":null,"approval":null}
```

Routes (spec §14):

| Method | Path | Auth |
|---|---|---|
| `GET` | `/bots/{botId}/memory` | bot:read + chat:read |
| `POST` | `/bots/{botId}/memory/edits` | + bot:write, Idempotency-Key |
| `POST` | `/bots/{botId}/routine-proposals/{proposalId}/respond` | bot:read + bot:write, Idempotency-Key |
| `GET` | `/bots/{botId}/routine-suggestions` | bot:read |
| `GET` | `/bots/routine-notifications?since=` | bot:read + chat:read |

Rules:

- A device whose `accepts` lacks `bot:cards` never receives `memory_update` or `routine_proposal` entries.
- Revision-27 clients skip unknown entry types instead of throwing.
- `openingGreeting` is never emitted and is accepted-and-ignored in `POST /bots` and `PATCH /bots/{id}`.

### Cross-track interfaces

| Need | Provided by | Interface |
|---|---|---|
| B wires Remote memory routes | A | `botMemoryService` from `main/services/bot-memory/bot-memory-main.ts` (the Step 0 signature) |
| B appends proposal entries | existing | `(await botSessionRuntime()).conversation(botId)` then `conversation.submit({type:"write", entry:{kind, data}}, BACKGROUND_CONTEXT)`, the same as `appendConnectCard` |
| B catch-up trigger | existing | `onBotSessionStateChange` from `bot-runtime/bot-session-main.ts` |
| A withholds `bot_memory` on routine/intro turns | A only | A wraps `turnAllows` in `bot-session-main.ts`: `name === "bot_memory" ? !ids.some(id => id.startsWith("routine:") \|\| id.startsWith("intro:")) : botIngressAllowsTool(name, ids)`. **B never touches `bot_memory`.** |
| A projects proposal cards | A | A folds `BOT_ROUTINE_PROPOSAL_ENTRY_KIND` + `…_STATUS_ENTRY_KIND` entries (Step 0 data shapes) in `live-projection.ts`. A pending card is the entry; the last status entry for its `proposalId` sets `status`/`routineId`. |
| B projects cards for Remote | B | B maps the `memory_update` / `routine_proposal` `BotTranscriptEntry` (from A's projection) to wire entries in `aiden-remote-bot-session.ts`, gated on `bot:cards` |
| `openingGreeting` removal | A + B + C | C removes the UI, B removes the wire, A removes the store/service/types. **A's final type removal (A9) merges after B4 and C3.** |

## Track A: memory core (main)

Branch: `feature/bots-memory-soul-a`.

**A1. Files and store.** New `main/services/bot-memory/files.ts` and `store.ts`: paths (`botDirectoryName` from `bot-runtime/harness-host.ts` + `memory/`), parse/serialize, read validation (§6.3), content-addressed ids and revision, per-Bot mutex, `writeFileAtomic`, batch apply with the budget checked on the final state, `addOnly` mode, and `forgetBot(botId)` that refuses later writes. Test `store.test.ts` against real temp directories, covering every "Store" and "Read validation" case in spec §17.

**A2. Scan.** New `main/services/bot-memory/scan.ts`, original code (§6.4). Test `scan.test.ts`: a table of blocked strings and benign look-alikes, plus Luhn, invisible Unicode and NFKC full-width cases.

**A3. Service, IPC and singleton.** `main/services/bot-memory/service.ts` (`view`, person `edit`, tool `apply`, `snapshot`, `beginSession`, `markStale`, `onChanged`); replace the stub body in `bot-memory-main.ts`. New `main/handlers/bot-memory.ts` with strict parsers for `bots:memory:get` and `bots:memory:edit` and a `bots:memory:changed` push to all windows, registered from `main/handlers/bots.ts`. Test `main/handlers/bot-memory.test.ts` (register and invoke): malformed input rejected, stale `entryId` returns `entry_not_found`, `clear` empties both stores, a person edit marks the snapshot stale.

**A4. Tool.** `main/services/bot-memory/tool.ts`: the `bot_memory` AgentTool (TypeBox, contract per §7, `details: { changed, targets }`). Wire it in `bot-runtime/bot-session-main.ts`: append to `currentTools`, short-circuit `checkPolicy` to allow it, and wrap `turnAllows` (see Cross-track interfaces). Test `tool.test.ts`, driving the tool through `tool-adapter` against a faux harness: one batch frees space and adds, over budget returns the entries, a routine turn is never offered the tool.

**A5. Prompt and snapshot.** `main/services/bot-memory/prompt.ts` renders `aiden-memory` (§8). In `bot-extension.ts`, add `"aiden-memory"` last in `BOT_SECTION_KEYS` and make `systemSections` return 5 strings. `bot-session-service.ts` `openBot` calls `memory.beginSession(botId)`. `bot-system-prompt.ts` changes a doc comment only. Extend `bot-extension.test.ts` with a faux provider that records request system sections: section order, escaped injected entry, a tool write leaves the next request's memory section unchanged, a person edit and a reopen change it.

**A6. Compaction.** `main/services/bot-memory/compaction.ts`: the flush (review runner in add-only mode), the steered summary (borrow Pi Durable's summarization prompt with an MIT attribution comment) and `markStale`. Register `hook(CompactionTask, { beforeCompact })` in `bot-extension.ts`; `/new` passes the focus text as `instructions` (`bot-session-service.ts`). Test `compaction.test.ts`: a faux-provider conversation crosses a small `reserveTokens`; the flush entry is written, the summary contains the focus, and a summarizer throw falls back to Pi's summary.

**A7. Background review.** `main/services/bot-memory/review.ts`: `afterReply` with a 10 s debounce, the person-input count derived from the transcript, a one-off `Models.completeSimple` loop (3 rounds, 60 s), the `aiden.memory-review` marker, and abort on delete or shutdown. `bot-extension.ts` adds an `onYield` hook that calls `deps.afterReply(botId)`. `bot-session-main.ts` wires it and adds a delete effect (`memory.forgetBot` + `review.cancel`) before `eraseBotData`. Test `review.test.ts` (faux provider, real entries): 9 turns no, 10 yes; routine and intro inputs not counted; an in-turn save resets; add-only enforced; the failure marker backs off.

**A8. Projection.** `bot-runtime/live-projection.ts`: `memory_update` from a successful `bot_memory` result and from a review entry with `added > 0`; fold proposal entries into `routine_proposal`. Extend `live-projection.test.ts` (fixture entries in, transcript entries out).

**A9. Legacy removal and delete.**

- Memory: `memory-store.ts` drops `bot` from `MemoryScope` and purges `scope_kind='bot'` on open; remove the Bot branch from `memory-context.ts`, the Bot memory wiring from `llm-client.ts` (`:2402-2438`, `:2491-2494`), and `deleteScope` from `chat-renderer-mutations.ts:92`.
- Guard: `bot-file-tool-router.ts` refuses writes under `<profile>/bots/`.
- Greeting: remove it from `bot-store-core.ts` (legacy key ignored on read), `bot-application-service.ts`, `chat-store-core.ts` and `main/handlers/bot-params.ts`; remove `openingGreeting` and `openingGreetingChars` from `renderer/shared/bots.ts` last, after B4 and C3 merge. Check with `rg -n "kind: \"bot\"|openingGreeting" main renderer packages/cli/src`: no hits outside tests and the Remote ignore list.
- Tests: rows purged on open (memory-store suite); delete removes `memory/` even when the harness never opened (`bot-session-service.test.ts`); a full-Mac write into `memory/` is refused (`bot-file-tool-router` test); a legacy record with `openingGreeting` loads and is written without it (`bot-store` test).

**Commands:**

```sh
npx tsx --test main/services/bot-memory/*.test.ts main/handlers/bot-memory.test.ts
npm run test:bot-runtime
npm run test:bots
npm run test:compaction
npm run test:memory-policy
npm run type-check
npm run lint
```

**Definition of done:**

- All of A1–A9 are in and green.
- New test files are listed for the orchestrator: `bot-memory/{store,scan,tool,compaction,review}.test.ts` and `main/handlers/bot-memory.test.ts`.
- `.memory/bot-memory-soul.md` is written.
- No file outside A's list is touched.

## Track B: proactivity and Remote (main)

Branch: `feature/bots-memory-soul-b`.

**B1. Routine notes.** New `main/services/bot-routine-notes.ts` (`<profile>/bots/<dir>/routine-notes.json`, caps per §11.4, `render(taskId)` returns `""` when empty). The `routine_notes` tool is offered only on `routine:` runs: a candidate in `bot-runtime/bot-tool-sources-main.ts`, the run's task id bound per call via `bot-tool-candidates.ts`, gated in `bot-tool-policy.ts`. `scheduled-bot-routines.ts` prepends the notes in `botRoutineMessage`; routine delete clears them. Test `bot-routine-notes.test.ts`: offered only on routine runs, caps reject without change, notes render into that routine's input only, delete clears them.

**B2. Proposals.** New `main/services/bot-routine-proposals.ts` (store + respond, per-Bot lock) and `bot-routine-proposals-main.ts`. In `schedule-tool.ts`, replace `createBotRoutineTool` with `routines` (`list`/`propose`/`pause`), registered in `bot-tool-sources-main.ts`. Add `ScheduledTask.sourceProposalId?` in `main/services/types.ts`; `scheduled-bot-routines.ts` `create` is idempotent by it. Add `bots:routineProposals:respond` (strict parser) to `main/handlers/bot-routines.ts`. Test `bot-routine-proposals.test.ts`: argument validation and pending cap; two concurrent accepts give one routine; dismiss writes a status entry; the `routines` tool has no create path.

**B3. Catch-up.** `scheduled-bot-routines-main.ts` subscribes to `onBotSessionStateChange`; `scheduled-bot-routines.ts` gets `catchUp(botId)` per §11.2; `schedule-service-core.ts` gets trigger kind `catch_up`. Test in `scheduled-bot-routines.test.ts`: newest `bot_paused` skip within 7 days runs once; a repeated state change dedupes; an older skip is ignored; a later success suppresses it.

**B4. Remote and greeting wire.** `aiden-remote-protocol.ts`: revision 27 (re-claimed at merge), tokens `bot-memory-v1` and `bot-proactive-v1`, negotiable `bot:cards`, parsers for every new body, `openingGreeting` removed from emit types and added to the accept-and-ignore list. `aiden-remote-router.ts`: the five routes, features announced only while wired. `aiden-remote-bot-session.ts`: wire entries gated on `bot:cards`. `aiden-remote-bots.ts`: no greeting emit, ignored on input. `aiden-remote-service-main.ts`: inject `botMemoryService` and the proposal and notification services. Update `openapi.json` and `contract.json` (bump `contractRevision`). Tests: router register-and-invoke (scopes, Idempotency-Key replay, error codes, feature announcement); session gating with and without `bot:cards`; fixture equality for the six new keys; greeting accept-and-ignore.

**B5. Phone notification feed.** New `main/services/bot-routine-notifications.ts`, a projector over the run store and Bot routines (§11.1) that reuses the routine `lastError` redaction, served at `GET /bots/routine-notifications`. Test `bot-routine-notifications.test.ts`: include/exclude matrix, `since` filter, cap at 100, redaction of a path and a key-shaped string.

**B6. Telegram delivery.** `telegram/bot-reply-outbox.ts` gets `enqueueRoutineDelivery({ botId, requestId, routineName, text })` and a `routine` row kind; `telegram-service.ts` delivers through the binding, re-checking `enabled`; `scheduled-bot-routines.ts` enqueues after a visible reply or an error. Test in `bot-reply-outbox.test.ts`: delivered once; a crash between `sending` and `sent` redelivers with the duplicate label; a disabled binding is never sent; silent sends nothing.

**B7. Suggestions route.** `GET /bots/{id}/routine-suggestions` serves `BOT_DAILY_CHECKIN_SUGGESTION` with a host label and returns an empty list once any routine exists. Covered by the B4 router tests.

**Commands:**

```sh
npx tsx --test main/services/bot-routine-*.test.ts main/services/scheduled-bot-routines.test.ts
npm run test:aiden-remote
npm run test:bots
npm run test:bot-runtime
npm run test:scheduled
npm run test:assistant-automations
npm run type-check
npm run lint
```

**Definition of done:**

- B1–B7 are green.
- New test files are listed for the orchestrator.
- `.memory/bot-proactivity.md` is written.
- `.memory/bots-rework-ui.md` "Feature tokens and revision" is updated.
- No file outside B's list is touched.

## Track C: clients (desktop renderer, iOS, Android)

Branch: `feature/bots-memory-soul-c`. C builds against the Step 0 types and fixtures. While A and B are in flight, desktop tests use `installBotTestIpc` fakes and native tests use the fixtures.

**C1. Desktop IPC bindings.**

- `renderer/lib/ipc.ts`:
  - `botsApi.memory.get` and `.edit`;
  - `onMemoryChanged`;
  - `botsApi.routineProposals.respond`.
- Test fakes: `renderer/test-utils/*` bots IPC (`installBotTestIpc`).

**C2. Desktop Memory page.**

- New `renderer/main/bots/bot-memory-page.tsx`, per spec §15:
  - `BotPageShell`, `FieldSet`/`Field`;
  - `MemoryCardIcon`;
  - neutral usage meter;
  - ••• Edit and Delete, with an Undo toast;
  - Erase AlertDialog;
  - unreadable callout;
  - live refresh.
- `bot-page-search.ts`: `page=memory`.
- `bots-view.tsx`: route the sub-page.
- `bot-profile.tsx`: the Memory row with a count.
- Review the two ChatGPT reference docs first.
- Test: `bot-memory-page.test.tsx`:
  - list;
  - edit with an error callout;
  - delete and Undo;
  - erase;
  - unreadable;
  - a pushed change event refreshes.

**C3. Desktop chat, Advanced, Routines and Instructions.**

- `bot-transcript-rows.ts` + `bot-chat-pane.tsx`: a `memory_update` caption row that opens Memory.
- New `renderer/components/bots/routine-proposal-card.tsx`, on `bot-notice-card`, with Add routine / Not now and settled states.
- `bot-advanced.tsx` + `bot-identity.ts`: remove the greeting.
- `bot-routines.tsx`: a daily check-in row that opens `bot-routine-editor.tsx` prefilled from `BOT_DAILY_CHECKIN_SUGGESTION` when the list is empty.
- `bot-instructions-editor.tsx`: copy.
- `renderer/components/onboarding-flow.tsx`: the Bots tile description (§15).
- Tests: extend `bot-chat-pane.test.tsx` (caption opens Memory; Add and Not now call respond; settled copy), `bot-routines.test.tsx` (suggestion prefill, nothing created until Save) and the Advanced/Profile tests (no greeting field).

**C4. iOS.**

- Models:
  - new `Models/AidenBotMemory.swift`;
  - `AidenBotSession.swift`: the two entry types, and skip unknown types;
  - `AidenBotRoutine.swift`: proposal respond, suggestions, notifications;
  - `AidenBot.swift`: drop the greeting.
- Client and capability: `AidenRemoteClient.swift` methods; add `bot:cards` to the device-capabilities `accepts`.
- UI:
  - new `Features/Bots/AidenBotMemoryView.swift` (`sdcard` symbol, swipe Edit/Delete, Erase confirmation);
  - `AidenBotProfileView.swift`: the Memory row;
  - `AidenBotSessionChatView.swift` + `AidenBotSessionModel.swift`: the caption and proposal card;
  - `AidenBotAdvancedView.swift` + `AidenBotSettingsDraft.swift`: remove the greeting;
  - `AidenBotRoutinesView.swift`: the suggestion row.
- Notifications: `Features/Remote/AidenScheduledRunNotifier.swift` gets a Bot feed variant (`aiden.bot-routine.<runId>`, cursor per instance, opens the Bot chat), called on foreground from `AidenOnTheGoApp.swift` and on Bots home refresh.
- Register new files in `AidenOnTheGo.xcodeproj/project.pbxproj`.
- Tests: `AidenBotContractTests` (new fixtures, revision 27, unknown-type skip), `AidenBotSessionTests` (proposal respond and settle), new `AidenBotMemoryTests` (edit, delete, erase, stale id), and `AidenBotHomeProfileTests` (no greeting).

**C5. Android.**

- Models:
  - new `models/AidenBotMemory.kt`;
  - `AidenBotSession.kt`: the entries, and skip unknown types instead of `InvalidField("type")`;
  - `AidenBotRoutine.kt`;
  - `AidenBot.kt`: drop the greeting.
- Client and capability: `networking/AidenRemoteClient.kt`; `bot:cards` in `accepts`.
- UI:
  - new `features/bots/AidenBotMemoryScreen.kt` (`Icons.Outlined.SdStorage`, copy in `strings.xml` `bot_memory_*`);
  - `AidenBotProfileScreen.kt`;
  - `AidenBotSessionScreen.kt` + `AidenBotSessionController.kt`;
  - `AidenBotAdvancedScreen.kt`: remove the greeting draft, patch and field;
  - `AidenBotRoutines.kt`: the suggestion.
- Notifications: `notifications/AidenScheduledRunNotifier.kt` gets a Bot variant, called from app foreground and `AidenBotsHomeScreen.kt`.
- Tests: `AidenBotContractTest`, `AidenBotRevision25ContractTest` (extend for revision 27), `AidenBotSessionControllerTest`, `AidenBotProfileBehaviorTest`, and new `AidenBotMemoryTest`.

**Commands:**

```sh
npx tsx --test renderer/main/bots/*.test.tsx
npm run type-check
npm run lint
cd android && ./gradlew :app:testDebugUnitTest --tests '*AidenBot*'
xcodebuild test -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo \
  -destination 'platform=iOS Simulator,name=<explicit simulator>' -only-testing:AidenOnTheGoTests
```

For iOS, record the destination. If the parallel host launch flakes, run serially and note it.

**Definition of done:**

- C1–C5 are green on desktop, Android JVM and the iOS simulator.
- No brain icons anywhere.
- Text inputs have no focus ring; non-text controls keep a `focus-visible` ring.
- New test files are listed.
- `.memory/bot-memory-clients.md` is written.

## Integration order

1. Step 0, by the orchestrator.
2. A, B and C in parallel.
3. Merge A, then B, then C, re-running `npm run test`, `test:aiden-remote` and the native suites after each.
4. After all three are in: A9's final shared-type greeting removal, B4's final wiring of `botMemoryService`, and the revision re-claim against `main`.
5. Update `docs/plans/README.md` status and the spec status.

## File ownership

- **Step 0 (orchestrator, then handed off):** `renderer/shared/bot-memory.ts`, `renderer/shared/bot-live.ts` and `main/services/bot-memory/bot-memory-main.ts` go to A; `renderer/shared/bot-routine-proposals.ts` and `protocol/aiden-remote/v1/fixtures/contract.json` go to B; the no-op switch branches go to C (`bot-transcript-rows.ts`) and B (`aiden-remote-bot-session.ts`). `package.json` and `docs/plans/README.md` stay with the orchestrator.
- **Track A:** `main/services/bot-memory/**`; `main/handlers/{bot-memory,bots,bot-params,chat-renderer-mutations}.ts` (+ tests); `main/services/bot-runtime/{bot-extension,bot-session-service,bot-session-main,live-projection}.ts` and their tests; `main/services/{bot-system-prompt,memory-store,memory-store-main,memory-context,llm-client,bot-file-tool-router,bot-store-core,bot-application-service,chat-store-core}.ts`; `renderer/shared/{bot-memory,bot-live,bots}.ts`; `.memory/bot-memory-soul.md`.
- **Track B:** `main/services/{bot-routine-notes,bot-routine-proposals,bot-routine-proposals-main,bot-routine-notifications}.ts` (+ tests); `main/services/{scheduled-bot-routines,scheduled-bot-routines-main,schedule-tool,schedule-service-core,types}.ts`; `main/handlers/bot-routines.ts`; `main/services/bot-runtime/{bot-tool-sources-main,bot-tool-policy,bot-tool-candidates}.ts`; `main/services/telegram/{bot-reply-outbox,telegram-service}.ts`; `main/services/{aiden-remote-protocol,aiden-remote-router,aiden-remote-bot-session,aiden-remote-bots,aiden-remote-service-main}.ts` (+ tests); `protocol/aiden-remote/v1/{openapi.json,fixtures/contract.json}`; `renderer/shared/bot-routine-proposals.ts`; `.memory/bot-proactivity.md`; `.memory/bots-rework-ui.md`.
- **Track C:** `renderer/lib/ipc.ts`; `renderer/test-utils/**` (bots fakes); `renderer/main/bots-view.tsx`; `renderer/main/bots/**`; `renderer/components/bots/routine-proposal-card.tsx`; `renderer/components/onboarding-flow.tsx`; `ios/AidenOnTheGo/**` and `ios/AidenOnTheGoTests/**` (Bots, Remote notifier, app entry, pbxproj); `android/app/src/**` (Bots, models, networking, notifications, `strings.xml`, tests); `.memory/bot-memory-clients.md`.

## Risks

- **Pi Durable is experimental.**
  - `beforeCompact`/`onYield` semantics could change in a patch release. They are pinned at 1.0.3, and the compaction and review tests run against the real harness.
  - Borrowing the summarization prompt can drift from upstream; this is noted in the A6 comment.
- **Feature-token budget.** 2 new tokens bring the count to about 29 of 32. B4's test must assert the limit.
- **Old phones.** Revision-26 parsers throw on unknown entries. The host gates the new entries on `bot:cards`, and the greeting is accepted and ignored.
- **No push.** Phone routine alerts arrive only when the app foregrounds.
- **Review and summarizer cost.** One extra small request every 10 person turns and per compaction. Both are bounded and skipped without a model.
- **Shell writes to memory.** Bounded by read validation, not prevented (Full access).
