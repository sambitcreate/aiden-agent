# Audit fixes: terminal, shell commands, Git and schedule scripts (2026-10)

Branch `claude/audit-fix-shell-git` (from main `a0f1dd747`), fixing audit report 06 (terminal/git). PR not opened by the fixing agent.

## Fixed
- F3 (security): `schedule-script.ts` ran scripts with Aiden's full `process.env` (AIDEN_* secrets). It now uses `agentShellCommandEnvironment()` like `run_command`, runs detached and stops its group on timeout.
- F1/F2: shared `main/shared/process-group.ts` (see `code-health-helpers.md`). run_command no longer hangs on background jobs holding stdout; Git, clone and the scheduled script keep escalating to SIGKILL after the leader closes until the group is gone.
- F12: `github-pull-request.ts` spawns `gh` detached and stops its group on timeout/abort; error shapes (`killed`, `AbortError`, maxBuffer code, `Command failed` + stderr) match the old `execFile` ones.
- F4: `write_file` streams the preimage (hash + line count, text kept only up to 16 MiB), refuses existing files over 256 MiB with a clear message (the native mutator's own cap, which it reported as "conflict"); `edit_file` refuses files over 64 MiB before reading.
- F5: terminal close sends SIGHUP, then SIGKILL to the shell's group after 2 s if the PTY has not exited.
- F6: a workspace's remembered PTY session ID is dropped on exit only after `audit-session` confirms the session is empty (deviation: the audit suggested dropping it on every exit, which would hide surviving jobs from the removal audit).
- F7: Git metadata watchers close when a workspace or worktree is removed (quit-time dispose not wired; `main/index.ts` was out of scope).
- F8: a cancelled stable Git read stops waiting behind a mutation.
- F9: Git resolution on Linux uses absolute PATH entries.
- F10 (reduced): the Ghostty snapshot was already incremental; only the accessible-text rebuild was skipped when no row changed.
- F11: capped Git output drops a cut trailing UTF-8 character instead of U+FFFD.

## Owner decisions
- Drain-then-stop policy (1 s) for run_command and schedule scripts.
- New 64 MiB `edit_file` cap.
- F5 reaches only the shell's own process group; job-control jobs in other groups rely on the removal audit.
