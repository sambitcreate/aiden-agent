# Managed worktree process cleanup

Started 2026-10-15, pending PR #500. Started from `origin/main` `11b58367`;
as of 2026-10-16, merged latest `origin/main` `6c2b44bb0` into the PR branch
without rebasing. The integrations include #498, #503, #506, #501, #504,
the 0.57.0 release merge, #508, #509, #510, #511, #512, #496, #505, #494,
and #499. The merged root
`package.json` test chain matches main. The #512 integration supplies Aiden
Remote revision 33 with synchronized iOS and fixture contracts; this PR
changes neither that revision nor its wire shape.

Explicit managed-worktree removal now awaits exit of Aiden-owned PTY sessions
after signalling them. The terminal service retains pending exits across retries;
a five-second timeout returns an actionable message and preserves the checkout.
`workspace-worktree-application-service` awaits this before dirty-state capture,
snapshot, or Git deletion. Generation, operation and schedule cancellation and
Git's ownership/identity/journal gates continue to apply.
The Remote Git adapter maps this retryable refusal to its existing
`git_capability_denied` response with the specific terminal message; iOS and
Android already surface Remote errors without a wire-shape change.
The standalone CLI has no owned PTYs; its shared-service adapter implements an
async no-op to satisfy the drain contract. Root typecheck does not compile this
package, so its separate build/typecheck is required.
Review found that synchronous renderer invalidation during terminal creation
could terminate the session before PTY exit observation was installed. Exit is
now observed before owner subscription and any post-spawn invalidation teardown.
A behavioral test covers rejection, pending exit, then successful drain.
The process boundary audits actual POSIX session membership with the packaged
native remover after shell exit. Job-control background groups can survive the
shell and lose their controlling PTY while retaining its session ID; they block
deletion until gone. Missing or invalid inventory fails closed. The Remote idempotency
ledger forgets this pre-Git refusal, allowing a same-key retry after the job
exits. The scoped unit test covers a surviving background member and replay.
On Linux, procfs may hide other users' PIDs with `hidepid`; the native audit
checks the proc mount policy and its PID-namespace view before and after
enumeration. Filtered or malformed inventory returns unavailable rather than
`empty`. The Linux fixture test and a private-mount-namespace probe cover this.
Parsing numeric PID directory names with the existing digit parser avoids
the `strtol` C23 symbol that raised the Linux package's glibc floor.
The worktree-remover prebuilts for macOS universal, Linux x64, and Linux arm64
were rebuilt from this native source, with matching binary and source hashes
in each checked-in manifest. The renderer-other CI lane checks these manifests;
updating only the source leaves that lane red even when native tests pass.
An invalid node-pty PID must never reach either the process-group signal or
node-pty's own `kill()` (which also signals its reported PID on Unix). Since
there is no session ID to audit, Aiden retains a hard removal hold for that
workspace for the service lifetime; blindly clearing it on retry would allow
deletion without a liveness proof. The error directs manual inspection.
The existing iOS and Android clients surface the Remote error message without
a protocol revision. Focused iOS simulator XCTest (12 tests) and Android JVM
tests (934 tests) passed on the prior head; the Linux-only inventory follow-up
did not change either client or the Remote contract.

The `b1e6054a` merge conflicted only on the three native manifest `builtAt`
fields. Their helper records combined automatically, preserving both this PR's
worktree remover and #501's file mutator binaries. Local validation on the
merge commit passed root typecheck, 36 native remover tests, 160 focused
desktop/Remote tests, 6 prebuilt manifest tests, terminal coverage, 99 CLI
tests, Android JVM tests, focused iOS simulator XCTest, and the sidebar E2E
case repaired by #506. The root tool-output chain passed 214 tests with CI's
Node 22.22.3; local Node 26 has different `fs.glob` symlink results. New
exact-head CI and review gates remain pending. PR #504 has merge priority, so
this branch may require one more `main` integration before eligibility.

The subsequent `ee218d1f` merge again conflicted only on the manifest
`builtAt` fields; retaining the newer timestamps preserved both the remover
and file mutator records. Local checks on the merge commit passed root
typecheck, 6 prebuilt manifest tests, 36 native remover tests, 160 focused
desktop/Remote tests, the native file mutator suite (31 passed, 3 platform
skips), terminal coverage, 218 tool-output tests under CI Node 22.22.3, and
99 CLI tests. The prior-head hosted CI run `38847791193` was green, but its
Hermes review failed twice in the engine before a verdict. Fresh exact-head
CI and a successful bot review are required after this merge.

The subsequent `515de6738` merge brought in release version and plan-index
changes without conflicts. The root `package.json` test chain still matches
main and the in-review lifecycle plan row remains present. The native helper
manifest test passed on this head. Root typecheck, 36 native remover tests,
160 focused desktop/Remote tests, the native file mutator suite (31 passed,
3 platform skips), terminal coverage, 218 tool-output tests under CI Node
22.22.3, and 99 CLI tests passed before the next push.

This is one bounded phase. No automatic retention sweep or new owner metadata is
enabled. Future eligibility must default old worktrees to manual, keep manual
worktrees out of sweeps, skip uncertain/dirty/unpushed/unknown-ignored/open-PR-
head-or-base candidates, report the reason, and revalidate before deletion.

The `e55d71a61` exact-head CI run `38854074444` was green across desktop,
mobile, E2E, CLI, and Linux packaging, with Pullfrog passing. Hermes did not
produce a verdict: service logs showed AGY quota exhaustion (429), with a
reported reset near 15:34 UTC on October 16. After main advanced to
`716636cf9`, that main was merged without conflicts. The #509 Remote Bot Files
authority fix and #508 E2E adjustment did not change this PR's process cleanup
path, package test chain, or Remote revision 32. Post-merge local root typecheck,
36 native remover tests, 6 manifest tests, 31 lifecycle tests, 99 CLI tests,
Android JVM gate and 109 focused iOS Remote client tests passed. A combined
desktop/Remote run hit an existing four-second Git timeout under concurrent
CLI build load; the isolated lifecycle suite passed. Fresh exact-head CI and
Hermes review remain required after this merge.

Main advanced again to `9deb63f52` (#510 Bot Web Search and #511 focus
modality); the merge had no conflicts. The package test chain matches main
and Remote revision remains 32. A combined local desktop/Remote run on the
earlier `716636cf9` integration passed 218 of 221 cases, but wall-clock
delays under extreme host load (load average above 250) expired a Bot Files
handle and a Remote Git snapshot and caused a first-message Git timeout.
The focused Bot Files case had passed in the first combined run; the isolated
lifecycle suite and CLI rerun also passed. Preserve these failures in the PR
record and use fresh exact-head hosted CI to judge the new head.
Root typecheck and 119 focused Bot access, Web Search, renderer, and input
modality tests passed after the `9deb63f52` merge.
The subsequent #512 merge had no conflicts. Root typecheck, 215 focused
Remote protocol/router/Bot-session/operation tests, and Android JVM tests
passed. Focused iOS Remote client, Bot session, and phase-0 simulator suites
returned exit 0 with 175 passing cases; Xcode then spent ten minutes trying
to collect simulator diagnostics and reported a diagnostic timeout. The
actual test gate passed, but hosted iOS CI remains the clean-run evidence.

The `60e30da04` exact-head CI run `38951048254` completed green across all
desktop, E2E, mobile, CLI, and Linux packaging jobs. Pullfrog passed, Hermes
reviewed that head with no findings, and no review threads remained open.
The coordinator then assigned #500 a delivery slot after #499 merged to
`6c2b44bb0`; that main merged without conflicts. The root test chain matches
main, the Remote contract remains revision 33 with no PR wire-shape change,
and all three native manifests contain both the remover and lease-flock
helpers with valid hashes. After refreshing root and CLI dependencies for
Pi 1.3.0, local root typecheck, full lint and build, 36 native remover tests,
6 native manifest tests, 160 focused desktop/Remote tests, 122 focused tests
for new main Bot lease, coding tools and device paths, 106 CLI tests, terminal
coverage, and 220 tool-output tests under CI Node 22.22.3 passed. Fresh
exact-head hosted CI, Pullfrog and Hermes are required on the post-merge head.
