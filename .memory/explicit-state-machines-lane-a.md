# Explicit state machines: Lane A

Lane A owns P0 and P1 (admission and generation settlement), then P5 (physical teardown). The plan is `docs/plans/explicit-state-machines-migration-plan-2026-11-04.md` on branch `feature/explicit-state-machines-plan`. Per-owner worksheets live in `docs/state-machines/`.

## Decisions

- Pure transitions live next to their owner, as `<owner>-lifecycle.ts`. The owner keeps timers, callbacks and counters, and executes the effects the reducer returns. There is no shared framework.
- Effects run in order, and budget effects come before `finalize`.
- `feature/subagent-desktop-serve-upgrade` has staged edits to `chat-turn-admission.ts` (`onIdle`, `cancellation`, a `leases` WeakMap, `signalFor`, a frozen lease). `finalize` and the lease literal stay in `tryBegin` so they can merge. Its `signalFor` must use `holdsChatTurnAuthority(record.lifecycle)`, its `onIdle` call stays at the end of `finalize`, and its abort goes at the top of `runReleaseCallbacks`.

## Local setup

A fresh worktree needs `npm ci`, then `npm run build:worktree-remover`, `build:worktree-file-io` and `build:subagent-file-mutator`, plus `build:lease-flock` for the CLI suite. Without them `first-message-worktree.test.ts` fails with "Branch already exists".

## Skipped CLI entries

Dropped in favor of `aiden serve`: `cli-native:C09`, `cli-native:C10`.

## Status

- P1a: `ChatTurnAdmission` extracted on `feature/sm-p1-admission`.
