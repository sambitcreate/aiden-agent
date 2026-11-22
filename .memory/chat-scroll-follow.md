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
- Android hold-reader (`AidenTranscriptFollow.kt`): a detached reader inside the
  live item (index 0, offset > 0) is held still by growing the offset with the
  item. The correction runs in a `LayoutModifierNode` on the LazyColumn, right
  after the list measures, and calls `invalidateMeasurement()` from the
  placement block so the list re-measures in the same pass. A `snapshotFlow`
  collector (or a request made mid-measure, which is dropped) lands a frame late
  and draws the text one line off before snapping back.
  `AidenChatChromeUiTest` steps the clock frame by frame to guard this.
- Android task sheet (forward layout): "at end" is computed from live
  `listState.layoutInfo` (last visible row == last task and its bottom within
  80px of `viewportEndOffset - afterContentPadding`), never from a captured
  `tasks.size`. The repin key includes every rendered field (id, status,
  activeForm, subject, blockedBy) as a structured list, not a joined string, so
  free text with separators cannot collide; iOS `taskListFollowKey` returns the
  Equatable task array for the same reason.

## Busy turns: no height churn at step hand-offs (2026-11-22)
Measured with a throwaway Vite page that replayed a turn of thinking, prose and tool steps through the real `ScrollArea` + `MessageList`: follow stayed pinned, but the content height bounced about four times per step. Two causes, both fixed.
- The bottom status line (`AgentActivityTransition` in `renderer/components/message-list.tsx`) used to unmount whenever a reasoning or tool row owned the phase (`resolveVisibleAgentActivity` returns null) and remount in the gap before the next step, 44px each way. It now renders one fixed-height slot (`data-agent-activity-slot`) for as long as `streamingText` is non-null; only the line inside comes and goes. Do not make the slot conditional on the activity again.
- `onTimeline` applies at once in `chat-pane.tsx`, while text and reasoning deltas wait for the next animation frame. A thinking step settles with `reasoningEndOffset` at the full length (and a new one opens with `reasoningStartOffset` there) one frame before the renderer shows that reasoning, so `assistantPresentationRows` returned null and the whole live reply flipped to the activity-first layout and back, moving more the longer the reply was. Live callers now use `liveAssistantPresentationRows` (`renderer/lib/assistant-message-presentation.ts`), which pins content and reasoning offsets to what is shown. Stored replies still go through the strict `assistantPresentationRows`.
- Result in the replay (6 cycles): height shrinks 12 to 0, downward moves of earlier content 16 (883px) to 0. What remains is growth only: a ticker row is 24px, a revealed paragraph its own height.
- Tests: `renderer/lib/agent-steps.test.ts` ("a live reply keeps its chronological rows while streamed reasoning and text trail the timeline"), `renderer/components/message-list-settle.test.tsx` ("a running reply keeps one status slot as steps hand off").
