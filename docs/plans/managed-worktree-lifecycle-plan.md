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
checkout. It then checks native POSIX session membership for surviving jobs,
including background jobs in separate process groups that have lost their
controlling PTY. A terminal that does not
exit within five seconds, a surviving job, or an unavailable inventory blocks
removal with an actionable retry message. Session identities and pending
exits remain tracked across attempts; an immediate retry cannot bypass the wait.
On Linux, the audit rejects a filtered or malformed `/proc` inventory (including
`hidepid` mounts) rather than treating invisible processes as absent.
If node-pty reports no valid positive PID, Aiden sends no signal through that
handle and retains a hard deletion hold in the running service: it has no
session identity with which to prove that shell jobs stopped. This case needs
manual process inspection rather than an unverified automatic retry.
The existing cancellation of workspace
operations, generations, and schedules and the Git ownership/quarantine checks
remain in place. Remote callers receive the same reason via the existing
`git_capability_denied` response, and a pre-delete refusal permits a same-key
Remote retry. This phase does not claim control over independently detached or
externally launched processes.

## Deleted worktree folder (PR pending)

A chat whose managed worktree folder was deleted outside Aiden (for example
with `rm -rf` or the Finder) is checked at the checkout root like any other
workspace folder. Sends are refused before they are added to the chat, and the
notice above the composer offers two actions:

- **Restore worktree** (`workspaces:restoreDeletedWorktree`) is offered only
  while the branch still exists, no other worktree has it checked out, no
  Aiden removal of it is pending, and the folder it lived in is still there.
  Under the repository's mutation lock it verifies the old ownership token in
  Git's admin directory, clears the stale registration by moving that admin
  directory out of `worktrees/` in one rename (never `git worktree remove`,
  which would delete a clean folder put back from the Trash meanwhile), looks
  for the folder once more and puts the record back if it is there, checks the
  same branch out again at the same managed path with hooks disabled, writes a
  new ownership token and saves the workspace record. If any step after
  `worktree add` fails, the save included, the new checkout is removed again
  so Restore can be retried. When the folder has to be kept (something was
  written into it), its new Git record gets the workspace's recorded
  ownership back, so it stays a working checkout and "delete the folder, then
  Restore again" works. Then `.worktreeinclude` files are copied in again,
  after the same room check creation makes; without room the checkout still
  comes back and the skipped copies are logged. It never creates, moves or
  deletes the branch, so commits survive and uncommitted changes, which went
  with the folder, do not. It refuses a present folder, a foreign token, a
  moved registration, a pending removal, a No Access workspace, a branch that
  is gone, and a branch checked out elsewhere.
- **Check again** stays, because putting a folder back from the Trash is the
  only way to keep uncommitted work; the notice says so.
- **New chat in main checkout** opens a draft in the repository's main
  workspace (the nested-subpath match, or the repository root, compared by
  real path) in checkout mode with the unsent message text. Attachments stay
  in the old chat's composer. The old chat is left as it was.

Phones and paired Macs get `workspace_unavailable` with a path-free message
telling the person to restore it from the chat on the Mac.

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
