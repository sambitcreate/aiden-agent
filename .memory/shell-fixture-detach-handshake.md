# Shell fixture detachment handshake — 2026-09-22

Separate branch `feature/shell-fixture-detach-handshake` from main c8c09e0d2. PR #228 compaction head c1f48d9e is unchanged.

CI run 35772284262 failed the pre-existing setsid double-fork fixture because its PID marker did not appear. Native builds and the other seven shell tests passed. These source files were unchanged from main. An exact local baseline suite passed 8/8; injecting a one-second scheduling delay before setsid reproduced the same missing-marker assertion after 31 seconds. This demonstrates a race, not the exact scheduling cause of the hosted failure.

The fixture previously let its first parent exit before the first child detached. The production runner correctly cleans the original process group after that exit, potentially killing the child before setsid. The fixture now uses a pipe acknowledgment after detachment, second fork, and successful marker publication. Its first parent waits at most 1500ms, below the existing 2000ms command timeout. Failure terminates the owned child/group and returns a nonzero result; no production runner behavior or timeouts change. The detached child's 120-second alarm and test cleanup/liveness checks remain.

The existing registered shell test file covers immediate detachment, controlled one-second delay, and a three-second stall that must fail via the handshake timeout before the command deadline. No UI, onboarding, shared client contract, or rollout status changes.

Validation: original 8 shell tests plus the two boundary scenarios pass (10/10). Controlled delayed baseline is red and the handshake implementation is green. Type-check and focused lint pass; both independent Sol medium reviewers cleared the patch after adding EINTR retry against one absolute monotonic deadline. The full phase-5D suite passes 10 shell plus 25 signing/package tests. A retry of #228 CI, if successful, is separate evidence and does not itself establish a permanent fixture correction.

## Review follow-up: missing-group-signal race

Pullfrog comment 4078785305 found that group-kill-before-direct-kill can miss a child entering setsid and forking between operations. Swapping signal order alone is insufficient proof. The parent now exclusively owns a second pipe writer and grants persistence only after readiness. The detached child exits on EOF unless granted success, so timeout or parent death remains safe even if signals miss the transition. The grandchild still has its 120-second alarm.

A stalled-publication mode writes a separate test witness before the formal readiness marker. Its test observes the detached PID disappear and has fallback cleanup even with no readiness marker. Once ESRCH is observed, cleanup is marked complete to avoid signaling a recycled PID. A controlled build omitting group signaling fails this test without the grant read and passes with the grant read; temporary binaries were restored. Full phase-5D validation now passes 11 shell + 25 package/signing tests. Both independent Sol medium reviewers cleared the correction, including the cleanup flag; final type-check, focused lint, and diff checks pass.
