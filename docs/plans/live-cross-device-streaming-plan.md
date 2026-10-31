# Live, smooth streaming across desktop, iOS and Android

Status: Merged (2026-10-13) through #448, #450–#459 and shipped in 0.56.0. Originally planned 2026-10-12 on `fix/live-cross-device-streaming`, rebased onto `origin/main` at `19e55a67`. Line references are from the research pass at `23bade81`. Since then, `renderer/components/message-list.tsx` has changed substantially (generative-UI live visuals, commit 57a5ff34), so re-verify those references before editing.

References used, both MIT-licensed:
- T3 Code at `80664d5266` (© 2026 T3 Tools Inc.).
- Hermex at `c9efaa9` (© 2026 Uzair Ansar).

We reimplement the ideas. If any code is copied verbatim, its notice goes in `THIRD_PARTY_NOTICES.md`.

## Problems

| # | Symptom | Root cause |
|---|---------|------------|
| P1 | "Response continues in the background…" appears twice | `composerPlaceholder` returns the readiness message as the placeholder (`renderer/lib/composer-placeholder.ts:42`), and `Composer` also prints it as a status line (`composer.tsx:2177`). This happens for every readiness message. |
| P2 | A phone-started turn appears on the Mac only once it finishes | The remote owner (`chat-generation-owner.ts:49`, `id: 0`) publishes only to the Remote SSE journal (`aiden-remote-streams.ts:588`). No `chat:*` event reaches the renderer. The Mac re-reads the transcript on `chats:settled`. |
| P3 | A Mac-started turn appears on the phone only once it finishes | The server already serves it at `GET /chats/:id/runs/current/events`, and both clients can render it. But the clients probe only at `load()` / `ON_START`, and stop for good after a 404. |
| P4 | Desktop text arrives in lumps and jitters | Several causes: the reveal runs per-sentence or per-72-char units with a 4px `translateY`; lists and tables re-render as one growing block; text before a tool step dumps when the step arrives; and the finished reply renders twice during the handoff (the persisted `message:${id}` row and the `key="streaming"` row together, for up to 2s), then swaps to a different DOM tree, with `RichLinkBudget` remounted by its key. |
| P5 | Desktop drops stick-to-bottom while streaming | `ScrollArea` sets `atBottom = distance < 24` on every scroll event (`ui.tsx:916-932`). One commit that grows the content by more than 24px turns follow off before the ResizeObserver follow runs. There is no `overflow-anchor: none`. |
| P6 | iOS jump-to-bottom stops short; streaming doesn't stay pinned | Four causes. (1) The latch is purely distance-based (72pt). Frames during the 0.2s animated jump flip it back to "away", which also drops the `.sizeChanges` anchor. (2) `LazyVStack` uses estimated heights, so `scrollTo` lands short, and nothing scrolls again. (3) There is no per-tick follow, only `onChange(messages.count)`. (4) `liveText +=` runs per delta without coalescing, and the whole reply re-lays out as one `Markdown` view. |
| P7 | Android has the same problems | `followLatest` counts as true when the offset is ≤ 80px, but nothing re-pins while text grows, so the newest lines sit under the composer. On completion, the plain-`Text` live card and the `RichFormattedMessage` final row coexist for a frame, then the format reflows. A jump issued during a fling may be cancelled. `animateContentSize` animates height under the pin. |

## Shared design rules

All three platforms follow these rules.

1. **Follow is a latch driven by what the user does, not by distance.** Content growth, keyboard insets and layout settling never turn follow off. Only a user gesture does: a wheel-up with overflow, a drag, a scrollbar press, PageUp/Home/ArrowUp, or a mobile pan. Follow turns back on only when a gesture settles near the bottom: 40px on desktop, 12pt or 12dp on mobile. Distance controls only whether the jump button is visible: 80 when idle, 160 while streaming. The button appears after 150ms away from the bottom and hides immediately.
2. **The jump is a reset, followed by a deferred snap that is checked again after layout.** It cancels in-flight scrolls, forces follow on, and ignores leftover momentum. It snaps without animation while streaming, because animated scrolls get cut off by the next tick. While following, every reveal tick re-snaps, so any height-estimate error corrects itself within one tick.
3. **Text is released only at safe boundaries, and new content fades rather than moves.** Settled blocks are memoized. Only the live tail re-parses or re-lays out. New blocks fade in with opacity only, with no `translateY` and no per-glyph animation. Reduce Motion means instant reveal, with no fade and no glide.
4. **Streaming and settled replies share one tree, and the reply settles in place.** No reply is rendered twice, and finishing a reply doesn't remount it.
5. **Cost is zero when nobody is watching** (cross-device). Use cursor reads of the existing `HostRunRegistry` journal, which already coalesces deltas, and open subscriptions only while a surface shows a chat that something else is running. Add no polling of transcripts.

### Reveal cadence (decision)

- **Desktop:** T3-style paragraph gating. `StreamingRevealParser` already finds safe boundaries (the last top-level blank line). Add list-item boundaries, and make a heading wait for its first following line. Release at most every **300ms**, and always release on done, error or cancel. Each newly released top-level block fades in with **opacity over 450ms ease-out**, using `@starting-style` gated on `[data-streaming]` inside `prefers-reduced-motion: no-preference`. Gating happens in the renderer, not the server, so phones and the CLI keep receiving raw deltas.
- **iOS and Android:** a Hermex-style **50ms word-boundary gate**. It shows everything buffered up to the last whitespace and holds a trailing fragment for at most one tick, so CJK text, URLs and code never stall. When the markdown splitter seals a new chunk, that chunk fades in once (opacity, 180ms, off under Reduce Motion or Low Power). Hermex found that per-word pacing and glyph fades lagged on LAN bursts and dumped on slow tunnels, so we do not revive pacing on mobile.
- Decided 2026-10-12: phones follow Hermex (word gate), not paragraph gating.
- Paragraph mode is not proposed for mobile yet. A "Smooth / Live" streaming preference like T3's `responseStreamingMode` stays a follow-up. Add it only if you want the phones to feel the same as the Mac.

## Stacked PRs

There are three independent lanes, because they touch different directories and can review and merge in parallel. Within a lane, each PR is stacked on the previous one. Following AGENTS.md, update stacked branches by merging `origin/main`; never rebase a branch that already has a PR.

### Lane D: Desktop (`renderer/`, `main/`)

**D1: One readiness line** (base `main`)
- Change `composerPlaceholder` to return a short neutral placeholder whenever the composer shows the readiness status line. For the background case, the placeholder is "Waiting for the response…". The status line stays, because it is a `role="status"` region that wraps and carries the Settings action.
- **Tests:**
  - Extend `composer-placeholder.test.ts`.
  - Add a composer render test asserting the readiness text appears exactly once.
  - Replace the source-grep assertions at `chat-transition.test.tsx:354` and `environment-subagents-contract.test.ts:592` with that render check.

**D2: Stick-to-bottom latch** (on D1)
- In `ScrollArea` (`renderer/components/ui.tsx:846-1105`) and `renderer/lib/scroll-follow.ts`, replace `atBottom = distance < 24` with a pure `followReducer`:
  - Inputs: `userIntent(wheelUp | drag | scrollbar | key)`, `settle(distance)`, `contentResize`, `jump`.
  - Outputs: `following`, `showJump`.
- While following, the ResizeObserver sets `scrollTop = scrollHeight` directly.
- Add `overflow-anchor: none` to the transcript scroller.
- Keep the PR #250 programmatic smooth-jump latch, and its release rules, unchanged.
- Optionally glide (a short smooth scroll) on paragraph landings while streaming, only under `prefers-reduced-motion: no-preference`.
- Keep the `AgentActivityTransition` status line's height fixed, so its timers stop shifting the bottom.
- **Tests:**
  - Unit tests for `followReducer`:
    - more than 24px of growth with no user action stays following;
    - wheel-up turns follow off;
    - a settle within 40px turns it back on;
    - a jump survives momentum.
  - A Playwright test with a streaming fixture that checks:
    - the view stays pinned across 50 chunks, including list and table growth;
    - after a wheel-up, the view is not pulled back;
    - clicking jump lands at `scrollTop + clientHeight === scrollHeight`.

**D3: Settle in place** (on D2)
- Hide `persistedHandoffMessageId` from `messages` while the streaming row is mounted. Better still, key the streaming row by the persisted message id once `chat:done` provides it, and flip it to `streaming=false` in place.
- Make the streaming and settled paths render through one markdown tree:
  - memoized settled blocks for the stable prefix (`SettledMessageRow` memo);
  - a live tail;
  - code fences that keep the same element and gain highlighting in place;
  - no `RichLinkBudget` remount key, with link budgets enforced inside the shared tree.
- When a tool step splits the text, the earlier text row finishes its remaining reveal on the next release tick instead of dumping.
- Preserve the live-visual rule from 57a5ff34: live generative-UI visuals stay mounted, and settled rows stay memoized.
- **Tests:**
  - A render test: during the handoff there is exactly one assistant node with the reply text, and block DOM nodes keep their identity through completion (same element references).
  - Retire the source-grep `streaming-motion-contract.test.ts` and replace it with this behavioural coverage.
  - Update `message-bubble.test.tsx`, which covers the handoff and HTML artifacts.

**D4: Paragraph reveal** (on D3)
- Replace the per-unit timer in `streaming-markdown-reveal.tsx` and `streaming-reveal.ts:82-104` with a release gate. It releases at most every 300ms, at the parser's safe boundaries plus new list-item and heading-with-body boundaries, and flushes on terminal events.
- Lists and tables grow one item or row at a time.
- Replace the CSS fade with an opacity-only transition at `styles.css:1747-1765, 1960-1966`: 450ms, `@starting-style`, gated on `[data-streaming]`. Remove the `translateY`.
- **Tests:**
  - Release-schedule unit tests:
    - at most one release per 300ms;
    - an unterminated fence or heading waits;
    - a list releases per item;
    - a terminal flush releases everything immediately.
  - Keep the prefix-equivalence invariant (`streaming-reveal.test.ts:291`).
  - Update `tests/e2e/chat-shell-interactions.spec.ts:541`, which counts `.streaming-reveal` nodes, to assert whole-block reveal instead.

**D5: The Mac shows phone-started turns live** (base `main`, its own branch; it touches the detached-projection store and main IPC rather than the message-list files D2–D4 change)
- Find what left the screenshot's chat draining with no projection. A phone-only turn cannot register a detached marker, so it was a held desktop-detached owner (`clearInactiveDetachedLifecycleChat` keeps it while `activeChatIds.has(chatId)`) or a window reload mid-turn. Clear the stale marker when the chat's run settles.
- **Main:** add `runs:observeLocal(chatId, afterSequence)` and `runs:unobserveLocal(id)` over `hostRunRegistry.currentRunForChat`, `read` and `subscribe`. Push batched (16ms) run frames only to the subscribing `webContents`, and release them on destroy. Reuse `projectRunContentNotification`.
- **Renderer:**
  - Implement `LocalHostAdapter.observe`, which is currently a no-op, following `RemoteHostAdapter.observe` (pending-frame replay).
  - Translate the frames through `remote-stream-translator.ts` into the detached projection store (`rememberDetachedLifecycleStream` / `updateDetachedProjection`).
  - `ChatPane` observes only when `chats:activity-changed` marks the visible chat active and the pane does not own the generation.
- **Tests:**
  - A register-and-invoke IPC test with a fake registry: cursor resume, no frames from other chats, unsubscribe on destroy.
  - A translator unit test.
  - A Playwright test that starts a turn through the Remote router harness and sees live text in the Mac pane before `chats:settled`.

### Lane I: iOS (`ios/`)

**I1: Hermex follow latch and a reliable jump** (base `main`)
- Port the `ChatScrollPolicy` `FollowLatch` / `resolveFollow` state machine into `AidenChatScrollPolicy.swift`, which today says it is "adapted from Hermex" but is distance-only:
  - follow turns off on pan `.began`;
  - follow turns back on only when a gesture settles within 12pt, after 160ms of momentum quiet and 50ms between ticks;
  - `.reset` sets `ignoresCoastingGesture`;
  - growth never turns follow off;
  - button thresholds are 80pt idle and 160pt streaming.
- Feed the latch from a UIKit observer, using pan-gesture target and KVO on `contentOffset`/`contentSize` and coalescing once per run loop, instead of `onScrollGeometryChange`.
- The jump sends `.reset`, advances a generation token, waits `Task.yield()` plus 16ms, re-checks, then calls `scrollTo("chat-bottom", anchor: .bottom)`. It snaps while streaming and animates only when idle.
- Add a leaf `StreamingFollowTrigger` view that re-snaps on every reveal tick while following. It is a leaf so the bump doesn't re-render the screen.
- Bind `.sizeChanges` to `.bottom` only while following.
- Keep `LazyVStack` (EXT-21). The per-tick re-snap corrects estimated-height error, so test an eager `VStack` over the 50-message window in Instruments only if the problem remains.
- **Tests:**
  - Port Hermex's `ChatScrollPolicyTests` cases into XCTest, especially:
    - reset survives coasting momentum;
    - streaming growth never turns follow back on;
    - a drag that ends above the bottom stays off.
  - Extend `testJumpToLatestThreshold…`, and add a view-model test that the jump generation cancels a stale snap.

**I2: Word gate and per-chunk markdown** (on I1)
- Add a 50ms `StreamingRevealGate` in `AidenChatViewModel` that buffers `textDelta` and flushes on terminal or non-delta events. This replaces per-delta `liveText +=`.
- Render the live reply as one `Markdown` view per sealed chunk plus one tail view. Reuse the `AidenMarkdownBlockSplitter` boundaries and the `AidenMarkdownContentCache` entries instead of concatenating into one `MarkdownContent`. Keep the EXT-10 limits: 512 entries, 400k bytes, blank-line-safe splits.
- New sealed chunks get a 180ms `.transition(.opacity)`, disabled under Reduce Motion or Low Power. Remove `.animation` from the streaming rows (`AidenLiveResponseView`).
- Settle in place: the final row reuses the chunk views' identities, so completion causes no reflow.
- **Tests:**
  - Gate tests: a burst shows whole on the first tick; a held fragment is released on the next tick; text flushes on finish, error or cancel.
  - Splitter and cache tests proving settled chunks are not re-parsed per tick.

**I3: Attach to Mac-started turns while open** (on I2)
- When `applyProgress` sees a new non-null `agentRoster.turnId` while nothing is attached, call `startForeignRunObservationIfNeeded`. After a 404, retry once after 400ms.
- For devices without `agents:read`: while foregrounded with no progress SSE, probe `runs/current` with backoff from 5s to 30s, stopping on background.
- **Tests:**
  - The chat opens idle, then a roster with a new `turnId` arrives; the client attaches and renders live text from fixture run events.
  - A run that ends before attach causes exactly one transcript reconcile.

### Lane A: Android (`android/`)

**A1: Follow latch, follow loop and jump** (base `main`)
- Keep `reverseLayout = true`.
- Change `AidenChatScroll.kt` as follows:
  - Drag start turns follow off. Detect it with a `NestedScrollConnection` (`onPreScroll` with `NestedScrollSource.UserInput`) or the list's `interactionSource` drag interaction.
  - Follow turns back on only when the drag or fling settles at index 0 with offset ≤ 12dp.
  - 80px and 160px control only whether the button is visible.
- Add a follow loop: `snapshotFlow { liveTextLength }` while following, calling `listState.requestScrollToItem(0, 0)`, or `scrollToItem` on older Compose. This re-pins to offset 0, not merely ≤ 80.
- Jump: `listState.stopScroll(MutatePriority.UserInput)`, then `scrollToItem(0, 0)`, then one `withFrameNanos` re-check.
- Remove `animateContentSize` from the activity card while it is pinned (`AidenChatDetailScreen.kt:1898`).
- **Tests:**
  - Latch reducer unit tests in `AidenChatScrollTest`.
  - Extend `AidenChatChromeUiTest`:
    - swipe up, stream through a fake ViewModel, and the list position is unchanged with the button shown;
    - tap the button, keep streaming, and `firstVisibleItemIndex == 0 && firstVisibleItemScrollOffset == 0`, with the last text node's bounds above the composer.

**A2: Word gate and settle in place** (on A1)
- Add the 50ms word gate on top of `AidenLiveTranscriptBuffer`'s 33ms frame.
- Render the live card through `RichFormattedMessage`, as sealed chunks plus a tail, instead of plain `Text`.
- Clear the live card atomically with the final message publish (`clearFinishedStream`, `AidenChatViewModel.kt:2903-2926`), or give both one stable key, so completion doesn't jump. Sealed chunks fade in once (180ms, off when animations are disabled).
- **Tests:**
  - Gate unit tests, the same cases as I2.
  - A Compose UI test proving no frame shows both the live card and the final message with the same text.

**A3: Attach to Mac-started turns while open** (on A2)
- Same as I3, implemented through `acceptAgentRoster` and `retryForeignRunObservation()`.
- **Tests:** JVM tests mirroring I3.

### Optional, only if the roster signal is unreliable

Add a `run_update { runId, state }` progress event, emitted on begin and settle. It must be gated behind a new feature token and device capability, because both progress parsers reject unknown event types. Claim the next revision after main's at merge time (main is at 29). Update `contract.json`, `openapi.json`, the iOS fixture and the Android contract tests together.

## Out of scope

- Streaming to a backgrounded phone. Live Activity already covers the phone's own turns; extending it to foreign runs belongs to the Live Activity plan.
- Moving desktop generations into `AidenRemoteStreamService`, which is scoped to one device.
- MAIN-32 (`chat:done` payload size) and UI-9 (moving streaming text into an external store). Revisit them only if D3 profiling shows ChatPane re-renders still matter.

## Acceptance

- Each PR runs its narrow suites locally before CI. New test files go into the `package.json` test scripts and `scripts/ci-test-registry.json`, and `npm run test:ci-policy` must pass.
- Device run, recording evidence in `.memory/live-cross-device-streaming.md`:
  1. Stream a long reply with lists, a table and code on the Mac; it should stay pinned and reveal paragraph by paragraph.
  2. Scroll up mid-stream; the view should not be pulled back, and the jump should land at the true bottom.
  3. Repeat steps 1 and 2 on iPhone and Android.
  4. Start a turn on the phone and watch the Mac update live.
  5. Start a turn on the Mac with the chat open on both phones, and watch both update live.
  6. Repeat with Reduce Motion on: instant reveal, no fades.

## Update 2026-10-21: iOS settle and pacing follow-up

The owner reported flicker and jitter in iOS workspace chats and asked for slower, smoother streaming. Findings and changes (iOS only, no Remote protocol change):

- **Settle in place was not met.** On `done`, `finishStream` published the reconciled transcript and then awaited the cache before clearing the live reply, so the reply rendered twice for at least a frame, the same desktop P4 bug. The live copy is now cleared in the same main-actor turn as the publish. A reply with only tools or reasoning also vanished between `done` and the transcript read; it now stays until the settled transcript replaces it (`showsLiveResponse`).
- **"Working for" moved.** It sat above the live reply and disappeared at `done`, moving the reply up. It now sits in a footer-height row below the reply, where the settled "Worked for" footer replaces it.
- **Optimistic sends kept their row.** The server message ID replaced the local one in the `ForEach`, so the row was recreated and its thumbnails reloaded. Rows now keep the local ID as their render identity.
- **Pacing revisited.** The 50ms gate above showed each burst whole, which reads as lumps when the Mac or network delivers text unevenly. The gate now ticks every 33ms and shows at least 1/8 of the backlog (minimum 3 characters, rounded up to whole words), so a burst drains over about a quarter second. A backlog over 600 characters is shown down to 600 at once, which addresses Hermex's lag concern. `done` keeps draining (a third of the backlog per tick) while the settled transcript is read instead of dumping it; error, cancel and other non-delta events still flush. Placeholders and visual cards in the live reply stay until it settles. Reduce Motion keeps the unpaced word gate. Bot session partials use the same gate. Android still uses the unpaced gate.
- **Open Markdown in the tail.** While streaming, the open tail is drawn through `AidenStreamingMarkdownTail`, which closes open inline code, strong, emphasis and strike on the last line, shows a link that is still arriving as its label, and hides an unfinished line that is only a block marker. Sealed chunks and settled replies always use the real text.

