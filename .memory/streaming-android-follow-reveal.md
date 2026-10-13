# Android live streaming: follow latch, word reveal, foreign-run attach

These three stacked slices bring Hermex's streaming behaviour (MIT, credited in `THIRD_PARTY_NOTICES.md`) to the Compose chat: A1 is `stream/android-a1-follow-latch`, A2 is `stream/android-a2-reveal-gate` and A3 is `stream/android-a3-attach-foreign-runs`. The transcript keeps `reverseLayout = true`, with the live card as item 0 under `LIVE_STREAM_ITEM_KEY`.

## Follow latch (A1, `AidenChatScroll.kt`, `AidenTranscriptFollow.kt`)

- The reducer has three inputs:
  - Reset turns following on.
  - The start of a user drag turns it off.
  - When the gesture settles, following re-arms only if the list is at index 0 within 12 dp, after 160 ms quiet following a drag or 50 ms after momentum ends.
- Content growth never turns following off. ContentScrolled events were dropped because they are unnecessary in Compose.
- The jump button appears past 80 dp when idle and 160 dp while streaming.
  - A tap stops the fling (`MutatePriority.UserInput`), scrolls to `(0, 0)`, then re-checks after one frame.
  - Sending a message also jumps to the latest.
- A detached reader inside item 0 holds still: `holdReaderInsideLeadingItem` watches `layoutInfo` and, when the same leading key grows while not following or dragging, grows the scroll offset by the same amount (`requestScrollToItem`).
- Only vertical-dominant user input (`|y| > |x|`) detaches, so a sideways swipe through a wide code block keeps following.
- Rows drop `animateContentSize` only while pinned to the streaming edge (`isPinnedToStreamingEdge`).
- UI tests settle gestures with `mainClock.advanceTimeBy(DRAG_SETTLE_MILLIS + MOMENTUM_SETTLE_MILLIS)`, because the latch's delays run on the test clock.

## Reveal and hand-off (A2)

- `AidenStreamingRevealGate`: a 50 ms tick over the 33 ms `AidenLiveTranscriptBuffer`.
  - Each tick shows text up to the last whitespace.
  - A trailing fragment is held for one tick at most, so CJK text and URLs never stall.
  - Later tokens do not push the tick back.
  - A reply that is replaced or shortened is published at once.
  - `flush()` runs on every non-delta event and when a foreign run ends.
- `AidenStreamingMarkdownSplitter` ports Hermex's splitter:
  - It uses fence-aware seams and seals a chunk at 6000 or more UTF-8 bytes.
  - Fences follow the renderer, not CommonMark: `CODE_BLOCK_REGEX` pairs non-overlapping ``` runs wherever they sit, so each run toggles code and tildes are prose. A property test uses the regex as its oracle.
  - A `Session` keeps sealed chunks and scans only past the last seal; it starts over when the reply no longer extends its sealed prefix.
  - Seams match `RichFormattedMessage`: chunks are trimmed like its prose, the gap is 8 dp next to code, and a blank-line seam is `2 × line height − one measured line` (separate texts trim their first and last line's leading). UI tests compare live and final heights.
  - `AidenStreamingRichText` renders the sealed chunks plus the tail through `RichFormattedMessage`.
  - A sealed chunk fades in with `AidenMotion.nonSpatial` only if its text was never on screen, such as after a burst or when catching up.
  - Nothing fades on first composition or under `aidenReduceMotion()`.
- Hand-off: `AidenChatScroll.showsLiveCard(streamState, hasLiveOutput)` keeps the card after a terminal state while live output remains.
  - The view model publishes `_chat` and clears the live text in one main-thread step, so no frame shows both or neither.
  - Before this fix, the screen hid the card on DONE, before the transcript was re-read, which left a gap.
  - The handoff sampler in `AidenChatTest.assertStreamRecovery` skips the independent-owner variants. In those, the fixture serves the final transcript to the model's own first load while the stream is still replaying.

## Attaching to runs started elsewhere (A3, `AidenForeignRunAttachPolicy`)

- With agents:read: an accepted roster snapshot whose `turnId` is new and non-null, after the first (baseline) snapshot, calls `startForeignRunObservation(retryNotFound = true)` while the chat is in the foreground. `agentEpoch != null` serves as the baseline marker.
  - A 404 from `runs/current` before anything is attached is retried once after 400 ms.
  - Only roster-prompted lookups retry.
  - The roster announcing this phone's own last started turn (`lastLocalTurnId`, from `startTurn`) is skipped, since it can arrive after the local stream ended.
- Without agents:read: `startForeignRunProbe()` runs only between `startProgressObservation()` and `stopProgressObservation()`.
  - It probes `runs/current` on a 5, 10, 20, then 30 s backoff.
  - The backoff restarts after a run is shown, or while this phone's own run or an attached run is live.
  - Each wait begins after any lookup in flight has answered (the probe joins `foreignRunJob` first), so the first wait never overlaps the lookup made on opening.
- No protocol changes.
- Tests: the `withForeignRunChat(agentsRead =, attach =)` harness in `AidenChatTest`. `AidenForeignRunAttachPolicy.pause` performs every wait, so tests log the requested waits next to lookups and release them from a channel instead of measuring real gaps.
