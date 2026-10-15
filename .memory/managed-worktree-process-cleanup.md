# Managed worktree process cleanup

2026-10-15, pending PR from `origin/main` `11b58367`.

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
The existing iOS and Android clients surface the Remote error message without
a protocol revision. Focused iOS simulator XCTest (12 tests) and Android JVM
tests (934 tests) passed for this PR head locally.

This is one bounded phase. No automatic retention sweep or new owner metadata is
enabled. Future eligibility must default old worktrees to manual, keep manual
worktrees out of sweeps, skip uncertain/dirty/unpushed/unknown-ignored/open-PR-
head-or-base candidates, report the reason, and revalidate before deletion.
