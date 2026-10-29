# Live activity rows redraw only changed steps (2026-10-29)

Every live timeline update from the Mac carries the whole step list as fresh objects, so the open activity trail re-rendered every row on each update. `chat-pane.tsx` `onTimeline` now runs `replaceEqualDeep` (TanStack) against the previous timeline, keeping unchanged step objects, and `TickerRow`/`TrailRow` in `activity-feed.tsx` are `React.memo` by step. A throwaway benchmark (open trail, 200 steps, 200 updates, happy-dom) went from about 5.6 s to 1.8 s of render time.

- Only the local live run uses this path. Observed runs (another window) and peer-host streams build timelines elsewhere (`observed-local-run.ts`, `remote-stream-translator.ts`) and were not changed.
- Inspired by t3code #26739 (render only changed work log rows).
