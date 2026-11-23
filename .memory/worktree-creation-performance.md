# Worktree Creation Performance Optimization

Implemented across four phases on `worktree_performance_optimization` (2026-11-21), each gated by two independent adversarial reviews. See [`docs/plans/worktree-creation-performance.md`](../docs/plans/worktree-creation-performance.md).

## Head-to-Head Measured Results (`aiden-macos`, 6,497 tracked files, Apple Silicon APFS, 5-run medians)

| Operation | Before (`origin/main`) | After | Saved | % Reduction | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Explicit Create (`createIn` + `createWorktree`) | 1,417 ms (127 git spawns) | 744 ms (8 git spawns) | −673 ms | −47.5% (−93.7% spawns) | 1.90× |
| Worktree-on-Send Backend (local base → ready for LLM) | 1,915 ms (144 git spawns) | 711 ms (12 git spawns) | −1,204 ms | −62.9% (−91.7% spawns) | 2.69× |
| Post-Create `git.info(worktreePath)` | 172.82 ms (6 spawns) | 0.77 ms (0 spawns) | −172.05 ms | −99.6% (−100% spawns) | 224× |
| Per-Op Admission (`managedWorktreeUsable`) | 15.28 ms (4 spawns) | 0.58 ms (0 spawns) | −14.70 ms | −96.2% (−100% spawns) | 26.3× |
| `.worktreeinclude` (31 files, clean repo) | 100 ms (31 spawns) | 40 ms (1 batched CoW spawn) | −60 ms | −60.0% | 2.50× |
| `.worktreeinclude` (31 files + 5,000-file `node_modules`) | Crashed (`output_limit` > 1 MiB) | 44 ms | Fixed crash | 100% crash fix | ∞ |

## Key Architecture Decisions & Safety Invariants

1. **Streaming `git check-attr --cached -z --all --stdin` (`main/services/git.ts`)**: Replaces 128-path serial `check-attr` loops (~102 spawns) with 1 streaming process parsing NUL triples on raw `Buffer` slices (O(1) memory, immune to 1 MiB `DEFAULT_MAX_BUFFER_BYTES` overflow, evaluates `info/attributes`, global config, and `includeIf`).
2. **Parallel checkout tuned to APFS (`checkout.workers = min(4, cpus)`, `checkout.thresholdForParallelism = 50`)**: Controlled A/B on Apple Silicon APFS showed `workers=4` beats `workers=8` (which exhibited tail spikes). Raw APFS `clonefile(dir)` for Git working trees was rejected because it breaks Git's inode stat cache and causes 1.2–1.8 s `git status` stalls.
3. **Authoritative inner capacity admission (`additionalAllocationBytes`)**: `createIn` passes `provisionedReserve` into `git.createWorktree`, which validates non-negative safe integers and enforces `checkoutBytes + additionalAllocationBytes` inside `enqueueMutation(repo.commonDir)` before `mkdir`/`worktree add`.
4. **Inverted `.worktreeinclude` + literal `./` pathspec neutralization**: Runs `git ls-files -z -o -i --exclude-from=.worktreeinclude --full-name`, short-circuits if empty, then filters via `git check-ignore -z --stdin` in `repo.topLevel` with `./`-prefixed paths (neutralizing `:` pathspec magic bypass/DoS).
5. **0-spawn pure-FS `managedWorktreeUsable` & display cache seeding (`main/services/git.ts`)**: Reads `<wt>/.git`, `<admin>/{aiden-owner,gitdir,commondir,HEAD}`, and loose/`packed-refs` via `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, fenced with `while (this.mutations.has(commonDir))` + `mutationEpochs` (no cross-caller stale `usableFlights` cache). Falls back to Git on `reftable` or ambiguity. Display-only `infoCache` seeding for newly created worktrees is fenced by pre/post `repoRemoteHintSignature` and `mutationEpochs`.
6. **Split global/workspace skill discovery cache, Pi `dirIndex`, and `protectLocal` gating**:
   - `discoverSkillCandidatesWithCachedGlobals` caches global candidates for 5 s keyed on `[home, aidenDir, globalPluginConfigs]` (honoring workspace `.claude/settings.json` disabling global plugins); `resolveFresh()` always bypasses cache.
   - `PiCompactionSessionStore` indexes `.jsonl*` files with per-file `lstat` signatures and monotonic `dirMutationVersion` concurrency fencing so brand-new chats skip migration/list scans while in-place edits and symlinks are caught.
   - `portable-config-core.ts` gates `protectLocal()` on warm loads only when `ownedPaths.length === 0 && archivePublicationPaths.size === 0`, keeping `ensurePrivateDirectory(root)` live and checking `lstat` (`uid`, `mode`, `nlink === 1n`, `dev/ino/mtimeNs/ctimeNs`) on `config.json` and recorded secondary files.
7. **Renderer IPC coalescing & zero-remount promotion**:
   - `FirstMessageWorktreeResult` optionally carries `workspace`; `workspaces:changed` emits `{ kind: "created", workspace }` on creation so hydrated idle caches upsert via shared `upsertCreatedWorkspaceInCache` without refetching `workspaces:list` or `chats:list`.
   - `markChatRecentlyPromoted` uses subscriber refcounting + microtask-deferred cleanup (React StrictMode safe) so only the immediate draft → live `useChat` activation reuses the seeded snapshot while leaving/revisiting always re-reads.
   - Pending worktree sends render inside `MessageList` (`keepForkWrapper` + `"draft-prompt"` key handoff) so the user bubble and attachments settle in place without remounting.
   - `EnvironmentArtifactsContext` isolates volatile `useWorkspaceArtifacts` updates from `ChatPane`, `ChatSidebar`, `RootView`, `HistoryNavButtons`, and `DesignLayout` via `useEnvironmentPanelCore()`.
8. **Native batched CoW `provision` subcommand (`native/worktree-file-io/main.c`)**:
   - Preserves `copy` and `restore` (with SHA-256) untouched for snapshots.
   - Dedicated `provision` subcommand handles all `.worktreeinclude` paths in 1 spawn, uses APFS `fclonefileat(..., CLONE_NOFOLLOW | CLONE_NOOWNERCOPY)` into a random temp file when plain/same-volume/no-xattrs/no-flags/no-special-bits/owner-readable, clears `fchflags(cloned, 0)` BEFORE `fchmod(cloned, mode & 0777)`, verifies `flistxattr(cloned) == 0` + `same_provision_source` (including `st_mode`, `st_flags`, `st_ctimespec`), atomically installs via `renameatx_np(..., RENAME_EXCL)`, falls back to `read/write` on `EXDEV`/`ENOTSUP`/`EACCES`/`EPERM`, deduplicates parent `fsync`s (capped at 64 FDs), and handles `SIGTERM` gracefully while Node's `provisionManagedWorktreeFilesBatch` settles strictly on `"close"` so disk state stays 1:1 with `onProvisioned`.
