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

- The whole stack (#736 to #769) is folded into #735, which lands it on `main` once CI is green on its final head.
- P0/P1: #735 admission, #736 generation settlement, #741 run input, #742 Pi run gate, #743 generation stream, #744 background launch, #745 side-question slot, #755 first send. Dispositions are in `docs/state-machines/retained-p1-owners.md`.
- P5a: shared process settlement (#757) and subagent shell (#756). `docs/state-machines/physical-teardown.md` records the contract.
- P5b: Computer Use host (#766). P5c: MCP stdio (#767); Bot VM, ACP and subagent runtime kept as they are.
- P5d: update-install withdrawal (#769). Everything else in P5 is listed under "Not done in this slice" in `docs/state-machines/physical-teardown.md`, with reasons.
- Landing review found one bug, fixed in #744: a run accepted after an invalidation's `store.list()` scan stayed queued until the next startup. `install()` now rechecks `invalidated` after its status read.
- Pullfrog found the sibling on #744: a run that reached `running` after that scan was aborted in memory only, and `execute` skips persistence after an abort, so it stayed `running` on disk. The four invalidators now go through `invalidate()`, which scans again after aborting. Fixed on the #735 head because #744 was already folded.
- Pullfrog then found that the second scan only moved that race: a launch accepted behind the last snapshot stayed live. `invalidate()` now holds a fence across both scans and `launch()` refuses anything a running invalidation covers, so no run is written. Launches already registered still go through `abortMatching` and the second scan.
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
- One JS failure in `npm run test:computer-use` on the #766 fix: 514 passed, 1 failed, log discarded, test unidentified. 12 later JS runs clean. The new lease-retry test is not ruled out. Recorded in #766.

- `tests/e2e/bot-browser.spec.ts:22` flaked once on #742 (line 143 expected `text`, got `password`) and `tests/e2e/chat-top-bar.spec.ts:104` once on #756 ("Resulting promise was garbage collected" at line 117). Both passed on retry and on the one whole-run rerun. Causes unknown, not fixed. Recorded in those PRs.
- Electron E2E (3/3) hit the 20-minute job limit once on #755 at test 85 of 92, no test over 34s, so a slow runner. Normal time is 12 to 16 minutes, so the limit has little room. Recorded in #755.

- `bot-browser.spec.ts:22` flaked again on #745, at line 109: the masking check found `737` in a snapshot. Probably a chance match in a substring search, as in `69728320a`, but the run kept no snapshot, so a real leak is not ruled out. Needs the Bot browser owner.
- `renderer/lib/use-voice-recorder.test.tsx` failed once on #736 at line 117: `recording` read right after waiting only for the transcript. Looks like a test race, unconfirmed, not fixed.
- `chat-top-bar.spec.ts:563` flaked on #769: `notes.txt` was ENOENT while polling after Save, and the retry passed. Cause unknown. Worth checking whether a save can leave the file briefly missing.
- `tests/e2e/interrupted-question-resume.spec.ts:8` flaked on #745 ("Resulting promise was garbage collected" at `fixtures.ts:676`, passed on retry). Same Playwright error as `chat-top-bar.spec.ts:104` on #756. Cause unknown, not fixed.
- `guest-driver-install.test.ts:330`, "suspending removes the enabled file...", failed twice locally (20s, `null !== 0`) in `test:bot-computers` on the merged stack. This lane does not touch that file. Not checked against `main` locally.
- A test that fails with an edited file open also reports "Electron shutdown timed out after 35000 ms". Reproduced with a throwaway spec on both `b96154694` and the unmodified base `bc663001f`, so not from this lane.

## Handed to the owner

- `aiden serve stop` cannot force-stop an MCP survivor whose wrapper exited: `daemonMcpGroups()` in `packages/cli/src/serve-lifecycle.ts` needs a direct child of the daemon. Predates this lane, needs `packages/cli` work, and `feature/sm-serve-*` branches change that file.

## Unverified

- Stop during initialization, first delta and terminal save are covered by E2E only.
- Persist before release is covered only by a source-grep test.
- C11 overlap edge. `git-clone-runner.ts` waits for `finished()` but ignores `cleanup_unconfirmed`; it only removes a private staging folder.
- Process group ID reuse between check and signal is an existing race.
