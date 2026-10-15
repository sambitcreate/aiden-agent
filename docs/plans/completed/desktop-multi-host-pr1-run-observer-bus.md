# Desktop multi-host PR 1: host run observer bus — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every generation on a host, whoever started it, is recorded in a bounded, host-wide run journal that later PRs can serve to paired desktops. The remote stream store also stops rewriting its whole snapshot on every streamed token.

**Architecture:**
- A pure content-projection function is extracted from `AidenRemoteStreamService.projectNotification`, so the mobile stream journal and the new `HostRunRegistry` turn generation notifications into identical wire events.
- `HostRunRegistry` is an in-memory, epoch-stamped journal per run with wake-then-read subscribers. `llm-client.ts` feeds it from the same seams that already feed `chatActivityRegistry`: begin, `sendGeneration`, attention resolution, and settle. The single generation owner is unchanged.
- The remote stream store coalesces persistence of non-boundary events.

**Tech stack:** TypeScript, Node `node:test` through `tsx --test`, and Electron main-process services.

**Spec:** `docs/plans/desktop-multi-host-control-plan.md` (Architecture §3 "Host backend", delivery row 1).

## Global constraints

- The behaviour of the local renderer and the mobile wire format must not change. The existing `main/services/aiden-remote-streams.test.ts` must pass without edits to its assertions.
- No new IPC channels, HTTP routes or contract revision in this PR.
- Tests must be behavioural. Call the real functions with fixtures, and never grep production source. Follow the test rules in `AGENTS.md`.
- Register every new test file in **both** the root `package.json` `test:aiden-remote` script and `scripts/ci-test-registry.json`. The registry goes in the same lane as `main/services/aiden-remote-streams.test.ts`. `npm run test:ci-policy` must pass.
- Keep comment density and idiom matching `aiden-remote-streams.ts`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never put model identifiers in code or docs.
- Verification commands:
  - `npx tsx --test <file>`
  - `npm run type-check`
  - `npx eslint <files>`
  - `npm run test:ci-policy`

## Review focus

1. **A run that ends without `chat:done`/`chat:error`.** If startup fails, the renderer is destroyed, or the run aborts early, the registry must still reach a terminal state on settle and must never report "working" forever.
2. **A slow or absent observer.** Journal memory stays bounded per run and in total. A cursor that is behind retention gets `snapshot_required`, not a silent skip.
3. **Two approvals or questions pending on one run.** The state stays `needs_approval`/`needs_input` until the last one resolves, and resolving one does not clear the other.
4. **Debounced persistence on crash or quit.** `settlePersistence()` flushes a pending coalesced write. Terminal, approval and cancel events are written without waiting for the debounce.
5. **Host restart.** The epoch changes, so a client holding an older epoch cursor must be told to snapshot.

---

### Task 1: Extract the content projection

**Files:**
- Create: `main/services/run-event-projection.ts`
- Create: `main/services/run-event-projection.test.ts`
- Modify: `main/services/aiden-remote-streams.ts` (`projectNotification`, about lines 1015–1225; `StreamRecord.activeTools/toolCounter`)
- Register the test (see Global constraints).

**Interfaces (produces):**

```ts
import type { NotificationChannel } from "../../renderer/preload-channels.js";
import type { AidenRemoteStreamState } from "./aiden-remote-streams.js"; // type-only

export interface RunProjectionState {
  toolCounter: number;
  activeTools: Map<string, string[]>;
}
export function createRunProjectionState(): RunProjectionState;

export interface RunProjectionContext {
  chatId: string;
  turnId: string;
  /** Sequence of the newest retained event (0 when empty). */
  lastSequence: number;
  /** True once a stop was requested for this run by the projecting journal. */
  cancelRequested: boolean;
  cancellationSource: "device" | "server";
}

export type RunContentProjection =
  | {
      kind: "event";
      type: string;
      payload: Record<string, unknown>;
      terminal: boolean;
      state: AidenRemoteStreamState;
    }
  /** Channel handled, nothing to append (e.g. empty delta). */
  | { kind: "ignored" }
  /** Caller owns this channel (chat:approval, chat:questionnaire, anything unknown). */
  | { kind: "unhandled" };

export function projectRunContentNotification(
  state: RunProjectionState,
  channel: NotificationChannel,
  payload: Record<string, unknown>,
  context: RunProjectionContext,
): RunContentProjection;
```

The function covers exactly the channels `projectNotification` handles today, apart from approval and questionnaire:
- `chat:delta`, with reset producing a snapshot whose `nextSequence` is `lastSequence + 2`, state `reconciling`
- `chat:reasoning-delta`, `chat:status` and `chat:tool`
- `chat:timeline`, `chat:error` and `chat:done`

It mutates only `state`, and the output must be byte-identical to today's.

- [ ] **Step 1: Write failing tests in `run-event-projection.test.ts`.** Cover:
  - a delta producing `text_delta`
  - an empty delta producing `ignored`
  - a reset producing `snapshot` with `nextSequence = lastSequence + 2` and state `reconciling`
  - tool call/result pairing by name, with ids `tool_1`, `tool_2` in order and a result for an unknown name minting a new id
  - an error phase producing `failed`
  - `chat:done` with `cancelled: true`, or with timeline status `cancelled`, producing a terminal `cancelled` whose source comes from context when `cancelRequested`, otherwise `"server"`
  - `chat:done` picking the last assistant message id, with fallback `assistant_<turnId>`
  - `chat:error` producing a terminal `error` with code `internal_error`
  - `chat:approval` producing `unhandled`
- [ ] **Step 2: Run** `npx tsx --test main/services/run-event-projection.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Move the logic out of `projectNotification`, keeping the helper functions it needs (`boundedText`, `ownRecord`). Export them from the new module, or duplicate tiny ones, without changing behaviour. In `AidenRemoteStreamService`, replace the stream's `activeTools`/`toolCounter` fields with a `projection: RunProjectionState`. `projectNotification` first handles approval and questionnaire as today. For every other channel it calls `projectRunContentNotification` and `append`s on `kind: "event"`.
- [ ] **Step 4: Run** the new test and `npx tsx --test main/services/aiden-remote-streams.test.ts main/services/aiden-remote-chats.test.ts main/handlers/aiden-remote.test.ts`. Expected: PASS with no assertion edits.
- [ ] **Step 5:** `npm run type-check`, then eslint on the touched files, then commit with `refactor(remote): share the run content projection`.

### Task 2: Coalesce remote stream persistence (blocker d)

**Files:**
- Modify: `main/services/aiden-remote-streams.ts` (`persist`, `settlePersistence`, `append`, `revokeDevice`, constructor options)
- Test: extend `main/services/aiden-remote-streams.test.ts` with a new `describe`/`test` group. Keep the existing tests unchanged.

**Behaviour:**
- Add an optional `persistCoalesceMs?: number` constructor option, defaulting to `250`.
- `append` persists **immediately** when the event is terminal, or its type is one of `approval_required`, `question_required`, `cancelled` or `snapshot`, or the stream state changes. That last condition covers queued→running, running→waiting_for_approval and →reconciling.
- Every other append (`text_delta`, `reasoning_delta`, `timeline`, `tool_started`, `tool_finished`, and repeated `status` with an unchanged state) schedules one write at most `persistCoalesceMs` later, using one unref'd timer per service.
- A boundary write cancels any pending timer, because the snapshot already includes those events.
- `settlePersistence()` must flush a pending timer first.
- Deletion paths (`revokeDevice`, eviction in `onFinish`) keep persisting immediately.
- Keep the existing single-flight `persistRunning/persistDirty` loop.

- [ ] **Step 1: Write failing tests.**
  - With a counting `persist` and `persistCoalesceMs: 1_000`, create a stream, mark it running, and publish 500 `chat:delta` notifications through the owner (`owner.send("chat:delta", {delta: "x"})`). Assert the count is ≤ 3 after `await settlePersistence()`.
  - The last persisted snapshot contains all 500 deltas, given retention limits.
  - Then `owner.send("chat:done", …)`. Assert a persist happens without advancing timers (use `mock.timers` or a huge `persistCoalesceMs`), and that the persisted snapshot's last event is terminal.
  - An approval notification persists immediately.
  - `settlePersistence()` with a pending timer writes once and resolves.
- [ ] **Step 2:** Run them and confirm they FAIL on the current per-event persist (the count will be about 502).
- [ ] **Step 3: Implement.** Document the bounded loss window (≤ `persistCoalesceMs` of non-boundary events, recovered on restart as `server_interrupted`) in a short comment beside the option.
- [ ] **Step 4:** Run the full streams test file plus `aiden-remote-chats.test.ts`, `main/handlers/aiden-remote.test.ts` and `aiden-remote-revocation.test.ts`. Expected: PASS.
- [ ] **Step 5:** Type-check and lint, then commit with `perf(remote): coalesce stream journal persistence`.

### Task 3: `HostRunRegistry` core

**Files:**
- Create: `main/services/host-run-registry.ts` (pure, no Electron imports)
- Create: `main/services/host-run-registry.test.ts`
- Register the test.

**Interfaces:**
- **Consumes:** `projectRunContentNotification`, `createRunProjectionState`, `RunProjectionState` from Task 1.
- **Produces:**

```ts
export type HostRunOrigin = "renderer" | "remote" | "headless";
export type HostRunState =
  | "working" | "needs_approval" | "needs_input" | "done" | "failed" | "cancelled";

export interface HostRunEvent {
  runId: string;
  sequence: number;      // 1-based, contiguous per run
  timestamp: string;     // ISO
  type: string;          // same vocabulary as AidenRemoteStreamEvent.type, plus the types below
  terminal: boolean;
  payload: Record<string, unknown>;
}

export interface HostRunSummary {
  runId: string;
  chatId: string;
  origin: HostRunOrigin;
  state: HostRunState;
  startedAt: string;
  updatedAt: string;
  lastSequence: number;
  /** Pending prompt ids in arrival order. */
  pendingApprovalIds: string[];
  pendingQuestionIds: string[];
}

export type HostRunRead =
  | { kind: "events"; epoch: string; events: HostRunEvent[]; summary: HostRunSummary }
  | { kind: "snapshot_required"; epoch: string; summary: HostRunSummary };

export interface HostRunRegistryOptions {
  now(): number;
  epoch?: string;                    // default: crypto.randomUUID()
  maxEventsPerRun?: number;          // default 4_096
  maxEventBytesPerRun?: number;      // default 4 MiB
  maxTotalEventBytes?: number;       // default 32 MiB
  maxRuns?: number;                  // default 128
  terminalRetentionMs?: number;      // default 10 minutes
}

export class HostRunRegistry {
  constructor(options: HostRunRegistryOptions);
  readonly epoch: string;
  /** Idempotent per runId. Emits run_started (sequence 1). */
  begin(input: { runId: string; chatId: string; origin: HostRunOrigin }): void;
  /** Unknown or terminal run: no-op. Never throws on malformed payloads. */
  publish(runId: string, channel: NotificationChannel, payload: unknown): void;
  /** Called with an approvalId or questionnaire promptId; unknown id: no-op. */
  resolveAttention(promptId: string): void;
  /** Idempotent. If the run has no terminal event yet, appends terminal
   *  `error` {code: "run_ended_without_outcome"} with state "failed". */
  settle(runId: string): void;
  summary(runId: string): HostRunSummary | undefined;
  /** Newest run (by startedAt, then runId) for the chat among retained runs. */
  currentRunForChat(chatId: string): HostRunSummary | undefined;
  list(): HostRunSummary[];
  /** Throws RangeError when afterSequence > lastSequence or the run is unknown. */
  read(runId: string, afterSequence: number): HostRunRead;
  /** wake() is called synchronously after each append to that run, and once
   *  more when the run is pruned. Returns unsubscribe. Readers call read(). */
  subscribe(runId: string, wake: () => void): () => void;
  /** Called only when a run's HostRunState or pending prompt ids change, on
   *  begin, and on prune (with `removed: true`). Not called per delta. */
  onChange(listener: (summary: HostRunSummary, removed: boolean) => void): () => void;
}
```

**Behaviour:**
- **Content channels** use the shared projection, with context `{chatId, turnId: runId, lastSequence, cancelRequested: false, cancellationSource: "server"}`. Projected stream states map to run states:
  - `queued`, `running`, `reconciling` → `working`
  - `done` → `done`
  - `error`, `interrupted` → `failed`
  - `cancelled` → `cancelled`
  - `waiting_for_approval`: not produced by content channels
- **`chat:approval`** with a string `approvalId` (≤128 chars) appends `approval_required` with payload `{approvalId, summary, toolCallId, toolName, scopes?, details?}`. Bound the strings the way `aiden-remote-streams.ts` does: summary 2,000, toolName 120, toolCallId 128. `details` and `scopes` are copied with `structuredClone` only when they are plain objects/arrays. The id is added to `pendingApprovalIds`.
- **`chat:questionnaire`** with `promptId` appends `question_required` with `{promptId, questions, toolCallId, expiresAt?}`. Use `parseAskUserQuestions` from `../../renderer/shared/ask-user-question.js`, and ignore the event if parsing fails. The id is added to `pendingQuestionIds`.
- **`resolveAttention(id)`** removes the id, appends `approval_resolved {approvalId}` or `question_resolved {promptId}`, and recomputes the state.
- **Non-terminal state:** `needs_approval` if any approvals are pending, else `needs_input` if any questions are pending, else `working`.
- **Terminal events** clear all pending ids.
- **Retention:**
  - per run, trim the oldest events past `maxEventsPerRun`/`maxEventBytesPerRun`, never the newest
  - in total, while over `maxTotalEventBytes`, evict terminal runs oldest-first (calling `wake` and `onChange(removed)`), then trim the oldest events of the largest live run
  - terminal runs past `terminalRetentionMs` are pruned lazily on `begin`/`publish`/`read`/`list`
  - past `maxRuns`, evict the oldest terminal run; if every run is live, evict the oldest-updated live run
- **`read`:** if `afterSequence < firstRetainedSequence - 1`, return `snapshot_required`. Otherwise return events with `sequence > afterSequence`, as structured clones.

- [ ] **Step 1: Write failing tests** (use an injected `now` and small limits):
  1. begin → `run_started` seq 1, state `working`, `onChange` fires once; a second `begin` with the same id is a no-op
  2. 3 deltas → `read(runId, 1)` returns seq 2–4 `text_delta`; `onChange` is not called for deltas
  3. two approvals → `needs_approval` with both ids; resolving the first keeps `needs_approval`; resolving the second → `working`
  4. question + approval → `needs_approval`; resolve the approval → `needs_input`
  5. `chat:done` → `done`, terminal, pending cleared; later publishes are ignored
  6. `chat:done` with `{cancelled: true}` → `cancelled`
  7. settle without terminal → `failed` with `run_ended_without_outcome`; settle again is a no-op
  8. `maxEventsPerRun: 5` with 10 deltas: `read(runId, 0)` → `snapshot_required`, while `read(runId, last-2)` → events
  9. `read` with a cursor ahead throws `RangeError`
  10. terminal retention: advance `now` beyond retention, then `list()` excludes the run and the subscriber is woken with `onChange(removed=true)`
  11. `maxTotalEventBytes` eviction prefers terminal runs
  12. `currentRunForChat` returns the newest run
  13. malformed payloads (`null`, arrays, oversized strings) don't throw
  14. returned events are clones, so mutating them does not change a later `read`
  15. two registries have distinct epochs; the `epoch` option is honoured
- [ ] **Step 2:** Run the tests and confirm they FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests and confirm they PASS. Then type-check and lint.
- [ ] **Step 5:** Commit with `feat(remote): add host-wide run journal`.

### Task 4: Feed the registry from the generation lifecycle

**Files:**
- Create: `main/services/host-runs.ts` (singleton: `export const hostRunRegistry = new HostRunRegistry({ now: Date.now })`)
- Modify `main/services/llm-client.ts`:
  - begin (next to `chatActivityRegistry.begin(streamId, params.chatId)`, about line 1667)
  - `sendGeneration` (about line 611): publish **before** the owner/destroyed check, so runs whose renderer went away keep journaling
  - the attention resolvers (about lines 661 and 670)
  - `broadcastChatSettled` (about line 567)
- Test: a behavioural test through a public `llm-client` seam if one exists. Search for tests importing `llm-client.js`, e.g. `grep -rl "llm-client.js" main --include=*.test.ts`. Otherwise add `main/services/host-runs.test.ts`, which exercises a small exported adapter `hostRunOriginFor(owner: Pick<ChatGenerationOwner, "kind" | "id">): HostRunOrigin` (`kind === "remote"` → `remote`; `id > 0` → `renderer`; else `headless`) plus an end-to-end sequence that calls the same functions `llm-client` calls.

**Interfaces:**
- **Consumes:** `HostRunRegistry` from Task 3.
- **Produces:** `hostRunRegistry` singleton and `hostRunOriginFor`.

- [ ] **Step 1:** Write the failing test for `hostRunOriginFor`, plus a lifecycle test (begin → publish delta → approval → resolve → `chat:done` → settle) against a fresh `HostRunRegistry`, through the helper functions `host-runs.ts` exports for `llm-client`. Example: `recordRunBegin(registry, streamId, chatId, owner)`, `recordRunNotification(registry, streamId, channel, payload)`, `recordRunAttentionResolved(registry, promptId)`, `recordRunSettled(registry, streamId)`. Each wraps the registry call in try/catch and logs through `logger.warn("remote", …)`, so a journal fault can never break a generation.
- [ ] **Step 2:** Run the test and confirm it FAILS.
- [ ] **Step 3:** Implement `host-runs.ts` and wire the four call sites in `llm-client.ts` (one line each).
- [ ] **Step 4:** Run the new test, `npm run type-check`, and a quick generation regression: `npx tsx --test main/services/chat-generation-owner.test.ts main/services/chat-generation-start.test.ts main/services/aiden-remote-streams.test.ts`.
- [ ] **Step 5:** Commit with `feat(remote): journal every host generation run`.

### Task 5: Docs and memory (controller)

- Update `docs/plans/desktop-multi-host-control-plan.md` §3 to state that the host run journal is in-memory and epoch-stamped. The durable mobile stream journal stays as it is, and the stream-store "view over the registry" is deferred to PR 2.
- Update the `docs/plans/README.md` row.
- Update `.memory/desktop-multi-host-v1-plan.md`.
