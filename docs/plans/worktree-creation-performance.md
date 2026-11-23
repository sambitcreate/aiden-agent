# Worktree Creation Performance (Tier 1 & Tier 2)

**Status:** Implemented, in review (2026-11-21) on branch `worktree_performance_optimization` (merged with `origin/main` `6555f1767`).

## Goal

Make managed worktree creation and worktree-on-send feel instantaneous and smooth on macOS and Linux without relaxing any of Aiden's ownership, admission, TOCTOU, snapshot, or disk-capacity safety invariants.

## Measured Head-to-Head Results (`aiden-macos`, 6,497 tracked files, Apple Silicon APFS, 5-run medians)

| Operation | Before (`origin/main`) | After (this PR) | Saved | % Reduction | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Explicit Create (`createIn` + `createWorktree`) | **1,417 ms** (1.42 s, 127 git spawns) | **744 ms** (0.74 s, 8 git spawns) | **−673 ms** (−0.67 s) | **−47.5%** (−93.7% spawns) | **1.90×** |
| Worktree-on-Send Backend (local base → ready for LLM) | **1,915 ms** (1.92 s, 144 git spawns) | **711 ms** (0.71 s, 12 git spawns) | **−1,204 ms** (−1.20 s) | **−62.9%** (−91.7% spawns) | **2.69×** |
| Post-Create `git.info(worktreePath)` | **172.82 ms** (6 git spawns) | **0.77 ms** (0 git spawns) | **−172.05 ms** | **−99.6%** (−100% spawns) | **224×** |
| Per-Op Admission (`managedWorktreeUsable`) | **15.28 ms** (4 git spawns) | **0.58 ms** (0 git spawns) | **−14.70 ms** | **−96.2%** (−100% spawns) | **26.3×** |
| `.worktreeinclude` (31 ignored files, clean repo) | **100 ms** (31 helper spawns + 62 fsyncs) | **40 ms** (1 batched CoW helper spawn) | **−60 ms** | **−60.0%** | **2.50×** |
| `.worktreeinclude` (31 files + 5,000-file `node_modules`) | **Crashed** (`output_limit` > 1 MiB) | **44 ms** (0 crashes) | Fixed crash | **100% crash fix** | ∞ |

## As-Built Deviations & Refinements from Adversarial Reviews

- **No cross-caller `usableFlights` cache (Phase 2):** Removed in-flight coalescing across callers for `managedWorktreeUsable` so live FS verification never shares a stale admission across concurrent mutations; fenced instead with `while (this.mutations.has(commonDir))` + `mutationEpochs` and `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` reads.
- **No workspace-folder read during Flow-B skill warmup (Phase 3):** `chats:createWithFirstMessage` warms `discoverSkillCandidatesWithCachedGlobals(undefined)` only when `settings.skillsEnabled !== false`, honoring No Access workspace boundaries and avoiding source-local `.claude/settings.local.json` cache-key drift.
- **Graceful `SIGTERM` + close-gated abort settlement in `provision` (Phase 4):** `provisionManagedWorktreeFilesBatch` manages `AbortSignal` via `SIGTERM` (+ 2 s `SIGKILL` fallback) and settles strictly on `"close"` after `stdout` drains, while `native/worktree-file-io/main.c` catches `SIGTERM`, unlinks partial temps, and emits `p <idx> <bytes>` 1:1 with disk installs so rollback never races with a running helper.
- **Deferred (out of scope):** Tier 3 standby worktree pool remains out of scope; `FirstMessageWorktreeLedger` `ready` fsync and `GitRepoWatcher` self-echo suppression were left untouched to preserve crash-safety guarantees.

## Non-Negotiable Safety Invariants

1. **Inner mutation admission stays authoritative**: `managedWorktreeCheckoutBytes` + `checkWorktreeAllocation` must run inside `enqueueMutation(repo.commonDir)` before `mkdir`/`worktree add`. Deduplicate by passing `additionalAllocationBytes` into `createWorktree`, not by removing the inner check.
2. **Streaming `check-attr --all --stdin` only**: Never buffer full `check-attr --all --stdin` output in the 1 MiB `DEFAULT_MAX_BUFFER_BYTES` buffer (2 normal `.gitattributes` rules produce >1.1 MiB on 6,500 files), never switch to explicit attribute names (loses `filter=unspecified` distinction), and never skip `check-attr` when `.gitattributes` is absent from `ls-tree` (`info/attributes`, global config, and `includeIf` still apply).
3. **Preserve `copy` SHA-256 in `native/worktree-file-io/main.c`**: `captureProvisionedFile` in `managed-worktree-snapshot.ts` requires `copied.digest`. Add a dedicated batched `provision` subcommand that preserves `openat` + `S_ISREG` + `same_source`, strips modes to `0777` + clears flags (`fchflags(0)`), and falls back to `read/write` on `EXDEV`/`ENOTSUP`.
4. **Live FS verification for `assertManagedWorktreeAdmission`**: Keep every `revalidate()` call in `agents-instructions.ts` and every admission call in `terminal:write`; replace the 4-git-spawn check inside `managedWorktreeUsable` with live 0-spawn pure-FS verification (`lstat` dev/ino + `<wt>/.git` + `<worktreeGitDir>/{aiden-owner,gitdir,commondir,HEAD}`) + in-flight promise coalescing so external `mv`/`rm`/`git switch` revocations remain immediate.
5. **Retain `DataStore` `.previous` predecessors**: Keep process-lifetime `.previous` files intact; only gate redundant `protectLocal()` rescans on warm `local.load()` cache hits when directory/publication state is unchanged.
6. **Preserve renderer safety contracts**: Keep pre-send `folderPresence` on existing-chat sends (PR #647); keep `useChat` global `staleTime: 0` (suppress only one-shot post-promotion `refetchOnMount`); keep `workspaces:changed` → `chats:list` invalidation on workspace removals/Remote reconciliation.

## Phases

### Phase 1 — Backend Git Core & `.worktreeinclude` Fix (Tier 1 Backend)
- Collapse `GitService.repository()` from 3 `rev-parse` spawns (2 serial rounds) to 1 spawn (`git rev-parse --is-inside-work-tree --show-toplevel --git-common-dir`).
- Replace the 128-file sequential `git check-attr` loop in `managedWorktreeCheckoutBytes` with a single streaming `git check-attr --cached -z --all --stdin` parser (no 1 MiB overflow; same-commit + attribute-file-mtime memoization safe across `info/attributes` and global config).
- Deduplicate outer vs. inner `managedWorktreeCheckoutBytes` and `checkWorktreeAllocation` via `additionalAllocationBytes` passed into `git.createWorktree`; remove redundant post-create `repositoryPaths` call in `createIn`.
- Enable parallel checkout in `git.createWorktree` (`-c checkout.workers=${min(4, cpus)} -c checkout.thresholdForParallelism=50`, verified optimal on APFS with zero tail spikes).
- Trim redundant pre/post spawns in `createWorktree` and `createFromBase` (direct `<wt>/.git` read with safe fallback, drop redundant `show-ref`, thread `repo` across `resolveWorktreeBase`/`fetchWorktreeBase`/`localBranchNames`, parallelize independent reads).
- Fix `.worktreeinclude` `node_modules` `output_limit` crash: invert to `git ls-files -z -o -i --exclude-from=<includeFile> --full-name` → short-circuit if empty → `git check-ignore -z --stdin` with `allowExitCodes: [1]`.

### Phase 2 — Main Process 0-Spawn Admission, Skill Cache, Pi Fast-Path & Store Gating (Tier 2 Main)
- Live 0-spawn pure-FS verification + in-flight coalescing in `managedWorktreeUsable` / `assertManagedWorktreeAdmission`.
- Split global vs. workspace skill candidate discovery cache in `skills-discovery.ts` / `skill-registry.ts` (preserving `isEnabled()` check first and `O_NOFOLLOW` workspace checks); avoid double `resolveFresh` on slash-skill worktree sends.
- Fast-path brand-new chats in `piCompactionSessionStore.openChatIfEligible` (in-memory index of existing journals & legacy migration candidates scanned once on store init, updated on create/delete).
- Gate `protectLocal()` on warm `localStore.load()` cache hits when directory/publication state is unchanged; make `FirstMessageWorktreeLedger`'s `ready` transition non-blocking/no-fsync (since `pending` is already crash-safe); seed short-TTL display-only `GitInfo` cache on newly created worktrees and suppress `GitRepoWatcher` self-echo for Aiden's own ref creation.

### Phase 3 — Renderer Perceived Speed, IPC Coalescing & Parallel Flow-B Warmup (Tier 1 + 2 UI & IPC)
- Enrich `FirstMessageWorktreeResult` (and `git:createWorktree` if additive/safe for desktop/Remote/mobile) with `{ workspace, initialGitInfo }` so `chat-pane.tsx` seeds caches and selects the workspace synchronously instead of blocking `runGeneration` on `await qc.invalidateQueries(workspaces)`.
- Pipeline read-only workspace-independent Flow-B LLM warm-up (`resolveModelRuntime`, global skills, `webSearchService.availability`) in parallel with `firstMessageWorktrees.ensure()`.
- Narrow `workspaces:changed` so workspace *addition* updates `queryKeys.workspaces` without blindly refetching `chats:list` (keeping full invalidation for removals/reconciliation).
- Mount `DraftWorktreeSendView` on frame 1 for draft worktree sends; seed draft `worktree.baseRef`/`fromOrigin` immediately from `GitInfo` (fixing `⌥↵` double-stall); gate `useGitWorktrees` in `git-branch-picker.tsx`; suppress one-shot post-promotion `chats:get` refetch while keeping global `staleTime: 0`.
- Render pending worktree-send state seamlessly inside `MessageList` (no bubble remount flash); isolate `artifacts`/`editorState`/`gitOperationBusy` from monolithic `EnvironmentPanelContext`; wrap non-urgent workspace-switch updates in `React.startTransition`; use `requestChatDraftComposerFocus` in `createGitWorktree`.

### Phase 4 — Native Batched `provision` (`native/worktree-file-io/main.c`), Benchmarks, Docs & CI
- Add dedicated batched `provision` subcommand in `native/worktree-file-io/main.c` (using APFS `fclonefileat` when same-volume + `openat`/`S_ISREG`/`same_source`/`mode & 0777`/`fchflags(0)` + `EXDEV`/`ENOTSUP` fallback, single directory `fsync`, leaving `copy` + SHA-256 intact for snapshots) and wire `managed-worktree-provisioner.ts` to use it.
- Re-run uncontended benchmarks, verify all unit/contract/typecheck/lint/mobile/E2E suites, update `.memory/` and `docs/plans/README.md`, open PR, and watch CI until green.

## Review Gate

After every phase: run targeted behavioral test suites, launch **two independent Gemini 4 Hydrogen (High) adversarial reviewers** to hunt for edge cases, regressions, and security/TOCTOU flaws, resolve all findings, re-test, and commit before advancing.
