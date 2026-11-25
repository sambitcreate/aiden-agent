# Post-Nov-4 High-Consequence Desktop Owners (Phase 3B Worksheets)

Reviewed against `main` baseline `b2b5c3517` (2026-11-24). Covers the high-consequence desktop state-machine owners that arrived after the 2026-11-04 inventory (`82c5b3849`) outside PR #879 Proactive Aiden (covered in `docs/state-machines/proactive-aiden.md`) and `bot-execution.ts` / `bot-peers/service.ts` (covered in `docs/state-machines/bot-execution-and-peers.md`). Design canvas sync (`renderer/design/use-design-canvas.ts`) is audited alongside Design Mode in its dedicated slice.

Dispositions follow Lanes A–D: **Retained** (existing owner already centralizes transitions; no wrapper extracted), **Retained, with fixes** (reproduced defects fixed in place with behavioral tests), or **Converted** (explicit transition core extracted).

---

## 1. `main/services/aiden-mcp-tools.ts` (542 lines) — Retained

Owner: `AidenMcpToolRunner`, backing external MCP clients (Claude Code, Codex, etc.) over `/mcp`.

### Axes & Invariants
- **Authorization & drain fence:** Every `call()` (`#L163-192`) checks tool existence, capability (`server:read`, `chat:read`, `chat:write`), TypeBox schema, then calls `dependencies.acquireAuthorization(app.id, tool.level === "write")` (`#L179`) with a `finally { release(); }` guard (`#L189-191`) so revocation waits for in-flight writes and never leaks a drain hold on unexpected throws. Unexpected non-`ToolRefusal`/non-`AidenRemoteServiceError` errors return a fixed generic `toolError` without leaking internal exception messages.
- **Admission & request dedupe:** Write turns (`aiden_chat_start`, `aiden_chat_send`) run through `turnRequest()` -> `ChatRunCore.request()` (`#L464-484`) with per-app (`pendingRequests: 8`) and host-wide (`hostPendingRequests: 32`, including disconnected/revoked apps' unsettled work) caps (`DEFAULT_AIDEN_MCP_LIMITS` `#L63-69`). Rate limiting (`turnsPerMinute: 10`, sliding 60s window in `turnTimes`) and concurrency (`concurrentRuns: 2`, via `core.liveRuns`) run in `admitTurn()` (`#L487-505`) only when the request was not already durably recorded (`hasRecordedRequest`).
- **Wait & revocation:** `aiden_chat_wait` delegates to `ChatRunCore.wait()` (`#L377-387`), returning `closed` on `revokeApp()` (`#L195-198`, which calls `core.forget(appId)` and deletes `turnTimes`), `aborted` on request signal abort, or a snapshot (`running`, `waiting_for_approval`, `waiting_for_input`, `done`, `failed`). `aiden_chat_stop` checks `CHAT_RUN_TERMINAL_STATES` first (`#L451`) and returns `{ stopped: false, state }` without calling `streams.cancel` for already-finished runs.
- **Visibility isolation:** `requireOrdinaryChat` (`#L519-528`) hides Bot, assistant, and design-project chats behind the same error as unknown IDs; no tool can answer approvals or questions.

**Tests:** `main/services/aiden-mcp-server.test.ts` (extended with `AidenMcpToolRunner` unexpected-error authorization release/redaction, terminal `aiden_chat_stop`, and aborted `aiden_chat_wait` watcher-detach behavioral coverage).

---

## 2. `main/services/bot-plans/*` (`plans.ts` 472, `authority.ts` 211, `lifecycle.ts` 33, `store.ts` 74) — Retained

Owners: `createBotPlans` (`plans.ts`), `createBotPlanAuthority` (`authority.ts`), `createBotPlanLifecycle` (`lifecycle.ts`).

### Transitions & Linearization Points
| Phase / Event | Owner | Guard / Fence | Next / Effect |
|---|---|---|---|
| `request` | `plans.ts#L232-259` | Per-Bot `serial`; rejects unreadable store or replay identity mismatch; joins identical waiting `planId` or ends older waiting card | `waiting` map (1 visible card per Bot) or idempotent replay of saved plan/receipt |
| `respond("approve" \| "not_now" \| "stop")` | `plans.ts#L289-336` | `transition(botId, endsAuthority)` increments `terminating` fence; `approve` stages `next` and validates `options.revalidate` + `fence` inside `writeJsonAtomic.beforePublish` before settling | `active` with single `expiresAt` timer (`schedule`), prior active plans marked `finished`, `fresh` one-shot grant slot recorded |
| `grantFreshAccess` | `plans.ts#L260-288` | Consumes one-shot `fresh` entry, revalidates, checks `terminating`/`deleted`/`aborted`/expiry before and after `apply()` | Ends plan fail-closed if revoked or throw occurs |
| `cover` -> `admit` | `plans.ts#L337-413` | `cover` mints `WeakSet`-tracked `BotPlanPermit` and records `counted[executionId]`; `admit` persists `admittedAt` under `finalFence` then revalidates one final time before synchronously invoking `start()` | Invocation (not completion) is linearized against `Stop`; restart never infers prior external effect |
| `markStep` / `endRuns` / `forgetBot` | `plans.ts#L414-470` | `terminating` fence + `rememberEnd` synchronously calls `options.revokeAccess` and records in-memory `terminal` fail-closed overlay even if disk save fails; `forgetBot` sets `deleted` synchronously before serial cleanup | Terminal `finished` / `stopped` / `expired` with immutable compact `BotPlanReceipt` |
| Session lifecycle hooks | `lifecycle.ts#L5-33` | Synchronous `running` `Set<string>` so session queues never await plan serial; only observed runs ending `idle`/`needs_model`/`model_error` (or explicit `settled`/`stopped`) fire `endRuns`; `paused`/`interrupted` preserve recovery; sync and async `endRuns` errors route to `onError` | Fires `endRuns(botId, "finished" \| "stopped")` once |

- `authority.ts` (`createBotPlanAuthority`) pins every proposal to `botPlanBindingRevision(authority, effectiveRules)` and validates fixed locations, folder device/inode identity, and `finalFence` synchronously after the last awaited read.

**Tests:** `main/services/bot-plans/{lifecycle,plans,authority,validate}.test.ts` (extended `lifecycle.test.ts` with synchronous `endRuns` throw clearing `running` and `forgetBot` settling an in-flight waiting plan request).

---

## 3. `main/services/bot-messages/*` (`courier.ts` 1,084, `ledger.ts` 551, `lifecycle.ts` 42) — Retained

Owners: `createBotMessageLifecycle` (`lifecycle.ts`), `createBotMessageCourier` (`courier.ts`), `createBotMessageLedger` (`ledger.ts`).

### Transitions & Shutdown Fence
| Event | Prior | Guard | Next / Effect |
|---|---|---|---|
| `post` | `closed === true` | None | Immediately returns `{ status: "refused", code: "unavailable", message: "Bot messaging is shut down." }` without constructing courier |
| `announceWaiting` | `closed === true` | `!ids.some(isBotMessageRequestId)` -> returns `undefined`; if any Bot-message request ID is present -> throws `"Bot messaging is shut down."` (fail closed so a Bot-message approval cannot proceed unannounced) | Fails closed for Bot-message waits; no-op for ordinary turns |
| `forgetBot` | `closed === true` | Calls `requireCurrent()` | Throws synchronously `"Bot messaging is shut down."` without instantiating courier |
| `dispose` | Any | Sets `closed = true` synchronously, awaits `current?.dispose()` (which sets `disposed = true`, unsubscribes listeners, cancels all `timers`/`scheduled`, aborts `workers`/`receiptWatches`/`waits`, awaits `Promise.allSettled` of all in-flight promises, then cancels any re-armed timers) | Shut down; late tools cannot lazily recreate courier |
| `start` | `closed === true` | Explicit runtime initialization only | Resets `current = undefined`, `closed = false`, constructs fresh courier, catches startup errors via `deps.report` |

- Inside `courier.ts`, durable deliveries live in `ledger.ts` (`delivered` -> `answered` / `expired` / `failed`) with replay-hash dedupe (`botMessageReplayHash`), hop/chain-loop/rate-limit enforcement (`post` `#L798-922`), per-delivery serialized workers (`workers` + `dirty` re-queue), deadline timers that deny pending approvals with `"expiry"`, and `forgetBot` denying matching pending approvals before/after ledger removal (`#L1022-1058`).

**Tests:** `main/services/bot-messages/{lifecycle,courier,ledger,real-courier,tool,framing,roster}.test.ts` (extended `lifecycle.test.ts` with pre-start `dispose()` fencing `post` and `forgetBot` without lazy courier construction).

---

## 4. `main/services/gemini-live/app-control/provider.ts` (915 lines) & `renderer/lib/live-*` — Retained, with fixes

### `AidenAppControlProvider` (`main/services/gemini-live/app-control/provider.ts`)
- **State axes:** `closed` + `lifetime` (`AbortController`), `busy` + `current` (active `use_aiden`/`open_in_aiden`), `confirming` + `pendingConfirm` (guarded control OK wait), `watch` + `idleTimer` (renderer outline/take-over watcher), `refs` + `signatures` (element numbers invalidated on `onNavigate` `#L361`, new `handleLook`, mid-session disable, or `close()`), `calls` (session cap 120).
- **Key semantics:**
  - `interrupt()` (`#L386-389`): aborts `current` and `endActing()`, intentionally keeping `pendingConfirm` alive so barge-in does not discard a pending user confirmation.
  - `onNavigate` (`#L361-364`): clears `refs` and aborts `pendingConfirm` with `CONFIRM_PAGE_CHANGED`.
  - `enabled()` turning `false` mid-session (`#L406-421`): synchronously aborts `current` and `pendingConfirm`, stops acting, and clears `refs`.
  - `close()` (`#L391-404`): sets `closed = true`, aborts `current` and `lifetime` (which aborts `pendingConfirm`), ends acting, detaches navigation listener, clears `refs`, and closes the CDP port.
- **Defects reproduced & fixed (2026-11-24):**
  1. `handle()` (`#L367-373`) and `confirmThenAct()` (`#L835-846`) did not recheck `this.closed` after `await this.enabled()`, allowing a `close()` that landed while `enabled()` was pending to execute page actions or port calls on a closed provider and arm a dangling `idleTimer`. Fixed by rechecking `this.closed` right after `await this.enabled()` in both methods, guarding `this.refs` assignment in `look()` (`#L594-597`), and guarding `scheduleIdle()` in `finishAction()` (`#L688`). Reproduced in `main/services/gemini-live/app-control/provider.test.ts`.

### Renderer Live Boundary (`renderer/lib/live-*.ts`) — Retained
| File (lines) | Owner | Key State & Invariants |
|---|---|---|
| `live-session-bus.ts` (277) | `LiveSessionBus` | Monotonic `voiceInputFence()`/`beginVoiceInput()`, `setSession()` aborts & clears all `inFlight` tool requests on session switch; `cancelToolRequest` immediately answers uncommitted requests as `cancelled` while committed requests still report their true outcome once (`reported` flag) and run `afterReport`/`afterSettled` hooks. |
| `live-app-control.ts` (279) | `LiveAppControlController` | Per-utterance action budget (`actions`, reset on `onVoiceInput`), trusted-only `userInput` take-over (`isTrusted`), one-shot `confirm` settlement (voice armed only after `awaitDelivery: true` + `voiceInputFence`), and `reset()`/`dispose()` clearing timers, watches, and confirmations. |
| `live-chat-approvals.ts` (593) | `LiveChatApprovalsStore`, `LiveChatVoiceApprovals` | Owner-symbol-fenced snapshot store; voice arming requires `awaitDelivery: true` -> `LIVE_APPROVAL_ARM_DELAY_MS` (2.5s) -> `voiceInputFence()` -> `LIVE_SPEECH_FENCE_GUARD_MS` before accepting allow-once/deny phrases; `answering`/`answered` prevent duplicate answers; sensitive/harness/remote prompts stay tap-only. |
| `live-chat-tools.ts` (333) | `LiveChatRequestGate`, `createLiveChatToolHandlers` | Serialized `tail` queue per window; `LiveChatRequestGate` advances `fence` whenever `untrusted_chat_content` or a delivered note reaches Live and blocks mutating tools until fresh speech starts strictly after `fence`; `tail` waits on `afterSettled` before the next tool runs. |

**Tests:** `npm run test:gemini-live` (`provider.test.ts` extended with close-during-`enabled()` and barge-in-vs-close `pendingConfirm` tests).

---

## 5. `main/services/hooks/*` (`hook-service.ts` 1,061, `hook-dispatcher.ts` 452, `hook-script-files.ts` 516) — Retained, with one fix

- **`hook-service.ts`**: Serializes all store mutations (`approveProposal`, `saveHook`, `approveDigest`, `setEnabled`, `deleteHook`) through one `serialized` queue; enforces digest-pinned approval (covering in-workspace script hashes from `hook-script-files.ts` and `targetDigest` CAS for update/delete proposals); fails closed on unreadable profile stores (denies tool calls and refuses Settings overwrites); `setPaused(true)` stops all background `async` hooks via `dispatcher.stopBackgroundHooks()` (`#L1002-1008`).
- **`hook-dispatcher.ts`**: Enforces `AsyncLocalStorage` re-entrancy guard (`isInsideHookRun`), fail-closed `PreToolUse` on load error or unmatched guard refusal (marked `uncacheable`), bounded foreground concurrency (`4`) and background `async` queue (`4` running / `32` queued) with `stopBackgroundHooks()` and `whenBackgroundIdle()`, and 3-failure auto-disable (exempting fail-closed `PreToolUse` hooks).
  - **Defect reproduced & fixed (2026-11-24):** `outcomes.delete(key)` in `dispatch()` (`#L415-418`) deleted unconditionally when an aborted/uncacheable/throwing dispatch settled; if `clearIdempotencyCache()` ran while the first dispatch was in flight and a replacement dispatch with the same `idempotencyKey` completed before the stale first dispatch aborted, the stale cleanup evicted the fresh cached outcome. Fixed with `BoundedMap.deleteIf(key, pending)`. Reproduced in `main/services/hooks/hook-dispatcher.test.ts`.
- **`hook-script-files.ts`**: Pure lexical/filesystem scanner (no command execution) with bounded words (`128`), files (`16`), and file size (`256 MiB`); fails closed (`overLimit`) on unclosed quotes or exceeded caps.

**Tests:** `npm run test:hooks` (`hook-dispatcher.test.ts` extended with aborted idempotent dispatch + evicted in-flight replacement protection).

---

## 6. Brief Disposition Checks (Retained)

| Owner (lines) | Disposition | Key Invariants & Existing Coverage |
|---|---|---|
| `main/services/approval-rules/{store,rules-page,file-store}.ts` (225 / 433 / 55) | **Retained** | `ApprovalRuleBook` serializes mutations through `store.update`, validates round-trip target parsing and byte/count caps before saving, throws `ApprovalRulesUnreadableError` (fail-closed) when `readable()` is false, and refuses overwrites until `setAside()` or clean `refresh()`. Covered by `main/services/approval-rules/rules.test.ts` & `main/handlers/approval-rules.test.ts` (`npm run test:approval-gate`). |
| `main/services/bot-settings-changes/{service,tool,ports}.ts` (307 / 107 / 188) | **Retained** | Per-Bot `createKeyedSerial()`, `applied` (owner-only, untainted, non-widening) vs `held` (capped at 5 pending), revision-checked compare-and-swap `ports.write(botId, patch, revision)` throwing `BotSettingsConflictError` so intervening edits are preserved (`undo_refused` on stale undo), and atomic persistence to `settings-changes.json`. Covered by `main/services/bot-settings-changes/{service,ports,tool}.test.ts` (`npm run test:bot-runtime`). |
| `main/services/desktop-stream-handoff.ts` (403) | **Retained** | `DesktopLiveStreamAccumulator` (bounded 2 MiB/stream, 64 streams) and `DesktopHandoffTicketStore` (one-shot `claimDraft`/`claimChat`, 30s TTL, max 16 tickets, `deferDetachIfPending` holding source detach until claim/expiry/abandon, `abandonChat` running deferred detaches immediately, `clear` cancelling timers). Covered by `main/services/desktop-stream-handoff.test.ts` (`npm run test:aiden-service-boundary`). |
| `main/windows/quick-chat-window.ts` (347) & `renderer/quick-chat/floating-chat-app.tsx` (1,141) | **Retained** | Main window singleton shares `loading` promise, tracks `loadingWindow` so `destroyQuickChat()` tears down mid-load windows, gates conversation access via `authorizedQuickChatIds` + `rendererDocumentOwner`, and delegates mode/bounds/blur logic to pure `quick-chat-window-core.ts`. Renderer view holds UI state fenced by `generationIntentRef` and `popoverOpenGenRef` with no host authority of its own. Covered by `main/windows/quick-chat-window-core.test.ts`, `main/handlers/quick-chat.test.ts`, and `renderer/quick-chat/floating-chat-app.test.tsx` (`npm run test:aiden-service-boundary`). |
