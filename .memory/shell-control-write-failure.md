# Shell control-write failure — 2026-09-23

Independent branch `feature/shell-control-write-failure` from main c8c09e0d2. Preserves PR #228 compaction and PR #231 fixture heads; no C runner or protocol changes.

PR #230 CI job 107035434449 failed `workspace identity drift is rejected before shell execution` with uncaught write EPIPE. The native root validation returns 65 before parsing stdin on identity mismatch. The TypeScript wrapper listened only for child-process errors, so an early-closed stdin stream could emit an unhandled error even while the promise correctly rejected the unverified helper outcome. A deterministic fake Writable reproduced both the expected promise rejection and uncaught EPIPE. PR #231 only changes the detachment fixture and does not fix this transport path.

Register stdin error handling before the first write, record control failure, and close the control channel. Both asynchronous errors and synchronous write throws still await helper closure or the existing watchdog. A control failure rejects even on exit code zero. The existing finally block owns timer/abort-listener cleanup and destruction of stdin/stdout/stderr; the stdin error listener remains through destruction to catch late errors. Protocol validation and command/lifecycle assertions are unchanged.

Regressions cover async EPIPE, non-EPIPE EIO, synchronous throws, unsettled-before-close behavior, zero-exit rejection, and watchdog cleanup. The three initial regressions fail on baseline. The existing real native identity-drift, success, cancellation, signals, and cleanup cases remain. Both independent GPT-5.6 Sol medium reviews cleared the change. Full phase-5D, type-check, focused lint and final hosted validation are recorded in the PR.

This is host transport error handling, not a shared native client contract, UI change, new permission, or onboarding capability. No rollout status change.
