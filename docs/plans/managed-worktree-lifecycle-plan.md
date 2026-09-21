# Managed Worktree Lifecycle

Tracking issue: #118.

Goal: add a safe product lifecycle around Aiden's existing managed-worktree core
without replacing its ownership, admission, quarantine deletion, or
crash-recovery machinery.

## Status

P0 (phases 1–9) implemented in PR #185; merge and release acceptance remain open:

- Managed `worktree add` runs with hooks disabled via a per-command
  `core.hooksPath=/dev/null` config override; no persistent repo config changes.
- `ManagedWorktreeSnapshot` records persist under
  `userData/worktree-snapshots/<id>/` (`manifest.json` + `files/` blob store,
  restrictive permissions).
- Git snapshots land as synthetic commits at `refs/aiden/snapshots/<id>`,
  parented on the worktree HEAD but never placed on a user branch. The capture
  index is isolated; it includes staged/unstaged/deleted/non-ignored-untracked
  state and the current commit ancestry.
- Ignored files provisioned by Aiden (recorded in
  `managedWorktree.provisionedFiles`) are captured as content-addressed sha256
  blobs outside Git and restored byte-exact from the snapshot — never re-read
  from the source checkout.
- Deletion classification: dirty content requires a durable snapshot before
  quarantine; unknown ignored files block safe removal; `force` bypasses only
  the recoverability requirement (ownership/identity/journal checks stay
  authoritative, and force still snapshots best-effort). A safe deletion
  re-verifies the captured tree at the authorization boundary — content changed
  after the snapshot ends in `needs_review`, never silently discarded.
- The removal journal is now `version: 4`, recording `deletionMode`,
  `snapshotId`/`snapshotRef`/`snapshotTree`, and `provisionedIgnored` before any
  quarantine rename; version-3 journals remain fully recoverable.
- `git:restoreManagedWorktree` recreates the managed checkout at the recorded
  base commit (attaching the branch only when it still points there), applies
  the snapshot delta as unstaged/untracked dirt (`read-tree --reset -u` +
  `read-tree <head>`), and writes back provisioned blobs. A per-snapshot
  restore journal makes crash-retries converge; restore fails closed on branch
  conflicts, existing destinations, repo-identity changes, and missing/corrupt
  snapshot data.
- Free-space admission: `checkCreateCapacity` (strict reserve) before
  `mkdir`+`worktree add`, `checkSnapshotCapacity` (small reserve) before blob
  capture — a nearly-full disk can never block the snapshot that deletion needs.
  Failures carry typed `insufficient_disk_space` errors.
- `.worktreeinclude` at the repository root copies only files Git reports as
  ignored AND untracked, with symlink refusal, escape/overwrite rejection, mode
  preservation, and count/byte limits; copied paths are recorded into
  `provisionedFiles` as the authoritative snapshot/restore set.

Remaining phases (setup script, owner kinds, idle GC, snapshot-retention GC,
UI, `aiden/<name>` branches, base-ref picker, CoW) are intentionally out of the
P0 slice.
