# Subagent turn-limit partial notes — 2026-09-21 (reconciled 2026-09-26)

Production 0.42.0 recorded a scout stopping at the deliberate 24-turn ceiling after 45 tool calls; the result was failed with only the limit warning. The per-run store remains private and its identifiers/contents are not copied into this note.

PR #206 originally added a runner-side "last four completed notes" tail for turn-limit failures. PR #207 (issue 202, see `issue-202-subagent-turn-budget.md`) landed first with a stronger runner design: all settled, non-aborted assistant text within the output budget is credential-sanitized and returned for any turn-limit stop, regardless of capabilities, then head/tail-projected to 8,000 characters with `summaryTruncated`. On reconciliation, #206 dropped its runner change and eviction tests in favor of #207.

The remaining #206 change is display provenance: `SubagentEventProjector.finish` used to add the `report_truncated` notice only when `status === "completed"`, which predates failed results carrying summaries. A failed turn-limit partial that was shortened therefore lost its notice. The projector now honors `summaryTruncated` for any status. Tests: projector regression for a failed truncated result, a runner test that oversized turn-limit findings stay failed with `summaryTruncated`, and an assertion that output-limit failures expose no summary.

No wire schema, run authority, turn budget, or native projection change. iOS and Android remote clients exclude private subagent run details.
