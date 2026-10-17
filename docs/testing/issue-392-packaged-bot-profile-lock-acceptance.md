# #392 packaged Bot profile lock acceptance — 2026-10-16

## Scope and source identity

- Tested the isolated macOS arm64 development package built from PR #499 head `8586738e4c1e2e525b7a182610c8252bf836b620`. Its Git tree `aa239c39ecc60a2b338b0d1b026c33efd9eba781` equals merged main `6c2b44bb00f37dc14b18b4a373d7b137a01e3944` (verified with `git show -s --format='%H %P %T'` on each commit and an empty `git diff --stat 8586738e origin/main`).
- The package was built inside the managed worktree at `release/development/mac-arm64/Aiden Agent.app`. Every launch used a fresh `--user-data-dir` under a generated `aiden-392-*` temporary directory. The installed Aiden app and user profiles were not used.

## Commands and results

From `/Users/sambitbiswas/.codex/worktrees/lease-reclaim-fencing/aiden-macos`:

```sh
PATH=/Users/sambitbiswas/.nvm/versions/node/v22.22.3/bin:$PATH npm run package
PATH=/Users/sambitbiswas/.nvm/versions/node/v22.22.3/bin:$PATH npm run package:verify
codesign --verify --deep --strict 'release/development/mac-arm64/Aiden Agent.app'
codesign --verify --strict 'release/development/mac-arm64/Aiden Agent.app/Contents/Helpers/aiden-lease-flock'
```

All four commands passed. Packaging printed `Verified hardened macOS package`. The packaged helper is present and signed; its signed-file SHA-256 is `a0da4f6e25b86215bdc4f365b2d0ea1bf940339eb513886625f87f56134623c1`. Signing changes the Mach-O bytes, so this differs from the unsigned build helper hash. The development package was **not notarized**.

The two inline Python acceptance harnesses spawned the packaged executable directly as follows, with separate generated temporary profile paths:

```text
<worktree>/release/development/mac-arm64/Aiden Agent.app/Contents/MacOS/Aiden Agent --user-data-dir=<temporary>/user-data
/Users/sambitbiswas/.nvm/versions/node/v22.22.3/bin/node --no-warnings --import tsx <worktree>/main/services/bot-runtime/test-support/kill-harness.mjs host <temporary>/user-data
/Users/sambitbiswas/.nvm/versions/node/v22.22.3/bin/node --no-warnings --import tsx <worktree>/main/services/bot-runtime/test-support/kill-harness.mjs lock-gated <temporary>/user-data/bots <temporary>/go
```

The harness used `subprocess.Popen` and checked each child process's marker line, PID, exit, and real `runtime.lock` bytes; it did not mock lock results or filesystem calls. The `lock-gated` command was launched three times and all three reported `READY` before the `go` file was written. All launched processes were killed and reaped in `finally`. A process-table check found no remaining process using either temporary profile or packaged executable.

### Packaged owner, contention, and crash

1. The packaged app started with a temporary profile and wrote `<profile>/bots/runtime.lock` with `protocol: flock-v1` and `pid` equal to its actual main-process PID. The permanent `runtime.lease.lock` guard existed.
2. An independent Node 22 Bot host using the merged source returned `HOST {"unavailable":"held_by_live_process"}`. The diagnostic record's SHA-256 was unchanged after this losing acquisition.
3. The packaged app was sent `SIGKILL` and exited with signal 9. Three ready claimants were released together against the stale record. Exactly one returned `LOCK {"ok":true}`; two returned `LOCK {"ok":false,"reason":"held_by_live_process","pid":0}`. A fourth Bot host was refused while the winner lived. After that winner was killed, a new Bot host returned `HOST {"ok":true}`.

Result: **PASS**. The packaged app held the real guard for its process lifetime; a losing host did not displace it; process death released exclusion; stale diagnostic metadata did not prevent one successor.

### Source owner, packaged contender, and recovery

1. A Node 22 Bot host acquired a second fresh temporary profile and wrote `runtime.lock` with its own PID.
2. The packaged app launched with that same `--user-data-dir` and stayed alive. The source host remained alive and the owner record's SHA-256 and PID stayed unchanged after six seconds of packaged startup. This confirms the packaged contender did not displace the owner. Aiden intentionally represents an unavailable Bot host without terminating the app.
3. After both processes exited, the packaged app was launched again on the same temporary profile. It acquired the guard and wrote `protocol: flock-v1` with its new main-process PID.

Result: **PASS**.

## Limits and follow-up

- This is a signed **development directory package**, not a notarized release installer or an installed production update. It uses the real packaged Electron main process and packaged `aiden-lease-flock` helper. The competing hosts use the repository's Node 22 Bot runtime harness at the identical merged Git tree, since Aiden disables Electron `RunAsNode` and a second packaged instance is subject to Electron's single-instance behavior.
- The test proves local macOS packaged Bot lock contention and crash recovery. It does not prove Linux packaged execution, a mixed-version upgrade, network filesystem locking, or physical-device behavior. #392's stated acceptance is among cooperating upgraded hosts; the documented upgrade boundary still requires stopping old Bot hosts before upgrading a shared profile.
- No product code, tests, timeouts, or CI policy were changed for this acceptance run. The two isolated profile/log directories (`aiden-392-packaged-woikus_s` and `aiden-392-reverse-i0lqk8ys`) were removed after verifying no related processes remained. The generated development package remains in the worktree's ignored `release/development/` output for inspection.
