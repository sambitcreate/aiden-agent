# Optimization pass, 2026-10

The audit is `docs/performance/optimization-audit-2026-10-03.md`. §13 maps each finding ID to a branch, a head commit, and a status.
- 15 fix branches plus updates to the Pi 1.0 PR stack (#299–#307).
- At the time the branches had no PRs; several have since merged (e.g. #329, #330, #332 in 0.53.0). Check §13 of the audit for each branch's current state.
- Each branch carries its own `.memory/<topic>.md` with per-finding rationale.

Open owner decisions:
- UI-54: a per-chat model. Done 2026-10-27 (owner reported the leak as a bug); see mobile-model-preference-remediation.md.
- UI-26: onboarding provider skip.
- UI-68: a microphone-settings IPC.
- UI-49: approval shortcuts.
- UI-55/59: settings grouping and renames.
- UI-61: whether Enter submits dialogs by default.
- UI-66: an "Open with default app" IPC.
- Split #302 into three?
- The PR #310 follow-up branch needs a new PR.

Follow-ups not started:
- Storage: MAIN-13/14/15/19/27/29.
- Native clients sending ETag and an `after` cursor (server support is on `perf/remote-server`).
- MAIN-33.
- Knip in CI.
- Typed workspace-file error codes over IPC.
- The baseline test failures on main listed in §13.
