# Live subagent context window

Status: desktop implementation in PR #271; CI confirmation pending.

After a child provider response, `SubagentEventProjector.usage()` publishes the latest reported token total and model context window through the `chat:subagent-context` notification. Unknown windows, empty usage and finished runs do not publish. Observer failures cannot fail the run.

This is an ephemeral desktop side channel. It adds no durable snapshot fields, revisions or run-store writes. The renderer retains at most 32 chats × 64 runs, and displays readings only for active runs. Roster percentages and the detail token count use existing context formatting and warn at 80% of the full model window.

Coverage lives in the projector, context-usage-store and subagents-panel suites. The new store test is registered in the package scripts and CI registry. Recovery review found this memory note missing from the original commit and added it to match the plan and PR description; no implementation changed in that follow-up.

Follow-ups recorded in `docs/plans/completed/subagent-live-context-window-plan.md`: Remote/iOS/Android need a separate live event and contract revision; message-list chips do not yet show the reading; percentages use the full context window rather than the usable input budget; notifications emitted before the first panel mounts are not replayed.

Status (2026-10-01): merged in PR #271 and shipped in 0.51.0; plan moved to `docs/plans/completed/`.
