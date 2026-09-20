# Managed Worktree Lifecycle

Adds a safe product lifecycle around Aiden's existing managed-worktree system without rewriting its ownership, admission, quarantine-removal, or crash-recovery machinery.

## Status

P0 implemented as a five-PR stack (#189–#193, stack #194):

| PR | Scope |
| -- | ----- |
| #189 | Lifecycle contracts: `WorktreeSnapshotStore` registry (`refs/aiden/snapshots/<id>`, 30-day retention, 512-cap), journal `snapshotId`/`snapshotRef`/`snapshotCommit` fields, `ManagedWorktree` `snapshotId`/`owner`/`lastUsedAt`/`provisionedFiles` metadata. No behavior change. |
| #190 | `disableRepositoryAutomation` (`core.hooksPath=` empty, `core.fsmonitor=false` via `GIT_CONFIG_*`) on all lifecycle Git calls; `worktree-disk-admission.ts` (reserve = clamp(10% capacity, 4–16 GiB), required = reserve + 2·checkout + 2·provisioned, fail-closed). |
| #191 | `.worktreeinclude` provisioning (untracked+ignored only, Git-matched patterns, no overwrite, mode-preserving, symlink-safe, bounded, durable manifest); `.aiden/worktree-setup.sh` gated to authorized local creation with minimal env and ~120s timeout; failures roll back through the existing path. |
| #192 | Temp-index snapshot before dirty delete (HEAD race check, CAS ref publish, journal baseline `snapshotDirtyStatus`, post-rename dirty guard), provisioned payloads to private store at `0600`, `force` skips only the snapshot, `GitDeleteWorktreeResult.snapshot`. |
| #193 | `restoreManagedWorktree(snapshotId)`: branch recreated at base commit, snapshot tree materialized via temp index so all changes restore unstaged, provisioned files restore from the private store, ownership recreated; refusal on existing branch/deleted ref/foreign repo; IPC + Remote route + Restore toast action. |

## Deferred

- P1: `aiden/<name>` branch namespace, base-ref picker, `owner` classes beyond `manual`, idle GC, Settings → Worktrees page.
- P2: CoW/filesystem acceleration (APFS clonefile, FICLONE, …) — correctness first.

## Invariants preserved

Ownership markers/tokens, device/inode validation, fail-closed admission, `enqueueMutation` serialization, descriptor-bound quarantine removal, removal journals, startup reconciliation. Snapshot failure never destroys a worktree; synthetic commits never enter branch history; ignored/provisioned files never enter Git objects; setup scripts never see `process.env`; manual worktrees are never auto-GC'd.
