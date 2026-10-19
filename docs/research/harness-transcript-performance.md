# Harness transcript performance

H4 acceptance is measured separately from correctness, live task quality and signed release acceptance.

## Baseline and declared implementation budgets

The initial local production package (ad-hoc signed, optional native application helpers absent) opened 50-message chats in 191/132 ms, 500-message chats in 343/433 ms, and 2,000-message chats in 1,306/1,313 ms (first/repeated open in one process). All rows remained mounted. Measurements ran on macOS arm64 under concurrent development load; these are preliminary observations, not release or battery claims.

Before production renderer changes, the acceptance targets are: at least 15% lower median 2,000-message open time across three repeated runs; 50-message median regression no greater than 20% or 25 ms, whichever is larger; synthetic streaming input under 100 ms; no loss of text find/copy, keyboard access, artifact access, bottom anchoring or live-to-saved continuity. Heap and idle wakeups are reported, not assigned improvement claims. Keep the existing initial-JavaScript budget.

The candidate uses Chromium layout/paint containment on older settled text rows, retaining the most recent 32 rows normally. Rows with HTML/native visuals, attachments or app panels are exempt because paint containment would clip wide surfaces and constrain interactive content. It retains the full DOM and React tree; this does not bound mounted rows or promise lower retained memory. A 200px intrinsic block estimate is replaced by the browser's measured size after rendering. No transcript transport or native-client contract changes are involved.

`scripts/harness-transcript-performance.mjs` launches an isolated disposable profile against a supplied macOS production `.app`. It seeds 50/500/2,000-message conversations with tool activity and text attachments, records package hash/build identity, DOM rows, heap, idle/event-loop/process I/O counters, and synthetic localhost streaming. It never uses a user's provider or profile. `--containment-candidate` injects exploratory CSS into the baseline package for comparison; final acceptance must use the actual rebuilt renderer without injection.

“Cold” here means first chat open in one process, not a cold disk cache. Synthetic streaming measures responsiveness, not model performance. Local receipts belong outside the repository until reviewed and normalized. Signed release and physical acceptance remain separate.

## Local acceptance result

The [normalized receipts](experiments/harness-transcript-performance-2026-10-19.json) identify both actual packages by app.asar SHA-256. Three paired runs, pooling first/repeated opens per size:

| Messages | Baseline median | Candidate median | Change |
| --- | --- | --- | --- |
| 50 | 139 ms | 142 ms | +2.1% |
| 500 | 368 ms | 340 ms | −7.6% |
| 2,000 | 1,282 ms | 1,047 ms | −18.3% |

All declared opening budgets passed. Three additional/updated streaming samples measured input at 42/49/47 ms while 1/2/2 synthetic SSE chunks were emitted during input, below 100 ms. The stream keeps emitting during input and holds only its final stop until measurement completes. First visible delta was 2.3–2.4 s; this includes host context preparation and reveal behavior, not model latency. These results do not establish better model performance.

Electron behavior checks passed: 50-delta follow/reader-scroll/jump/live-to-saved handoff; varied-height 100-row history with reduced motion, find selection, keyboard Tab/Shift+Tab, copy and return to bottom; persisted wide HTML and native UI visuals behind 64 later rows, including an outside-column hit-test and native interaction. Browser `window.find` automatically scrolling the selected match is not an acceptance claim: it did not reliably scroll in the baseline control with containment disabled either. Selection and keyboard reveal remain functional. 43 focused renderer tests and the existing initial-JavaScript budget passed.

Fresh medium review caught the wide-artifact clipping bug; exempting interactive/artifact rows and the real browser regression addressed it. The review also required continuous SSE emission during typing, now captured in the receipt. No shared transcript/transport contract changed; native consumers retain their existing projections. Signed release, physical-device and broader battery acceptance remain pending.
