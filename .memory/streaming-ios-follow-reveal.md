# iOS streaming: follow latch, reveal gate, foreign-run attach — 2026-10-13

Part of the live cross-device streaming plan (iOS lane I1–I3). The direction was "do exactly what Hermex does" (`/Users/sambitbiswas/projects/opp/hermex`, MIT). Copied or adapted Hermex code is credited in `THIRD_PARTY_NOTICES.md` under "Hermex (iOS transcript follow and streaming reveal)". No protocol changes were made.

## I1 — follow latch (`stream/ios-i1-follow-latch`)

- `AidenChatScrollPolicy.swift` holds a pure latch reducer. `AidenChatScrollObserver.swift` feeds it from a UIKit pan and content-offset observer.
  - A drag away from the bottom stops auto-follow at once. Only a return to within 12 pt of the bottom re-arms it.
- Streaming growth snaps the view through a trigger leaf coalesced at 16 ms, so the chat owner is not re-rendered.
- Every follow scroll carries a generation token, so a stale snap never lands after a newer jump or drag.
- The jump button appears after a short settle and hides as soon as the view returns to the bottom.
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
- `scripts/check-ios-shipping-target.test.mjs` has one existing source-grep regex. It was only widened to accept `replaceLiveText("")`. Follow-up: replace it with a behavioural bot-snapshot test.

## I3 — attaching to runs started elsewhere (`stream/ios-i3-attach-foreign-runs`)

- Announced turns:
  - `applyProgress(.agentsUpdate)` compares the accepted roster's `turnId` with `lastRosterTurnId`. `acceptAgentRoster` updates `lastRosterTurnId` from both the snapshot fetch and live events.
  - A new turn calls `attachToAnnouncedTurn()`, which runs `startForeignRunObservationIfNeeded(reason: .announcedTurn)`.
  - If an attach is already in flight, `announcedTurnAwaitingAttach` defers the new turn until that attach ends.
  - Turns this phone starts are skipped because `activeStreamID` or `isStarting` is set.
- `observeForeignRun` takes a `ForeignRunAttachReason`: `.load`, `.announcedTurn` or `.probe`.
  - An announced attach retries once after `announcedRunRetryDelay`, which is 400 ms. It retries when it gets a 404 before any frame arrives. It also retries when `runs/current` replays a finished run whose ID matches `foreignRunAccountedRunId`.
  - The host returns the newest *retained* run for the chat, so a just-announced run can lose that race to the previous run.
- A run that finished before the attach (`ForeignRunStep.endedBeforeAttach`) is never shown live.
  - `.announcedTurn` reconciles the chat exactly once.
  - `.probe` reconciles once, and only when the run ID is new.
  - `.load` does not reconcile, because the load has just read the chat.
  - An announced run that still answers 404 after the retry also reconciles once.
- Devices without `agents:read` (`!canReadAgentRoster`) get a foreground-only probe:
  - `startForeignRunProbeIfNeeded` starts it from `startProgressObservation` and `load(observeProgress: true)`.
  - `stopProgressObservation` stops it. That covers scene suspend, disappear and removal.
  - The backoff is `foreignRunProbeDelay(afterIdleProbes:)`: 5 s, 10 s, 20 s, then 30 s. It resets after a run goes live (`foreignRunsShownLive`).
  - Tests shorten the waits with `foreignRunProbeSleep`.
- Tests live in `AidenChatTests`:
  - The announced-run tests and the probe tests use `AidenAnnouncedRunFixture`.
  - The progress stream stays open through `openEventStreamStatus`, and the test pushes roster frames with `pushEvent`. Only one sink exists, so a live `runs/current` response takes the sink over.
