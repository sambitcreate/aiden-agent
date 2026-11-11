# Stopped, not failed (2026-11-11)

Branch `claude/stopped-not-failed`, workstream W5 of `docs/plans/upstream-week-2026-11-11-plan.md`
(from T3 Code #33291). Display-only: no wire, protocol revision or decoder change.

## Rule
A tool step is "stopped by you" when the timeline's `cancellationOrigin` is `user_stop`, the step's
status is `cancelled`, and the claim check does not name the step. Such a step:
- reads "<Step> stopped" in a neutral tone (desktop `text-secondary`; iOS `.normal` tone; Android
  `StepMark.STOPPED` with a `StopCircle` icon tinted `palette.secondary`);
- is not counted as an issue, so it does not force the desktop trail open, does not add "1 issue",
  and does not turn the phone header icon into a warning.

Everything else keeps the old treatment: cancels from `application_shutdown`, `chat_deletion`,
`scheduled_task_cancel` or no origin, every `failed` step, and a stopped step the claim check names
(its copy says "Review the issues above", so it must still read as an issue).

## Where
- Desktop: `isStoppedByUser`, `activityLine(step, { stoppedByUser })` and `activityIssueCount` in
  `renderer/lib/agent-steps.ts`; `renderer/components/activity-feed.tsx` passes `stopped` to every
  StepLine/TickerRow/TrailRow.
- iOS: `AidenGenerationTimeline.isStoppedByUser`, `userStoppedStepIDs`, `issueCount`, and
  `AidenAgentActivityPresentation.tone(for:stoppedByUser:)` / `line(for:stoppedByUser:)` in
  `Models/AidenChat.swift`; `AidenChatFeature.swift` threads `stoppedStepIDs` into the transcript.
- Android: the same names in `models/AidenChat.kt` (`userStoppedStepIds`, `stepMark`), used by
  `AidenTimelineCollapsibleCard`, `AidenToolStepsCard` and `AidenChronologicalTranscript`.

## Invariant
Do not change the step-status `isIssue` used by the decoders: the claim-check validators (iOS
`isRendererSafe`, Android's timeline validator) need cancelled steps to remain issue statuses.
The "stopped" carve-out lives only in the presentation helpers and the issue count.
