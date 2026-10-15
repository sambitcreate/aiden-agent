# Managed Worktree Lifecycle

Tracking issue: #118.

Goal: add a safe product lifecycle around Aiden's existing managed-worktree core
without replacing its ownership, admission, quarantine deletion, or
crash-recovery machinery.

## Status

P0 (phases 1–9) merged in PR #185. Release acceptance and the explicit product gaps below remain open. See the [September 22 stack disposition](managed-worktree-stack-disposition.md) for #189–193 and corrective admission work:

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

## Process-before-files deletion phase (PR pending)

Explicit managed-worktree removal now requests shutdown of Aiden-owned terminal
sessions and waits for their PTY exit events before inspecting or deleting the
checkout. A terminal that does not exit within five seconds blocks removal with
an actionable retry message. Its pending exit remains tracked across attempts;
an immediate retry cannot bypass the wait. The existing cancellation of workspace
operations, generations, and schedules and the Git ownership/quarantine checks
remain in place. Remote callers receive the same reason via the existing
`git_capability_denied` response. This phase does not claim control over independently detached
or externally launched processes.

## Remaining phases

- Setup script with bounded execution and explicit attended authority.
- Owner kinds and opt-in retention: legacy and current worktrees remain manual.
  Automatic cleanup can consider only explicitly session-owned worktrees after
  settlement, the selected retention interval, and a post-settlement grace
  period. No automatic sweep is enabled until that ownership exists.
- A cleanup eligibility ledger should show specific skip reasons: manual owner,
  unsettled or too recent, retention disabled, active process, dirty or unknown
  ignored content, unpushed commits, open PR using the branch as head **or base**,
  and unavailable ownership or repository evidence. Unknown evidence skips.
  Recheck all mutable conditions and checkout identity immediately before a
  destructive transaction; the existing snapshot and quarantine checks stay
  authoritative. T3 Code [#15208](https://github.com/pingdotgg/t3code/pull/15208)
  and [#17563](https://github.com/pingdotgg/t3code/pull/17563) inform retention
  and skip visibility; bb [#4905](https://github.com/get-bb/bb/pull/4905)
  informs process ordering. Aiden does not adopt T3's policy allowing
  ignored/untracked files to be silently removed by a sweep.
- Snapshot-retention GC, Settings/restore UI, `aiden/<name>` branches, base-ref
  picker, and filesystem CoW remain separate work.
