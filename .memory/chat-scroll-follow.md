# Chat and task-list scroll follow (PR #250)

Chats and task lists open pinned to the latest content and keep following the
live edge only while the reader is there.

- Desktop `ScrollArea` (`renderer/components/ui.tsx`) keeps an `atBottomRef`
  follow latch fed by `renderer/lib/scroll-follow.ts`. A smooth jump-to-bottom
  sets a pending programmatic latch so intermediate animation samples stay
  latched. The latch is released (`resolveProgrammaticFollowLatch(..., terminated)`)
  on `scrollend`, wheel, touchstart, a pointerdown on the viewport box itself
  (scrollbar), or a scrolling key outside editable targets, so an aborted jump
  never yanks an away reader back on the next resize.
- Android transcript (reverse layout): the latch ignores viewport samples while an
  insertion epoch is pending; the content effect is keyed by `listState` as well
  as item count so a chat switch with equal counts still consumes the epoch.
- Android task sheet (forward layout): "at end" is computed from live
  `listState.layoutInfo` (last visible row == last task and its bottom within
  80px of `viewportEndOffset - afterContentPadding`), never from a captured
  `tasks.size`. The repin key includes every rendered field (id, status,
  activeForm, subject, blockedBy); iOS `taskListFollowKey` matches.
