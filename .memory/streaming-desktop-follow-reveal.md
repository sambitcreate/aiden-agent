# Desktop streaming: follow latch, settle in place, block reveal

Plan: `docs/plans/live-cross-device-streaming-plan.md` (desktop lane D1–D4). Branches are stacked: `stream/desktop-d1-readiness-line` → `-d2-follow-latch` → `-d3-settle-in-place` → `-d4-paragraph-reveal`. Follow and reveal are modelled on T3 Code's `chat-markdown[data-streaming]` pattern, reimplemented here (no copied code).

## Follow (D2, `renderer/lib/scroll-follow.ts` + `ScrollArea` in `ui.tsx`)

- Follow is an intent latch, not a distance check. Only a wheel-up, a drag of the scrollbar, or a reading key (PageUp, Home, ArrowUp outside text fields) turns it off. It re-arms when the reader scrolls back down to within 40px of the end. Growth never turns it off.
- The reducer reads more than the wheel:
  - `pointerdown` on the viewport holds follow (`scrollbarHold`) until a window `pointerup` or `pointercancel` (`scrollbarRelease`), so dragging the scrollbar is the reader's choice.
  - A wheel tick with `|deltaY| <= |deltaX|` is a sideways pan and is ignored.
  - While following, a scroll that lands more than 40px above `pinnedTop` (the last pinned position) and was not caused by a pending jump is displacement by focus or by code, and turns follow off.
  - Reading keys on the document body (PageUp, Home, ArrowUp) apply only to the pane the pointer last pressed, not to every `ScrollArea`.
- The viewport is `overflow-anchor: none` only while following, so the browser's scroll anchoring keeps a reader's place when they have scrolled up. It is pinned in the layout pass, before paint. `data-follow` on the viewport mirrors the latch, and the e2e spec reads it.
- Wheel ticks that are still coasting within 160ms of a jump are swallowed (`preventDefault`), so trackpad momentum cannot cancel the jump.
- The jump button shows past 80px when idle, or past 160px while streaming.
  - While streaming, the jump is an instant snap.
  - When idle, it scrolls smoothly. If content arrived mid-animation and the scroll lands short (`scrollend`), it snaps to the bottom and keeps follow.
- The PR #250 smooth-jump latch and the 16ms delta coalescer are untouched.

## Settle in place (D3)

- A reply row is keyed `reply:${previousMessage.id}`, the message it answers, because the saved id is unknown until `chat:done`. User rows are keyed `message:${id}`.
- The live row is `SettledMessageRow live={...}`. While the streaming row is visible, the saved copy (`persistedHandoffMessageId`) is skipped. After the handoff, the same key renders the saved message, so nothing remounts: the paragraphs, the code block element, and the HTML and native visuals all survive. This supersedes the "iframe remounts once at handoff" note in `inline-generative-ui-phase-1.md`.
- The live row is keyed from the message just before the settling one (`persistedHandoffMessageId`), or the last message when nothing is settling, and is placed at the settling message's slot. A reply that settles behind a queued prompt keeps its place and its elements.
  - The key is remembered per base (`liveKeyRef`) and recorded for the saved id (`handedOffKeysRef`), so the saved row reuses it.
  - When a regenerate answers a prompt that already has a saved reply, the key gets a `~n` suffix, so the new answer mounts fresh with its disclosure sections closed.
- `MessageBubble` latches `revealed` once it has streamed and keeps `StreamingMarkdownReveal` with `complete` forced true.
- The reveal renders the revealed source prefix as one Markdown document through `MarkdownContent` with `streaming`, so streamed and settled output match `<Markdown>` from history exactly: reference links, footnotes, and loose lists resolve across blocks. react-markdown keys elements as `tag-ordinal`, which is stable while text only appends, so earlier blocks keep their elements.
  - `streamingRevealVisibleEnd` maps a unit count to a source offset (each unit carries `end`).
  - While streaming, `remarkOpenFence` marks a trailing unclosed fence with `data-open-fence`, and `CodeBlock` renders it `plain`. Once the fence closes, the same element turns highlighting on in place.
- The action row is laid out while streaming but kept `hidden` (aria-hidden). It is one slot at the end of the turn (`AssistantResponse` renders it after every row, media and visual), not under the newest paragraph, so a new paragraph never moves it. `MessageForkContextMenu` always wraps assistant rows, with a disabled trigger when there is no action.
- The no-steps layout of `AssistantResponse` mirrors the step layout's slots (`text-0`), so the first tool step does not remount the text.
- E2E specs wait for a settled reply with `getByRole("button", { name: "Fork from here" })`, because only the saved row can fork. Do not reintroduce `.streaming-reveal` count 0: the tree now persists.
- Accepted risk: the reasoning block key differs between the two layouts. A remount now only loses a reader-opened state and replays the 220ms entrance; it no longer reopens a preview.

## Block reveal (D4, `renderer/lib/streaming-reveal.ts`)

- **Release gate.** `advanceStreamingRevealGate` releases a prefix of the reply. The parser only ever sees that prefix, so the prefix-stable parser still decides what is safe to draw.
- **Strong boundaries** come from `lastStreamingRevealBoundary` (a full scan) or `scanStreamingRevealBoundary` (resumes from a saved scan):
  - a paragraph's closing blank line, except right after a heading, which waits for its first paragraph;
  - the start of the next list item, where its first word is enough;
  - the end of each table body row;
  - each finished line inside an open fence (the opener line alone waits);
  - the closing fence.
- **Timing.** A strong boundary releases at most once per 300ms. A tail with no boundary is released after 1000ms. A plain "300ms at paragraph boundaries" would hold a long open paragraph, a lone heading, or the last list item indefinitely.
- **Incremental scan.** The gate looks for a boundary only once a release is allowed (`now >= earliest`). It keeps the scan state (scanned prefix, boundary, fence, previous line, table state) in `gate.scan` and resumes from it, so each release reads only the lines that arrived since. A text that does not extend the scanned prefix starts over. `waitingSince` is when the oldest unreleased text arrived.
- **Full release.** The turn's end (`complete`, from `streamComplete`) releases everything at once, and only the turn's end hands off.
- **Reduced motion** (since 570082aae) skips block gating and the fade but keeps the cadence: all text that has arrived is released at most once per 300ms (`STREAMING_REVEAL_RELEASE_MS`), so the reply is not re-parsed on every token.
- **Tool-closed text** (`textClosed` on `MessageBubble`, the component's `closed` prop) stays gated: its end counts as a boundary and joins whole at the next release slot, without the 1000ms wait. It passes no `onHandoffComplete`.
- **Fade.** Opacity only, over 450ms, via a top-level `@starting-style` in `styles.css`. It is gated on `:root[data-reduce-motion="false"] .streaming-reveal[data-streaming]`. It applies to `.streaming-reveal[data-streaming] > *` and to `li` and `tr` inside it. `data-streaming` is removed 450ms after the text completes (`STREAMING_REVEAL_FADE_MS`). There is no translateY, and the old `aiden-streaming-*` keyframes are gone.
- `STREAMING_REVEAL_FALLBACK_MS` and `STREAMING_REVEAL_HANDOFF_MS` are kept. The per-unit schedule API (`revealDelayMs`, `advanceStreamingRevealSchedule`, and the rest) was removed.

## Tests

- Unit and DOM tests:
  - `renderer/lib/scroll-follow.test.ts`
  - `renderer/components/scroll-area-follow.test.tsx`
  - `renderer/components/message-list-settle.test.tsx` (in `test:rich-links`): history parity with a reference link, footnote and loose list; place and identity behind a queued prompt; regenerate disclosure reset; tool-closed release
  - the gate tests in `renderer/lib/streaming-reveal.test.ts`, including chunked incremental scans against the full-scan oracle
- Playwright: `tests/e2e/chat-follow-bottom.spec.ts`. It covers pinning across 50 chunks, no pull-back after a wheel-up, the jump landing at the true bottom, the opacity-only fade, and `data-streaming` clearing once settled. It uses the `enqueueStreamedReply` fixture.

## Known flake

`tests/e2e/chat-message-queue.spec.ts:698` once failed during the D3 Playwright run: the "Compacting chat…" status was not visible at `startCompaction`. It passed in the next full run of the spec on D4. Treat it as a possible flake to investigate, not something to retry away.
