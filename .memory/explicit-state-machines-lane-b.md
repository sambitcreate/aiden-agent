# Explicit state machines: Lane B

Lane B of the explicit state-machine migration: P0 baselines and P2 (authority, approvals, credential commits), then P6 (Bot schedules and recovery). Plan: `docs/plans/explicit-state-machines-migration-plan-2026-11-04.md` on `feature/explicit-state-machines-plan`. Per-owner worksheets and dispositions: `docs/audits/state-machine-worksheets-lane-b.md`.

## Facts worth keeping

- Subagent ledger `consume` is the real fence for child writes and shell. Brokers read authority before awaited checks, so any new revocation path must pair `revokeAuthority` with `approvals.cancelRun`.
- `tsx --test` of the write and shell suites needs `npm run build:subagent-file-mutator` and `npm run build:subagent-shell-runner` in a fresh worktree. Without them 7 tests fail and 3 are cancelled. That is not a code failure.
- Pre-existing local failures, identical on base `bc663001f`: `agent-compatibility.test.ts` "forked initial context respects zero recent model budget" (`compaction-failed`), and four `scripts/aiden-remote-lan-transport-spike.test.mjs` tests because OpenSSL 4.1 rejects `x509 -days 0`. Both stop their `&&` chains, so run the later stages of `test:subagents` and `test:aiden-remote` by hand.
- For #730 when M028 is reconciled: its publish callback sets `waiting` before `options.publish`, so a publish throw leaves the entry behind.

## Status (2026-11-04)

- P2 stack open: #737, #738, #739, #740. Later commits merge forward, never rebase.
- Same-id approval replacement was first recorded as unreachable. Pullfrog reproduced it and it was fixed, so a reachability argument alone does not close a finding on code this lane added.
- P3, P4 and P5 PRs opened on 2026-11-05 (#746 to #757, #766, #767, #769), so that dependency has cleared. Recheck overlap before each P6 owner, because file lists move.
- P6a reviewed and retained: `bot-pause-store`, `bot-pause-steps`, `bot-routine-recovery`.
- P6 still open: `bot-routine-events` (free of overlap, not reviewed), `scheduled-bot-routines` (#687, #734), `bot-session-service` (#729, #734), `bot-routine-notifications` (#709, #727, #728), `aiden-remote-streams` (#746). `schedule-service-core` and `schedule-store-core` claims are free of overlap but not reviewed. P6c and P6d not started.
- #756 edits `subagent-shell.ts`, as #737 does. The source merges cleanly and only `subagent-shell.test.ts` conflicts.
- `agent-compatibility.test.ts` fails on this Mac but passes in CI's `Desktop tests (runtime-subagents)`. Cause unknown.

## Skipped CLI entries

CLI work is dropped in favor of `aiden serve`: `cli-native:C11`, `C15`, `C21`, `C25`, `C30`, `C31` (P2) and every `cli-native:C*` row in P6.
