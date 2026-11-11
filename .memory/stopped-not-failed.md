# Stopped, not failed (2026-11-11)

Branch `claude/stopped-not-failed` (PR #797), workstream W5 of
`docs/plans/upstream-week-2026-11-11-plan.md` (from T3 Code #33291).

## Rule
A tool step is "stopped by you" when its status is `cancelled`, it carries `stoppedByUser: true`,
and the claim check does not name it. The timeline's `cancellationOrigin` is not consulted: the
first version used `cancellationOrigin == user_stop` for the whole timeline, and Pullfrog showed it
hid an ACP agent permission cancelled on detach earlier in a run the person later stopped. Such a step:
- reads "<Step> stopped" in a neutral tone (desktop `text-secondary`; iOS `.normal` tone; Android
  `StepMark.STOPPED` with a `StopCircle` icon tinted `palette.secondary`);
- is not counted as an issue, so it does not force the desktop trail open, does not add "1 issue",
  and does not turn the phone header icon into a warning.

Every unmarked cancelled step, every `failed` step, and a marked step the claim check names keep
the issue treatment.

## Producer (who sets the mark)
`GenerationTimelineProjector` in `main/services/generation-timeline.ts`:
- `toolFinished(id, status, details?, { stoppedByUser })` and `compactionFinished(..., options)`
  mark a step only when it ends `cancelled` with the option set. llm-client passes it from
  `generationStoppedByUser()` (cancel requested and origin `user_stop`) at the tool end and the
  compaction abort.
- `finish("cancelled", "user_stop")` marks the steps its sweep closes.
- ACP's `GenerationTimelinePort.toolFinished` is 3-arg, so an ACP permission cancel never marks.
The shared parser (`renderer/shared/generation-timeline.ts`) accepts the key only as `true` on a
cancelled step of timeline version 3, so it survives chat reload and the Remote projection.

## Protocol
Remote revision 61 (`AIDEN_REMOTE_STOPPED_BY_USER_CONTRACT_REVISION`, provisional, claimed when main
was at 60; re-claim at merge if main moves). OpenAPI `GenerationToolStep.stoppedByUser` (const true,
cancelled only); fixture section `stoppedSteps` checked by `parseAidenRemoteContractFixture`.
iOS decodes the key only as `true` on a cancelled tool step; Android uses `AidenTolerantTrueSerializer`.

## Where
- Desktop: `isStoppedByUser`, `activityLine(step, { stoppedByUser })` and `activityIssueCount` in
  `renderer/lib/agent-steps.ts`; `renderer/components/activity-feed.tsx` passes `stopped` to every
  StepLine/TickerRow/TrailRow.
- iOS: `AidenAgentStep.stoppedByUser`, `AidenGenerationTimeline.isStoppedByUser`,
  `userStoppedStepIDs`, `issueCount`, and `AidenAgentActivityPresentation.tone/line(for:stoppedByUser:)`
  in `Models/AidenChat.swift`; `AidenChatFeature.swift` threads `stoppedStepIDs` into the transcript.
- Android: the same names in `models/AidenChat.kt` (`userStoppedStepIds`, `stepMark`), used by
  `AidenTimelineCollapsibleCard`, `AidenToolStepsCard` and `AidenChronologicalTranscript`.

## Invariant
Do not change the step-status `isIssue` used by the decoders: the claim-check validators (iOS
`isRendererSafe`, Android's timeline validator) need cancelled steps to remain issue statuses.
The "stopped" carve-out lives only in the presentation helpers and the issue count.
