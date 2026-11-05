# Explicit state machines: Lane A

Lane A owns P0 and P1 (admission and generation settlement), then P5 (physical teardown). The plan is `docs/plans/explicit-state-machines-migration-plan-2026-11-04.md` on branch `feature/explicit-state-machines-plan`. Per-owner worksheets live in `docs/state-machines/`.

## Decisions

- Pure transitions live next to their owner, as `<owner>-lifecycle.ts`. The owner keeps timers, callbacks and counters, and executes the effects the reducer returns. There is no shared framework.
- Effects run in order, and budget effects come before `finalize`.
- `feature/subagent-desktop-serve-upgrade` has staged edits to `chat-turn-admission.ts` (`onIdle`, `cancellation`, a `leases` WeakMap, `signalFor`, a frozen lease). `finalize` and the lease literal stay in `tryBegin` so they can merge. Its `signalFor` must use `holdsChatTurnAuthority(record.lifecycle)`, its `onIdle` call stays at the end of `finalize`, and its abort goes at the top of `runReleaseCallbacks`.

## Local setup

A fresh worktree needs `npm ci`, then `npm run build:worktree-remover`, `build:worktree-file-io` and `build:subagent-file-mutator`, `build:vcc`, plus `build:lease-flock` for the CLI suite. Without them `first-message-worktree.test.ts` fails with "Branch already exists".

## Skipped CLI entries

Dropped in favor of `aiden serve`: `cli-native:C09`, `cli-native:C10`.

## Status

- P0/P1: done apart from review and CI. #735 admission, #736 generation settlement, #741 run input, #742 Pi run gate, #743 generation stream, #744 background launch, #745 side-question slot, plus the first-send PR. Dispositions are in `docs/state-machines/retained-p1-owners.md`.
- P5a: shared process settlement and subagent shell are in PRs. `docs/state-machines/physical-teardown.md` records the contract.
- P5b: Computer Use host in a PR. P5c: MCP stdio in a PR; Bot VM, ACP and subagent runtime kept as they are.
- P5d: update-install withdrawal in a PR. Everything else in P5 is listed under "Not done in this slice" in `docs/state-machines/physical-teardown.md`, with reasons.
- Blocked: the shutdown and restart trace across P1 to P4 needs Lanes B and C merged.

## Lane overlap

- Lane B's `feature/sm-p2-approvals` adds a recheck before `runShell` in `subagent-shell.ts`. The shell gate was edited so those 5 lines still merge: `return {` became `const gate = {` with no reindent.
- `feature/sm-p2-consent` and four `feature/sm-p4*` branches touch `main/services/computer-use` or `native`. Check which files before P5b.

## Test notes

- E2E: use `CUA_SPACE=aiden-e2e` and read the Playwright totals, not only the exit code. An earlier Space never became ready and a piped `tail` hid it.
- Conflict resolution on `retained-p1-owners.md`: the M106 row and the First send section share a hunk, so check both survive.

## Known failures

- `tests/e2e/follow-through-lifecycle.spec.ts:30` and `:64` fail in the Cua Space on the unmodified base `bc663001f` too, with the same lines and messages (`alive(pid)` true; `git:createWorktree` disk capacity). Not from this lane. Whether they pass elsewhere rests on macOS CI.
- `use-assistant-live.test.tsx`, "Live device preparation failure...", failed once on #743. Cause unknown, not fixed.
- `mcp-failure-diagnostics.test.ts` matched `8443` inside a random hash. Fixed in #768.

- Rust `guard::tests::authenticated_bridge_lease_eof_revokes_the_whole_broker_group` failed once locally at load about 10 ("broker survived authenticated bridge lease EOF", `guard.rs:490`, two-second deadline). No `native/` change in this lane. Not fixed.
- One JS failure in `npm run test:computer-use` on the #766 fix: 514 passed, 1 failed, log discarded, test unidentified. 11 later JS runs clean. The new lease-retry test is not ruled out. Recorded in #766.

## Handed to the owner

- `aiden serve stop` cannot force-stop an MCP survivor whose wrapper exited: `daemonMcpGroups()` in `packages/cli/src/serve-lifecycle.ts` needs a direct child of the daemon. Predates this lane, needs `packages/cli` work, and `feature/sm-serve-*` branches change that file.

## Unverified

- Stop during initialization, first delta and terminal save are covered by E2E only.
- Persist before release is covered only by a source-grep test.
- C11 overlap edge. `git-clone-runner.ts` waits for `finished()` but ignores `cleanup_unconfirmed`; it only removes a private staging folder.
- Process group ID reuse between check and signal is an existing race.
