# Managed worktree process cleanup

2026-10-15, pending PR #500. Started from `origin/main` `11b58367`;
merged latest `origin/main` `dd2c0d03` into the PR branch without rebasing.
The merged root `package.json` test chain matches main, and this PR changes no
Aiden Remote protocol revision or native-client fixture.

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

This is one bounded phase. No automatic retention sweep or new owner metadata is
enabled. Future eligibility must default old worktrees to manual, keep manual
worktrees out of sweeps, skip uncertain/dirty/unpushed/unknown-ignored/open-PR-
head-or-base candidates, report the reason, and revalidate before deletion.
