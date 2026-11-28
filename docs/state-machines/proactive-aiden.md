# Proactive Aiden state machines

State-machine reference for the owners introduced or extended by Proactive Aiden (PR `#879`).

## Chat orchestration (`main/services/chat-orchestration/`)

### `ChatLinkStore` (`links.ts`, `links-main.ts`)

Persists one `ChatLink` per started child chat in `chat-orchestration.json` (mode `0600`, max 8 MiB, max 5,000 links, newest 64 retain `resultSchema` and `result`, last 16 `delivered` run IDs).

- **Restore & persist:** `restore()` loads once (shared promise); damaged links are dropped and a damaged document reads empty. Writes serialize through `writes` with single-slot coalescing (`queued`); a failed save is logged while memory stays current.
- **Authority & trust invariants:**
  - Depth 1 only (`childChatId !== leadChatId`, first link wins, started chats never receive `child_chats`).
  - `startedChatTurnCeiling` narrows the link's stored `ceiling` (or `LOST_LINK_CEILING` — `Ask`, no Mac grants — when only `startedBy` survives after a link loss or `deleteChat`) against the lead's current workspace policy on every turn.
  - `personTookOver(link)` holds once `tookOverAt > (leadSentAt ?? 0)` (`markPersonTookOver` in `links-main.ts`).
  - `startedChatRunTrust(link)`: if `leadTainted === true`, child runs start `tainted: true`, and `judgeTrusted` is `false` until `personTookOver(link)` is true.
  - `childTainted` is sticky (`markChildTainted` writes once) and marks lead notices with `outside: true`.
  - `deleteChat(chatId)` removes both the chat's own link and links of chats it started.

### `ChatRunCore` (`run-core.ts`)

Shared run follower and request deduper for any caller driving Remote chat/stream services:

- **Snapshot states (`ChatRunSnapshot`):** `running`, `waiting_for_input`, `waiting_for_approval`, `done` (`completed` | `stopped`), `failed` (`interrupted` | `error`). Terminal stream states (`CHAT_RUN_TERMINAL_STATES`): `done`, `error`, `cancelled`, `interrupted`.
- **Bounded wait (`wait`):** Returns immediately if already non-`running` or aborted; otherwise watches stream changes and re-probes once after attaching (`look()`) to close the attach race. Resolves `{ kind: "snapshot" | "closed" | "aborted" }`. Timeout returns the current snapshot without stopping the run.
- **Request dedupe (`request`):** Keyed by `owner + "\0" + requestId`. In-flight requests are joined and never evicted; settled successes are cached up to `REQUEST_CACHE_LIMIT` (128); failures delete their entry so callers may retry.
- **Revocation (`forget(owner)`):** Aborts every active wait (`closed`), drops tracked runs, and clears cached requests for `owner`.

### `ChildChats` (`child-chats.ts`)

Drives started chats through `chats` and `streams` under audience `chat:<leadChatId>`:

- **`start`:** Validates every `resultSchema` up front (`compileResultSchema`). Derives deterministic keys (`childChatKey(leadChatId, callKey, index)`). If `create` fails after creating the chat or worktree and before `links.add` persists, it removes the chat and discards the new worktree. Replays find the existing link by key and reuse `link.runId`.
- **`send`:** Refuses if `personTookOver(link)`. Propagates `leadTainted` before sending. If `link.runId` is live, submits mid-flight input (`queue` when requested or when `link.resultSchema` is set, else `steer`); falls back to `startTurn` only on `run_not_active`.
- **`wait` / `stop` / `stopAll`:** `wait` blocks until `any` or `all` runs reach `done`/`failed` (approval/question waits do not end a turn), `timeoutMs` expires (without stopping any run), or the caller's `signal` aborts; per chat, `untilEnded` also settles without a terminal snapshot when the stream closes or becomes untracked (and chats without a `runId` skip waiting). It then reads each chat's current `view`—which may still be `running`, `waiting_for_input`, `waiting_for_approval`, or `idle`—and calls `markTold` only for returned views with a `runId` and `state` of `done` or `failed` so completion notices do not repeat them. `stop` refuses if `personTookOver(link)`, cancels via `streams.cancel`, and marks the run told only after the stop succeeds. `stopAll` skips chats taken over by the person.
- **`follow`:** In-memory stream watcher (deduped in `followed`) that notifies `onChanged` on approval/question transitions and fires `onRunEnded` once a stream hits a terminal state (`childRunEnd`: `done`, `stopped`, `failed`, `interrupted`).

### `ChildChatCompletions` (`completion-delivery.ts`)

Coalesces child run endings into `chat` notices for the lead:

- **`runEnded`:** Ignores already-`delivered` runs; persists `link.owed = { runId, end, at }` and arms a `CHILD_COMPLETION_GROUP_MS` (10 s) per-lead timer.
- **Quiet lead:** `quietLead(leadChatId)` (person pressed Stop in the lead) forces `wake: false` on flushed notices until `resumeLead(leadChatId)` (person sends again).
- **Settlement (`settle`):** Clears `link.owed` and appends to `link.delivered` on any non-`dropped` outcome; clears `link.owed` without marking delivered only when `outcome.gone === true`. Transient drops leave `link.owed` intact.
- **Startup recovery (`recoverOwed`):** Posts remaining `link.owed` entries per lead with `wake: false` (or merges them into an already-pending group), re-checking `stillOwed` before each post in case `wait` already consumed them.

## Keep-going goals (`main/services/goal/`)

### Pure state machine (`goal-core.ts`)

Statuses: `active`, `paused`, `needs-you`, `done`. Every mutation increments `revision`; system writes use `compareAndSetGoal(current, { id, revision }, update)` so a person's Pause, Clear, or replacement always wins over an in-flight review or check.

- **Limits:** `GOAL_MAX_ROUNDS` (50) for reviewed goals, `GOAL_CHECK_MAX_ROUNDS` (5) for command (`check`) goals, `GOAL_MAX_STALLS` (3 consecutive repeated `continue` reasons or quiet rounds with 0 tool calls and `< GOAL_SUBSTANTIAL_TEXT_CHARS`), `GOAL_MAX_UNUSABLE_REVIEWS` (2), `GOAL_WAIT_LIMIT_MS` (30 minutes for `wait`/helper/prompt expiry).
- **Transitions:**
  - `restoreGoal`: any `active` goal from another `boot` ID comes back `paused` (`cause: "restart"`).
  - `goalAfterSettle`: checks `active`, matching `boot`, `!stopped`, `!lastRunFailed`, `rounds <= maxRounds`, and `helperRunning` (sets `waitingSince` and returns `skip`, or pauses `wait-limit` after 30 min), then routes to `check` or `review`.
  - `applyGoalVerdict`: unusable answer increments `unusableReviews` (`retry-review` once, then pauses `reviewer`); `done` → `done`, `blocked` → `needs-you`, `paused` → `paused (asked)`, `wait` → keeps `active` with `waitingSince` (pauses `wait-limit` at 30 min), `continue` → checks stall/round limits then increments `rounds`.
  - `applyGoalCheck`: `passed` → `done`; else increments `rounds` up to `maxRounds` (`round-limit`).
  - `goalNoticeRound`: counts a waking notice as a round for reviewed goals (pausing `round-limit` at cap) and spends no check for command goals. `goalRoundNotStarted` rolls back an unstarted round count.
  - `resumeGoal`: moves non-active goal back to `active` at `rounds: 1`, `stalls: 0`, `unusableReviews: 0`, current `boot`.
  - `windowWanted` is preserved only on `blocked` and `stalled` stops and cleared on new rounds or `windowRoundStarted`.

### Loop coordinator (`goal-loop.ts`)

`GoalLoop` coordinates one `reviews` look, one `relooks` idle-wait, and one `watchdogs` 30-minute timer per chat:

- After `runSettled`, drops any in-flight look (restoring an uncounted round via `dropLook`), waits `GOAL_SETTLE_DELAY_MS` (1.5 s), backs off to `relookWhenIdle` if busy, then runs pre-checks, review/check, CAS write, and `startRound` guarded by `isCurrent()`.
- `noticeRound` drops any stale look, counts the round, and starts the notice round; if it fails to start, rolls back the round count and schedules `relookAfterNotice`.
- `promptExpired` → `needs-you (unanswered)`; `windowClosed` → `paused (chat-closed)`; `accessChanged` → `paused (access-changed)`; `shutdown` sets `stopped = true` and aborts all reviews, relooks, and watchdogs.

## Keep-awake controller (`main/services/keep-awake/keep-awake-core.ts`)

Pure controller over injected `KeepAwakeInput`s, `KeepAwakeBlocker`, `KeepAwakeClock`, and `idleSeconds()`:

| Condition                                                              | Blocker state                                             | Timers                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `!enabled` or `disposed`                                               | Released immediately                                      | Grace and idle poll cleared (`dispose` also clears `recheckTimer`).     |
| `reasons.length > 0`, idle cap reached (`>= 4 h`) and no exempt reason | Released (`pausedWhileIdle: true`)                        | Idle poll (`60 s`) keeps running to re-acquire when the person returns. |
| `reasons.length > 0`, active or exempt (`check-back`, `wake-up`)       | Acquired (`holding: true`, `pausedWhileIdle: false`)      | Grace cleared; idle poll (`60 s`) active.                               |
| `reasons.length === 0` while holding                                   | Kept during `KEEP_AWAKE_GRACE_MS` (`60 s`), then released | Idle poll stopped; grace timer armed once.                              |

`recheckAt` across inputs schedules one bounded `recheckTimer` clamped to `[1 s, 1 h]`. Status changes publish only when serialized `KeepAwakeStatus` changes.

## Scheduled task link trigger (`main/services/scheduled-task-link-trigger.ts`)

Two-stage webhook gate (`admit` before body read, `tooLarge` on body abort, `deliver` after read) with **two separate per-task rate buckets** plus one global unknown-token bucket:

1. **Global unknown-token bucket:** `UNKNOWN_LINK_CALLS_PER_MINUTE` (120/min). An unknown token returns `404` until exhausted, then `429`, without touching any real link's quota.
2. **Per-task admission bucket (`recent`):** `callsPerMinute` (60/min), reserved in `admit` with a unique admission ID **before** reading the task (so a disabled known token still consumes its link's 60/min and returns `404` without releasing its slot).
3. **Per-task refusal bucket (`refused`):** `REFUSED_LINK_CALLS_PER_MINUTE` (30/min), completely separate from `recent`.

| Response                                               | Slot behavior (`recent`)                                                                        | Refusal bucket (`refused`) & logging                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `429`                                                  | Pre-slot refusal (no slot taken)                                                                | Not charged to `refused`.                                                     |
| `404` (known disabled/non-webhook token)               | **Retained** in `recent` (not released)                                                         | Not logged.                                                                   |
| `415` (wrong content type)                             | **Released** via `refuse(taskId, admission)` (or fast-rejected pre-slot if `refused >= 30/min`) | Charged to `refused`; not logged.                                             |
| `413` (body > 256 KB, via `tooLarge` or `deliver`)     | **Released** via `refuse(taskId, admission)`                                                    | Charged to `refused`.                                                         |
| `401` (bad/missing HMAC-SHA256 signature)              | **Released** via `refuse(taskId, admission)`                                                    | Charged to `refused`; logs coalesced `bad_signature` only for first 30/min.   |
| `400` (invalid JSON or depth > `MAX_JSON_DEPTH` 32)    | **Released** via `refuse(taskId, admission)`                                                    | Charged to `refused`; logs coalesced `invalid` only for first 30/min.         |
| `202` (filtered, duplicate, daily_limit, held, queued) | Kept in `recent`                                                                                | Always answers `202` with empty body so callers learn nothing about the task. |

Batching helpers (`mergeLinkBatches`, `linkEventText`) hold up to 20 calls (`SCHEDULED_TASK_LINK_LIMITS.batch`), dropping oldest calls and trimming the longest entries to stay within `maxChars`.

## Follow-through delivery and checks (`main/services/follow-through/`)

### `NoticeDelivery` (`notice-delivery.ts`)

Serializes delivery per `chatId` via `chains` (`post` and `inOrder`). `hasPending(chatId)` is true while chained unless the chat is in `waitingOnRun`.

1. Probes `queueIntoRun(post)` (up to `MAX_ATTEMPTS = 4`):
   - `queued` → returns `{ kind: "queued" }`.
   - `saved` (run ended right after persist) → `wakeSaved`: tries `startGoalRound` (attended, no wake budget), else `startTurn` within `MAX_WAKES_PER_CHAT_PER_HOUR` (6/h rolling window), else returns `{ kind: "recorded" }`.
   - `rejected` → `waitForIdle` and retry.
   - `busy` (foreign-owned run holds the chat, identified by `holder`): if `holder` already matched `outlasted.get(chatId)`, skips straight to `record()`. Otherwise waits once on `waitForRunToSettle` and retries; if still busy, waits on `waitForRunToEnd` (1 day bound), records `outlasted` if unsettled, then records without waking (calling `onError` if dropped and `!gone`).
2. When `no-run`: if `wake`, tries `startGoalRound` first, then `startTurn` (if `wakesLeft > 0`), else `record()` (up to 4 attempts of `append` / fallback `queueIntoRun` / `waitForIdle`, returning `dropped` with `gone: true` when the chat is gone).

### `GoalCheckRunner` (`done-when.ts`)

Runs at most one command check per `chatId` (10-minute timeout, 3,000-char fenced tail):

- Starting a new check for a chat aborts and awaits the previous check (`previous.settled`) before registering the new `RunningCheck`.
- `stopChat(chatId)`, `interruptWorkspace(workspaceId)`, and `shutdown()` (sets `closed = true`) abort matching controllers and await `settled`.
- `goalCheckResult` returns `{ kind: "stopped" }` on abort or `CheckInterruptedError`, else `{ kind: "finished", passed: exitCode === 0 && !timedOut, summary, details }`.
- `migrateDoneWhenRecords` migrates legacy `waiting`/`running` `/until` records into `paused` (`cause: "restart"`) command goals while retaining unreadable chats in `kept`.

## Event routine dispatcher and watches (`main/services/bot-routine-events/`)

### `createEventRoutineDispatcher` (`dispatcher.ts`)

Shared owner-keyed event core for Bot routines and chat trigger tasks:

- **Admission (`emit`):** Under per-owner `store.mutate`, rejects paused/disabled/stale `watchRevision`, deduplicates against `seenEventIds`, `held`, and `running`, enforces daily cap (`perDay`, default 24), and enforces minimum gap (`minGapMs`, default 5 min) or full `running` slots (`BOT_EVENT_RUNNING_MAX`) by holding the event (replacing or merging via `mergeHeld`) and arming `heldTimers`. When immediately admitted, snapshots original task/condition (`prepare`) and writes a durable `running` receipt (`claimPending: true` if `claimRoutineExecution` is wired) **before** calling `claimAndStart`.
- **Two-phase claim & run (`claimAndStart` → `start`):** `claimAndStart` completes `claimRoutineExecution` and clears `claimPending` durably before `start` runs. `start` re-reads the store, checks `sameSource` and `watchRevision`, acquires `authorizeRun` for watches, re-reads after authorization, and invokes `dependencies.run`. Only `settled !== false` removes the `running` receipt; throws or `settled: false` leave it for `rearm()`.
- **Requeue & drop notices (`requeue`, `reconcileRequeue`, `showDrops`):** Atomically drops `settles` from `running`, optionally refunds the daily count, and either merges back into `held` (respecting `notBefore`) or records a durable `dropNotices` entry past `maxRetries`. A failed `requeue` write triggers exponential-backoff `reconcileRequeue` (`5 s` → `5 min`); `showDrops` tracks `shownParts` so no notice part is shown twice across retries up to `BOT_EVENT_DROP_NOTICE_TRIES`.
- **Lifecycle fence:** `dispose()` bumps `generation` and cancels all `heldTimers` and `recoveryTimers`; in-flight work from an earlier generation never starts a run even after `resume()`. `idle()` drains all tracked `pending` promises.

### `createEventWatches` (`watch.ts`)

Periodic watch runner keyed by owner:

- **Single-flight per watch:** `inFlight` prevents overlapping checks of the same routine; `rearm()` is serialized (`rearming` chain) and aborts in-flight checks whose `updatedAt` moved or whose routine was disabled/removed.
- **Durable transition before dispatch:** `performCheckNow` records `baseline`, `no_change`, `error` (3 consecutive failures or `check.pause === true` disable the watch and notify `paused`), or `changed`. On `changed` (hash diff, semantic connector change, or non-empty `reportsOutput`), it saves the new hash/baseline **and** `watch.pending` (`eventId`, `payload`, `revision`, `nextAttemptAt`) in one `store.mutate` before calling `deliverPending`.
- **Pending delivery (`deliverPending`):** Re-authorizes via `authorizeDispatch` (pausing on error), emits to `dispatcher.emit` with `watchRevision` and `isCurrent`, and clears `watch.pending` only on durable dispatcher acceptance (`queued`, `held`, `duplicate`, `daily_limit`). Otherwise reschedules `nextAttemptAt` 60 s later.
- **Lifecycle:** `dispose()` increments `generation`, aborts all `inFlight` checks, and cancels all timers.

## Schedule service core (`main/services/schedule-service-core.ts`)

Owner: `main/services/schedule-service-core.ts` (`createScheduleServiceCore`, `createCatchUpQueue`).

- **Per-task serialization (`withTaskLifecycle`):** Serializes `start` scheduling, `save`, `remove`, `pause`, `resume`, `rescheduleAll`, and `resumeWorkspace` per `taskId`. Mutations stop the cron job and `cancelAndSettle(taskId)` before persisting, and roll back + re-arm on `signal.aborted` or store error.
- **Single-slot execution (`runningTasks`):** One active `RunningTask` per `taskId`. A new dispatch skips (`already-running`) unless the prior entry is obsolete automatic preparation (`automatic && !executionStarted && !isCurrent()`), which is superseded. `runEvent` loops and awaits the running task's promise so trigger events for one task run sequentially.
- **Startup & catch-up (`createCatchUpQueue`, `startupRevision`):** `start()`, `stop()`, and `setGlobalEnabled()` bump `startupRevision` so stale startup reads and cron callbacks fail `isCurrent()`. Missed runs queue through `createCatchUpQueue` (`CATCH_UP_CONCURRENCY = 2`, `CATCH_UP_STAGGER_MS = 3 s`, optional `shouldDefer` policy, `clear()` bumps queue generation).
- **Chat task guards (PR `#879`):**
  - Automatic fires > `CHAT_TASK_LATE_LIMIT_MS` (12 h) late (with no newer occurrence inside 12 h) advance the schedule and record `result: "skipped", reason: "too_late"` without executing.
  - `CHAT_TASK_FAILURES_TO_PAUSE` (3) consecutive unattended failures (`error` or non-cancelled `blocked`, ignoring `skipped`, cancelled, and manual failures) disable the chat task (`failurePausedAt`) and invoke `pausedAfterFailures`.
  - Trigger tasks (`task.trigger`) do not arm a `Cron` job; `runEvent` rejects with `ScheduledTaskIneligible` (`missing` | `paused` | `no_trigger`) when ineligible.
- **Bot routine recovery (`pendingRoutineFires`):** `queuePendingRecovery` and the periodic `scanPendingRoutines` timer (60 s, exponential backoff up to 15 min) replay pending fires and delayed retries (marking superseded retries `observeOnly: true` so the executor only checks receipts).
- **Workspace fencing & shutdown:** `cancelWorkspace` adds `workspaceId` to `blockedWorkspaces`, stops matching jobs, awaits `workspaceReady`, and settles running tasks. `stopAndSettle()` cancels all tasks and bounds shutdown wait to 5 seconds.
