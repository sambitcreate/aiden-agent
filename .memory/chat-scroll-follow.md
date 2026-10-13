# Chat and task-list scroll follow (PR #250)

Chats and task lists open pinned to the latest content and keep following the
live edge only while the reader is there.

- Desktop `ScrollArea` (`renderer/components/ui.tsx`) drives one follow latch
  through `followReducer` in `renderer/lib/scroll-follow.ts` (events: `userIntent`
  for wheel-up/drag/key, `settle`, `contentResize`, `scrollbarHold`/`Release`,
  `jump`, `reset`). Only reader intent breaks follow; it re-arms within
  `FOLLOW_REARM_DISTANCE_PX` (40px) of the end. Content growth while following
  pins before paint (ResizeObserver, no subtree MutationObserver). A jump
  animates only when idle, not streaming and without Reduce Motion; `scrollend`
  (or a timeout) lands it. Momentum from before a jump is ignored
  (`followIgnoresWheel`), sideways pans and nested scrollers that consume the key
  leave follow alone, and Space on a focused control is a press, not a scroll.
- Android transcript (reverse layout): the latch ignores viewport samples while an
  insertion epoch is pending; the content effect is keyed by `listState` as well
  as item count so a chat switch with equal counts still consumes the epoch.
- Android task sheet (forward layout): "at end" is computed from live
  `listState.layoutInfo` (last visible row == last task and its bottom within
  80px of `viewportEndOffset - afterContentPadding`), never from a captured
  `tasks.size`. The repin key includes every rendered field (id, status,
  activeForm, subject, blockedBy) as a structured list, not a joined string, so
  free text with separators cannot collide; iOS `taskListFollowKey` returns the
  Equatable task array for the same reason.
