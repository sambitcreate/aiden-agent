# iOS responsiveness, efficiency, and optimistic UX audit

Audit date: 2026-09-27. Source baseline: `a9baa4aa3027893e5455043083465c34b4c8b4ac`. Audit only; no product changes, builds, simulator/device launches, network requests, or user-state access. All line references are repository-relative at this baseline. Prior memory distinguishes compiled-only phases from later targeted simulator execution (including the recorded 185/185 AidenChatTests follow-up). None is a fresh performance run at this baseline; this report does not upgrade historical validation into device or timing evidence.

Reviewed root and iOS working agreements, iOS response-ownership/draft-restoration, mobile-stream-recovery and chat-scroll-follow memory, plan inventory, mobile foundation/bot-first plans, existing efficiency and long-thread plans, and the Swift implementations below. Historical plans contain historical findings; this report checks current source instead of assuming those findings remain true.

## Verdict

Preserve the existing optimistic send/Favorites UX and cache-first navigation. The highest-value work is bounding stream and retained-cache memory, decoupling fresh transcript publication from catalog loading, reducing live-text presentation work, and adding deliberate transport/Live Activity lifecycle ownership. These are source-backed opportunities, not measured latency regressions. No milliseconds saved, battery percentage, memory peak, or frame-rate claim has been established.

## Prioritized opportunities

### IOS-01 — P1: bound the SSE producer/consumer queue without dropping control events

**Evidence:** `ios/AidenOnTheGo/Networking/AidenRemoteClient.swift:1879` constructs `AsyncThrowingStream` without a buffering policy; its producer calls `continuation.yield(event)` at line 1927. The parser independently reads bytes while the main-actor consumer awaits `apply` (`Features/Remote/AidenChatFeature.swift:3001`). That application can await approval reads and ActivityKit work. Individual frames are bounded, but the queued collection is not bounded by this client.

**Impact hypothesis:** replay bursts or a busy main actor can accumulate decoded events and delay meaningful control states. A bounded frame size is not an aggregate queue bound. Actual peak depends on server retention and producer/consumer rates and needs measurement.

**Change:** instrument queued events/bytes and consumer lag; introduce bounded backpressure or explicit overflow termination followed by read-only reconciliation/replay from the last applied sequence. Coalesce contiguous text deltas only when sequence/accounting remains exact. Never use `bufferingNewest` to silently discard approvals, terminal states, gaps, or tool transitions. Keep the progress channel separate.

**Tests/measurement:** delayed consumer plus burst fixtures, multibyte text, duplicate/gap frames, terminal/approval at overflow, cancellation during drain. Assert lossless text and ordered terminal delivery, bounded peak queue, no new turn POST, and cold replay correctness. Compare allocations and first/last-event-to-presentation latency before/after.

### IOS-02 — P1: bound aggregate admitted transcript memory while retaining ownership fences

**Evidence:** `Persistence/AidenChatCache.swift:271-292` holds per-instance admitted workspace lists, whole chats, and summaries. Line 657 retains each accepted canonical chat before disk persistence. The observed removal/purge paths at lines 878 and 917 onward remove entries, but there is no access-based aggregate eviction policy for ordinary navigation. Limits at lines 163-166 are per-file 10 MiB, summary count 10,000, and attachment disk budget 96 MiB; summary file default is 80 MiB at line 309. These are not an aggregate transcript heap budget.

**Impact hypothesis:** opening many distinct long chats/instances can retain increasing transcript memory even after leaving those screens. Shared-value storage may reduce duplication; do not sum every snapshot as an independent allocation without Allocations evidence.

**Change:** add byte/count-budgeted retention and memory-pressure handling, pinning active/pending-mutation data. Critically, do not evict the only admitted winner after failed disk writes and then fall back to older disk data. Keep lightweight generation/tombstone authority independently of evictable content; dirty winners need durable handling or explicit unavailable/reload state.

**Tests/measurement:** navigate through 10/100/500 synthetic chats with a fixed aggregate byte target, multiple installations, deletion/purge, disk-write failures, and stale delayed GETs. Assert bounded steady-state retention, no stale resurrection, correct warm reopening, and unchanged title/summary ownership. Record resident memory and actor wait time, not just cache counts.

### IOS-03 — P1: separate transcript publication from optional catalog latency

**Evidence:** `Features/Remote/AidenChatFeature.swift:1468-1476` starts chat and model-catalog GETs concurrently, then awaits their tuple before publishing either. A slow/failed catalog therefore delays/discards fresh transcript publication even when the chat GET succeeded. Cached/current content remains available, so this is a fresh-content coupling rather than a universally blank screen. Progress initial snapshot reads at lines 1624-1640 are sequential. `load` calls `loadProgressSnapshot` at line 1492 and then starts an observer whose loop calls the same loader at line 1664; scene callbacks can also start observation earlier.

**Change:** accept each independently with its existing request/context/transcript-generation fences; retain the last catalog for display while marking routing authority appropriately. Do not enable previously unauthorized models from stale metadata. Deduplicate progress bootstrap and refresh into one observation owner; parallelize task/roster reads while keeping their independent error/freshness states.

**Tests/measurement:** hold catalog while chat succeeds, fail either side, switch instances mid-await, and race Send against refresh. Count bootstrap GETs; verify one intended snapshot per projection and that failure of roster does not mark tasks stale. Compare navigation-to-cached-content and navigation-to-fresh-content separately, with 0/100/500 ms synthetic delays. These delay values are test inputs, not measured production RTTs.

### IOS-04 — P2: batch growing live presentation, preserve immediate controls

**Evidence:** `Features/Remote/AidenChatFeature.swift:3122` onward appends each text/reasoning delta to observable strings. `AidenLiveResponseView` recomputes bot and chronological projections from growing text/timeline (`:5783-5822`), and calls `AidenMarkdownView(content: visibleText)` (`:5943`). Markdown policy scans character/line counts (`:5682`) and builds Markdown content (`:5726`). Full live output has no presentation-cadence gate in this path. SwiftUI may coalesce invalidations; one body evaluation per wire event is not established.

**Existing mitigation:** settled rows are separated and `.equatable()` (`:4086-4101`); each settled message is also equatable (`:4517` onward). The live list is lazy. Markdown falls back above 80,000 characters or 2,000 lines and disables remote inline images and syntax highlighting. Do not report all settled Markdown as being reparsed per token.

**Change:** measure body/projection/parse work first; keep immediate first text and approval/terminal updates, but publish intermediate prose at an explicit bounded cadence. Cache projections by text/timeline revision and avoid repeated computed projection evaluation within one body. Consider incremental or plain-text streaming presentation followed by settled Markdown only if visual acceptance supports it.

**Tests/measurement:** 1k/20k/80k-character output with Markdown tables, long code, reasoning and tools; replay at multiple synthetic event rates. Compare CPU, parse counts, hitches and terminal latency. Verify exact final text, copy/accessibility output, approval visibility, scroll-away preservation, reduce motion and VoiceOver behavior. Shared transcript presentation changes require Android inspection and focused parity tests.

### IOS-05 — P2: own transcript transport and ActivityKit updates across visibility changes

**Evidence:** view phase/disappearance handlers stop progress observation and audio (`Features/Remote/AidenChatFeature.swift:3907-3912`, `:3966-3980`), but do not stop transcript consumption. Transcript cancellation appears in deinit/removal/replacement (`:1259`, `:1282`, `:2972`). Its task awaits an instance consume method, so weak capture at creation should not be assumed to guarantee deallocation during an active consume. This is a lifecycle risk to trace, not proof of an immortal object.

When chat is not quiet/foregrounded, text deltas await `liveActivities.appendResponse` (`:3125-3126`). `LiveActivities/AidenRemoteLiveActivityManager.swift:94-104` transforms each token and `:214-226` calls ActivityKit update without equality/cadence suppression. OS throttling does not remove application-side transformation/API work.

**Change:** document a bounded active-run owner independent of view lifetime, with explicit visible/hidden/background policies. If a view transport pauses, retain exact resume semantics and reconcile on foreground; never cancel server work merely because navigation changes. Coalesce identical/intermediate Live Activity states and flush approval/final/error states immediately. Preserve bounded excerpts and user excerpt preference.

**Tests/measurement:** push/pop active chats, switch Bots/Workspaces, background/foreground, lock/unlock and reconnect. Count live consumers and ActivityKit update attempts, check terminal state and no duplicated turns. Use physical-device Energy Log/wakeups for final acceptance; simulator timing is not battery evidence. Define permitted active-run activity before asserting zero background work.

### IOS-06 — P2: back off failed progress reconnects

**Evidence:** `Features/Remote/AidenChatFeature.swift:1655-1701` reloads task/roster snapshots, opens a progress SSE connection, then waits a fixed one second after termination/failure. Transcript recovery has separate adaptive delay handling (`:3064` onward), but the progress loop does not. Under persistent transient failure, foreground viewing can repeatedly attempt snapshot requests and reconnection. Revocation/access denial already clears/stops appropriately.

**Change:** bounded exponential backoff with jitter, reset on meaningful successful progress, and cancellation/foreground/network reachability integration. Do not add periodic model-catalog or benchmark fetches. Preserve separate stale labels and explicit refresh.

**Tests/measurement:** injected refusal, EOF, offline duration, credential revocation and recovery; use an injected clock. Assert bounded attempts, no attempts after stop, fresh snapshot on recovery and no permanent stale lockout. Record requests and wakeups during a fixed disconnected interval before/after.

### IOS-07 — P2: avoid repeated whole-summary serialization on the shared cache actor

**Evidence:** `Persistence/AidenChatCache.swift:761-785` validates and JSON-encodes the complete summary envelope to check size, then `save` encodes it again (`:1187-1190`). Accepted detailed chats project into summaries (`:659-663`), so this work can occur on chat settlement. Synchronous disk/JSON work runs on the cache actor; it is not proven to block the main actor, but awaited cache operations queue behind it.

**Change:** reuse validated encoded bytes in an atomic write helper while preserving admission-before-IO semantics and current error handling. Measure actor occupancy before considering per-instance IO separation or more complex persistence. Avoid deferring writes that represent removals or mutation receipts without an explicit durability contract.

**Tests/measurement:** 100/1,000/10,000 summaries, disk failure, held writes, purge and rename races. Compare encoding count, bytes written and p95 cache-operation queue time. Existing ownership tests must remain semantic oracles, not source-shape tests.

## Optimistic action matrix

| Action | Current behavior / safe immediate feedback | Authority, rollback and unknown outcome |
| --- | --- | --- |
| Navigate/open cached chat | Bot cached transcript is published read-only before permissions (`Features/Remote/AidenProductShellView.swift:950-1005`); workspace list hydrates admitted cache (`AidenChatFeature.swift:788`). Preserve this. | Scope by instance/device/chat and navigation attempt. Fresh permissions, capability and notice checks must finish before enabling remote mutations. Never infer authority from a warm cache. |
| Send message | Already optimistic: append local message, clear composer, mark queued (`AidenChatFeature.swift:1941-1981`). | Successful receipt replaces local ID. Failure restores/merges current draft and attachments (`:2070-2090`). Stable key is reused for equal request (`:265-279`); tracker is in-memory. Lost response is an unknown server outcome, not proof of failure. Preserve receipt/reconciliation; do not auto-create another turn after SSE failure. A durable attempt ledger is an optional separately designed improvement for process death, requiring protocol checks and crash tests. |
| Favorites reorder/toggle | Already sets immediate `favoriteOverride` (`Features/Bots/AidenBotsHomeView.swift:760-768`). | Revisioned update; failure performs authoritative GET, token-owned cleanup restores prior override (`:783-825`). Keep local intent pending until confirmed. On failed reconciliation label unknown/stale rather than claiming remote rollback. |
| Rename chat | Current flow waits for PATCH; accepted title has field-specific overlay (`AidenChatFeature.swift:862-895`). | Optional pre-receipt local title preview is safe only as pending presentation. Do not mutate canonical revision/transcript. On conflict restore/refresh only this attempt's field; on ambiguous transport outcome reconcile by GET. Existing post-receipt overlay and coherent-read prerequisite for the next mutation must survive. |
| Delete chat | Row already removed immediately (`AidenChatFeature.swift:930`); cancellation/error reinserts, generic failure reloads (`:945-953`). | Never claim deletion or purge private cache before successful authority. A cancellation can mean unknown remote result; proposed improvement is explicit reconciliation on ambiguous cancellation, not automatic DELETE retry. Rollback must not overwrite newer independent list/detail winners. |
| New Bot/chat/workspace | Show pending navigation/shell and disable duplicate action immediately. | Canonical IDs, permissions, filesystem effects and persistence require receipt. Do not invent a normal selectable entity or replay a mutation after timeout. Reuse only the documented idempotency contract for that exact operation; unknown outcome requires canonical reconciliation. |
| Stop / steer / queue / redirect | Show request pending and prevent duplicate taps. | Server continues to own execution. Do not optimistically display stopped/completed or discard active recovery state. Current stop-cancellation test explicitly covers retained controllability (`AidenChatTests.swift:599`). Match receipts/stream state before success. |
| Approve/deny, access policy, schedule/run-now, Git/file writes | Immediate pressed/pending feedback is appropriate. | Must await authoritative permission/revision/receipt. Never pre-grant access, claim a command executed, or hide an unanswered approval as completed. Unknown outcomes require read-only reconciliation; retries need documented stable IDs/idempotency, not generic retry middleware. |
| Attachments | Local selected thumbnail and preparation progress can appear immediately; conversion already runs off-main (`AidenChatFeature.swift:178-189`). | Send must await validated upload handles and live permission/model compatibility. Cancellation/removal fences must defeat late upload completion. Displayed local preview is not upload success. |
| Appearance, disclosure, scroll, draft edits | Apply locally immediately. | Local persistence errors should not overwrite newer input; no remote success fiction. Keep draft-generation/session fences and cache namespace. |

## Existing foundations to preserve

- No per-token chat-cache/cursor persistence: warm sequence is memory-only (`AidenChatFeature.swift:3006-3010`); cold restore must replay from a complete persisted basis. This removes a common disk-amplification concern already addressed here.
- Cache actor admission and request-origin tokens prevent late requests replacing newer detail/rename/list state, even on disk failure. Recent response-ownership memory is essential when changing hydration and eviction.
- Detached attachment conversion, actor-isolated ImageIO thumbnail decode and NSCache limits of 24 / 32 MiB (`AidenChatFeature.swift:5505-5545`); attachment disk pruning at `AidenChatCache.swift:1058`. Do not propose wholesale image offloading as if absent. Investigate original-image decode and PhotoKit grid only if image traces show a remaining peak.
- Warm Bots home retains cache before HTTP and loads independent segments concurrently (`AidenBotsHomeView.swift:1044-1085`); Favorites conflicts refresh canonical state.
- Frame/body bounds and certificate/identity validation are correctness boundaries, not performance knobs to disable (`Networking/AidenRemoteContract.swift:30-32`, `Networking/AidenRemoteClient.swift:2148-2174`).

## Validation and delivery sequence

1. Add content-free signposts/counters for open/cached/fresh publication, catalog wait, queue depth/lag, live projection, cache admission/IO, reconnect and active-consumer count. Do not log prompts, credentials, paths or raw payloads.
2. Establish repeatable release-build synthetic baselines: cold/warm opens, long-thread replay, concurrent progress, attachment grid, 100-chat navigation, ambiguous mutations and visibility transitions. Record device/OS/build, thermal/low-power/network conditions and sample count; report p50/p95 and maximum memory, not a single best run.
3. Implement IOS-03 and IOS-07 as focused low-scope changes; implement IOS-01/02 with replay/ownership fault tests before changing lifecycle or live rendering. P1 is priority, not a claim that a production crash has been reproduced.
4. Extend existing `AidenChatTests`, `AidenRemoteClientTests`, `AidenBotCacheTests`, and Bot/native integration tests. Existing relevant cases include cold replay without per-event persistence (`AidenChatTests.swift:2231`), pending optimistic message retained across reload (`:2297`), progress-handle restart (`:296`), and cancelled old observer not clearing new owner (`:318`). Inspect coverage before adding duplicate tests.
5. Run affected XCTest with an explicit simulator/device destination plus registered `npm run test:ios-release`; the latter is release-policy/host checks, not Swift UI/runtime or energy proof. Shared wire changes must update protocol fixtures and both Android and iOS consumers/tests. Shared transcript changes need both mobile suites. Record compiled-only versus executed evidence accurately.

Acceptance budgets should be set after baselining. Required invariants can be specified now: bounded queue/cache growth under the agreed fixture, no duplicate mutation, no unauthorized optimistic state, no stale response resurrection, no extra offscreen progress observer, exact final transcript, and zero reconnect attempts after explicit owner cancellation. Physical-device energy and accessibility acceptance remain future work.
