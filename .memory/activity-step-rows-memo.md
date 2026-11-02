# Live activity rows redraw only changed steps (2026-10-29)

Every live timeline update from the Mac carries the whole step list as fresh objects, so the open activity trail re-rendered every row on each update. `chat-pane.tsx` `onTimeline` now runs `replaceEqualDeep` (TanStack) against the previous timeline, keeping unchanged step objects, and `TickerRow`/`TrailRow` in `activity-feed.tsx` are `React.memo` by step. A throwaway benchmark (open trail, 200 steps, 200 updates, happy-dom) went from about 5.6 s to 1.8 s of render time.

- The same sharing runs on the detached path (leave a running chat and come back: `chat-terminal-sync.ts` `chat:timeline`) and on peer-host and observed runs (`remote-stream-translator.ts` `timeline`, fed by `observed-local-run.ts`). The final timeline in `onDone`/`onError` is assigned as is (one full redraw at the end).
- `chat-pane.tsx` publishes the environment panel's context details from a `timelineCompacting` boolean instead of depending on the whole timeline, which used to clear and re-set the panel's state on every timeline update. That churn sat in the stack of an intermittent React #185 (maximum update depth) seen in a 210-call e2e run.
- Inspired by t3code #26739 (render only changed work log rows).
