# iOS streaming: follow latch, reveal gate, foreign-run attach — 2026-10-13

Part of the live cross-device streaming plan (iOS lane I1–I3). The direction was "do exactly what Hermex does" (`/Users/sambitbiswas/projects/opp/hermex`, MIT). Copied or adapted Hermex code is credited in `THIRD_PARTY_NOTICES.md` under "Hermex (iOS transcript follow and streaming reveal)". No protocol changes were made.

## I1 — follow latch (`stream/ios-i1-follow-latch`)

- `AidenChatScrollPolicy.swift` holds a pure latch reducer. `AidenChatScrollObserver.swift` feeds it from a UIKit pan and content-offset observer.
  - A drag away from the bottom stops auto-follow at once. Only a return to within 12 pt of the bottom re-arms it.
- Streaming growth snaps the view through a trigger leaf coalesced at 16 ms, so the chat owner is not re-rendered.
- Every follow scroll carries a generation token, so a stale snap never lands after a newer jump or drag.
- The jump button appears after a short settle and hides as soon as the view returns to the bottom.
- Review fixes:
  - A resting finger (`isTracking` with no movement) does not stop follow.
  - An idle Jump that lands short of the bottom gets one corrective snap.
  - Scrolls with no pan gesture (keyboard, VoiceOver, status-bar tap) still settle the latch. Moving away is caught by `movedAwayFromBottom`. Arriving at the bottom from far above re-arms follow through `confirmBottomArrival()` after `animationSettle`, unless a drag or scroll-away happens in between (`bottomArrivalGeneration`). Trackpad and mouse scrolling go through the pan recogniser, so the normal drag-end path covers them.
- Tests: `AidenTranscriptFollowControllerTests`, `AidenChatScrollFollowTests`.

## I2 — reveal gate and sealed chunks (`stream/ios-i2-reveal-gate`)

- `ios/AidenOnTheGo/Features/Chat/AidenStreamingRevealGate.swift` is the Hermex `StreamingRevealGate` port:
  - A 50 ms tick shows everything buffered up to the last whitespace.
  - A trailing fragment is held for one tick at most, then released whole, so CJK text, URLs and code never stall.
- `AidenChatViewModel` buffers deltas in `pendingLiveText`:
  - `receiveLiveText` and `receiveCumulativeLiveText` feed it.
  - `replaceLiveText` replaces every former `liveText = ""` assignment.
  - Every terminal event, every non-delta event, the end of the stream loop, the catch path and `endForeignRunQuietly` flush the buffer first. Text written before a tool row therefore appears before that row, and terminal reconciliation sees the full text.
  - The tick is injectable through the `streamingRevealTick` init parameter. Tests drive it with `AidenManualRevealTicks`.
- `AidenMarkdownContentCache.chunks(for:)` returns sealed `AidenMarkdownChunk`s. A sealed chunk is never re-parsed while the tail grows. `AidenMarkdownChunkSpacing` reproduces the single-document block margins as leading gaps.
- Deviation from the plan: Hermex has no per-chunk fade. Aiden's splitter seals a block only after the next block's first line is complete, so a newly sealed chunk usually holds text that is already on screen.
  - `AidenMarkdownChunkReveal.newChunkIndices` fades only chunks that start at or past the previously rendered UTF-8 length.
  - There is no fade under Reduce Motion or Low Power Mode.
- Cumulative frames (foreign runs) are handled in bounded work by `AidenCumulativeReplyText`, which compares only the received UTF-8 count and a short tail rather than the whole reply.
- The bot-chat snapshot behaviour is covered by `testABotChatSnapshotDropsRevealedBufferedAndReasoningText`. The old source-grep regex in `scripts/check-ios-shipping-target.test.mjs` was removed.
- Chunk spacing finding: MarkdownUI draws `max(previous bottom, next top)` between blocks. Aiden's chat paragraph style sits outside `.markdownTheme`, so the theme's 16 pt paragraph margin wins and the intended 8 pt paragraph override has no effect. That is pre-existing on main and left as is. `AidenMarkdownChunkSpacing` therefore uses 16 pt after paragraphs, lists, quotes and code, which makes a settled chunked reply exactly as tall as the single-document render.

## I3 — attaching to runs started elsewhere (`stream/ios-i3-attach-foreign-runs`)

- Announced turns:
  - `acceptAgentRoster` compares every accepted roster's `turnId` with `lastRosterTurnId`. That covers live `agents_update` events and the snapshots read on load, reconnect and return to the foreground.
  - A changed turn calls `attachToAnnouncedTurn(reason: .announcedTurn)`.
  - The first turn a chat sees calls it with `.firstRosterTurn`. The opening lookup can be answered before a Mac run registers and before the first roster arrives, so that turn is looked up once, without the not-found retry. This mirrors Android PR #452 finding 1, which iOS also had. It costs one extra `runs/current` request the first time a chat with a roster opens.
  - If a lookup is already in flight, `turnAwaitingLookup` keeps the signal (an announced turn outranks a first-roster turn). Once that lookup ends, a single lookup covers every signal it kept. This is Android finding 2. iOS already coalesced the signal through a Bool, and it is now covered by a test.
  - Turns this phone starts are skipped while `activeStreamID` or `isStarting` is set. Setting `activeStreamID` also records the run in `foreignRunAccountedRunId`, so its turn announced after the stream ends is never read again.
  - A roster turn announced while `isRestoringStream` is set is parked in `turnAwaitingLookup` too, and the `isRestoringStream` didSet drains it when restoration ends. On a cold launch the progress observer races `load`. Without the parking, `runs/current` returned the phone's own run while `streamStatus` was still pending, and that run was shown live. The restored stream then replayed from sequence 0 onto the same buffer, so the reply appeared twice. The probe skips its check while restoring for the same reason.
  - Defensively, when an owned stream takes over from a live foreign run, the `activeStreamID` didSet clears `liveText`, `reasoning` and `tools`, because the owned replay rebuilds them.
- `observeForeignRun` takes a `ForeignRunAttachReason`: `.load`, `.announcedTurn`, `.firstRosterTurn` or `.probe`.
  - An announced attach retries once after `announcedRunRetryDelay`, which is 400 ms. Tests inject the wait through `announcedRunRetrySleep`. It retries when it gets a 404 before any frame arrives. It also retries when `runs/current` replays a finished run whose ID matches `foreignRunAccountedRunId`.
  - The host returns the newest *retained* run for the chat, so a just-announced run can lose that race to the previous run.
- A run that finished before the attach (`ForeignRunStep.endedBeforeAttach`) is never shown live.
  - It reconciles the chat once, and only when its run ID is new and the reason is not `.load`, which has just read the chat.
  - A run already accounted for, whether shown live, read before or this phone's own run, is neither replayed nor read again.
  - An announced run that still answers 404 after the retry also reconciles once.
- Devices without `agents:read` (`!canReadAgentRoster`) get a foreground-only probe:
  - `startForeignRunProbeIfNeeded` starts it from `startProgressObservation` and `load(observeProgress: true)`. The load starts it only while its progress generation is still current, so a load that resumes after the chat left the foreground does not restart it.
  - `stopProgressObservation` stops it. That covers scene suspend, disappear and removal.
  - The backoff is `foreignRunProbeDelay(afterIdleProbes:)`: 5 s, 10 s, 20 s, then 30 s. It resets after a run goes live (`foreignRunsShownLive`).
  - Tests shorten the waits with `foreignRunProbeSleep`.
- Tests live in `AidenChatTests`:
  - The announced-run tests and the probe tests use `AidenAnnouncedRunFixture`.
  - The progress stream stays open through `openEventStreamStatus`, and the test pushes roster frames with `pushEvent`. Only one sink exists, so a live `runs/current` response takes the sink over.
  - `isLookingForForeignRun` and `agentRoster?.revision` give tests deterministic waits instead of sleeps.
  - The fixture also serves this phone's own turn (`/turns` with stream `run-mac`) for the own-run accounting test.

## 2026-10-21 follow-up: settle in place, paced reveal, Markdown tail (thread "iOS chat flicker and jitter")

- Root cause of the settle flicker: `finishStream` published the reconciled chat, then `clearFinishedStream` awaited `cache.removeActiveStream` before clearing `liveText`, so for at least a frame both the settled message and the live view drew the reply. `clearLiveOutput()` now runs before that await, in the same main-actor turn as `chat = presented`. `reconcileMissingStream` clears right after its reconcile too (its Live Activity awaits come next). Foreign runs were already atomic (`endForeignRunQuietly` has no suspension after publication). Test: `testTheSettledReplyReplacesTheLiveReplyInOneUpdate` samples at every main-actor yield.
- `AidenChatViewModel.showsLiveResponse` keeps the live view while `activeStreamID`/`foreignRunIsLive` holds tools, reasoning or a timeline, so a tools-only reply doesn't vanish between `done` and the transcript read. `endForeignRunObservation` now also clears `activityTimeline`, otherwise this would show a stale timeline.
- `AidenLiveResponseView` puts "Working for" in a bottom row of `AidenMessageFooter.minimumHeight` (32pt), empty after the run ends, so the settled footer swaps in place.
- `messageRenderIDs` (server ID -> optimistic `local-` ID) set right before `chat = acceptedChat` in `send()`; `AidenTranscriptRowIdentity.rows` keys the settled `ForEach` and ignores an alias that would collide.
- Gate: 33ms tick, budget `max(3, ceil(backlog/8), backlog-600)`, rounded up to the end of a word; no-whitespace buffers hold one tick, then release whole when <= 24 chars or paced. `paced: false` (Reduce Motion, set from the views' `aidenReduceMotion`) is the old unpaced gate. The 2026-10-13 plan had decided against mobile pacing (Hermex lag); the owner asked for it, and the 600-char catch-up cap answers the lag concern.
- Bot session: `AidenBotSessionModel.revealedPartial` trails `partial` through the same gate; snapshots, rewrites and the answer entry apply at once.
- `AidenStreamingMarkdownTail.displayText` (in `AidenMarkdownContentCache.swift`) heals only the open tail when `chunks(for:streaming: true)`; it reuses the splitter's `Fence`. `_` emphasis is deliberately ignored.
- Not changed: composer height still reaches the transcript spacer through a preference (one-frame lag while the composer grows); Android still uses the unpaced gate and has no tail healing.
- Fable 5.1 approach check (same day) changes: `done` no longer flushes the backlog (it set `finishesStreamingReveal`, budget backlog/3 per tick, and the settle swap carries the full text); error/cancel/other non-delta events still flush. Healing repairs only the last line (an unbalanced `*` on a finished line is literal). Image placeholders, the visualizing card, chronological `active` and streaming Markdown in the live view now use `isLiveReplyUnsettled` (isStreaming || activeStreamID || foreignRunIsLive), so nothing shrinks between `done` and the settled read. Live content spacing is 10 like the settled message. Deferred from that check: flush only up to the timeline's largest `contentOffset` on tool frames, composer `.safeAreaInset`, EMA rate-based pacing.
- Pullfrog rounds (same day): healing skips indented-code last lines, finds inline code by matching backtick run lengths, and carries open inline markers across soft line breaks of one block but clears them at a block boundary (a heading line ends, or the next line starts a heading, a bullet, an ordered item that can interrupt (numbered 1, or after another item), or a deeper quote; quote markers are looked through, so blocks inside a quote stay separate and a lazy continuation line stays in the quoted paragraph). Only openers on the last line are closed or hidden.

