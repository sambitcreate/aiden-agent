# Git display reads and bounded review statistics — 2026-09-28

Scope X01/X02 from the performance supplement; baseline `a9baa4aa3027893e5455043083465c34b4c8b4ac`. Read-only shared Git queries now coalesce independent subscribers (info, branches, review, push capability and comparison). One subscriber's abort detaches only that subscriber; the last abort cancels the underlying work and blocks late cache publication. Branch reads reuse a concurrent info read with the original caller path (important for macOS `/var` versus `/private/var` aliases).

Repository-root reads reuse discovery only within the existing display TTL, validating root, `.git`, linked administrative/common-directory identity and pointer/config metadata before admission and after completion. Nested/unusual layouts remain uncached. Discovery deliberately expires at the existing one-second default: indirect/global Git configuration can change without touching local config. No polling interval or stale-time was increased; expired/no-op polling still performs fresh Git commands. Mutation admission still calls the original uncached discovery, and common-dir mutation epochs remain authoritative. Display reuse never authorizes writes.

Untracked/unborn fallback line inspection is serial, descriptor-based, capped to the observed size plus one EOF byte, read in at most 64 KiB chunks, and limited to 8 MiB reserved bytes per refresh. The independent snapshot/digest validation remains unchanged. Changed/unsupported/budgeted files retain missing counts and contribute to the existing `unavailableStats` presentation. Up to 4,096 line-count cache entries use inode/device/mode/size/nanosecond mtime/ctime, with descriptor and final path checks. Subsequent refreshes can fill previously unavailable counts from the remaining budget. Native clients already preserve missing counts; focused decoding tests cover that behavior.

Reproducible evidence: `npx tsx scripts/benchmark-git-reads.mjs --baseline a9baa4aa3027893e5455043083465c34b4c8b4ac`, then `npx tsx scripts/benchmark-git-reads.mjs`. Clean `npm ci`, Node 22.22.3 and the pinned Pi 0.87.1 dependencies. The fixture uses temporary repositories and real Git, not profiles/provider traffic.

| Counter | Baseline | Changed |
| --- | ---: | ---: |
| Cold info Git commands | 6 | 6 |
| Ten sequential warm info reads (60s fixture TTL) | 30 | 0 |
| 1,000 × 16 KiB untracked files: peak fallback reads | 1,000 | 1 |
| First fallback bytes | 16,384,000 | 8,372,224 |
| First unavailable file counts | 0 | 489 |
| Second fallback bytes | 16,384,000 | 8,011,776 |
| Third unchanged fallback bytes | 16,384,000 | 0 |
| Third unavailable file counts | 0 | 0 |

All three snapshots were complete on both versions. The fallback counters exclude snapshot hashing. Observed max RSS was 179,312 versus 98,704 KiB, but includes Node/tsx/fixture overhead; it is not packaged Electron latency, steady-state memory, or energy acceptance. Ten concurrent cold info consumers now issue one six-command flight. Default-TTL expiry, external file/ref/config edits, linked common-dir mutation, root/symlink/pointer changes, subscriber cancellation, stat-growth races, and stale commit snapshots have behavioral coverage.

Open-PR overlap was rechecked using all 36 open PRs and paginated files (#85: 295; #37: 209). #261 owns missing-Xcode Git executable selection in `run`; that boundary is untouched. #85 overlaps the existing Git test file only. No plan status or UI/onboarding capability changed.

Validation so far: Git + Remote Git suite 108 passing before the final TTL test; focused final behavior suite 9 passing; Android AidenWorkspaceEnvironmentTest 13 passing; iOS AidenWorkspaceEnvironmentTests passed on iPhone 17 Pro simulator (iOS 27, destination 9F4FDF41-3FE3-477D-B92B-127C43FE927E, signing disabled). Independent review and final exact-head/hosted evidence are pending.

Pre-publication Astra medium review found a real routing race: local config/linked `commondir` metadata had been captured after discovery, allowing a `core.worktree` edit during discovery to validate an old tuple against new metadata. The fix captures the complete supported-root proof first, bounds pointer-file reads, and retries changed routing (at most three discoveries). Real-Git tests race both `core.worktree` and `commondir`, including subsequent mutation invalidation via the newly selected common directory. Final pre-fix full Git + Remote run: 109 passed; focused review-fix suite: 10 passed. Re-review and final full run are pending.
