# Managed worktree stack disposition — 2026-09-22

Audit baseline: `origin/main` c8c09e0d2, including merged PR #185
(00dc95119). PRs #189 → #190 → #191 → #192 → #193 remain an ordered,
unmerged stack. Their old heads are not green: #189–192 have failed CI and
#193 has no current-head checks. This report does not resolve those reviews,
close the PRs, or claim their failures were repaired in place.

The coordinator approved preserving #185's shipped architecture and making
only confirmed admission fixes on a new branch. Merging the old stack would
introduce a second snapshot format, incompatible provisioned-file metadata,
and weaker journal handling. Recommend superseding the old PRs after owner
review of this report; keep setup and restore UI promises explicitly open.

## Source verification

The [Notion research](https://app.notion.com/p/3da80314a1c481ea9631e23994e8689d)
was last edited September 13. Its linked feature digests are a database rather
than an implementation specification. Current [OpenClaw documentation](https://docs.openclaw.ai/concepts/managed-worktrees)
and upstream [#100535](https://github.com/openclaw/openclaw/pull/100535) and
[#100788](https://github.com/openclaw/openclaw/pull/100788) were checked September
22. Current upstream has evolved beyond the dated research. No upstream code,
automatic worktree deletion, retention GC, or setup-script execution is ported.

## Promised behavior and disposition

| PR | Promise | Current-main equivalent / remaining scope | Recommendation |
| --- | --- | --- | --- |
| #189 | Snapshot registry, lifecycle metadata, recovery journal fields | `managed-worktree-snapshot.ts` persists per-snapshot manifest/blob storage; `git.ts` journal v4 carries snapshot ref/commit/tree. Owner kinds and last-use metadata are deferred; separate registry is unnecessary. | Supersede duplicate contracts; retain future owner metadata as product scope. |
| #190 | Hook-free creation and disk admission | `git.ts` disables hooks and pins creation to a commit; `managed-worktree-capacity.ts` gates allocation. Residual admission gaps addressed by this branch. | Supersede with #185 plus this patch. |
| #191 | `.worktreeinclude` provisioning and trusted setup | `managed-worktree-provisioner.ts` selects root-relative ignored/untracked files and uses native descriptor-bound copying. Setup scripts are not executed at all. Explicit setup authorization, sanitized environment and setup failure recovery remain unfinished. | Supersede duplicate provisioning; do not claim the setup promise shipped. |
| #192 | Snapshot dirty work before deletion, safe force contract | Application service snapshots before quarantine; unknown ignored data blocks safe deletion; native helper and journal v4 verify captured content. Remote does not accept `force` or emit snapshot metadata. | Supersede backend; any new Remote force/recovery surface needs coordinated native contracts. |
| #193 | Restore and desktop restore action | `managed-worktree-restore.ts` resumes a durable journal, restoring synthetic snapshot dirt and private blobs. IPC exists, but sidebar restore toast/inventory is absent. Restore admission added by this patch. | Supersede restore backend; leave discoverable restore UI explicitly open. |

## All 22 existing review findings

Status refers to the current architecture, not fixes pushed to the old heads.
Evidence names are repository files and named tests so they remain useful as lines move.

| PR / finding | Disposition | Evidence |
| --- | --- | --- |
| 189 / expired registry rows leak payloads | Not applicable: no capacity-driven row eviction or automatic retention GC. | `managed-worktree-snapshot.ts` per-snapshot manifest directories; expiry GC remains deferred. |
| 189 / payload I/O bypasses registry initialization | Not applicable: there is no process-global initialized registry to bypass. Restore validates the manifest, Git anchor and private blobs before materialization. | `requireReadyManagedWorktreeSnapshot`, `verifyProvisionedFileBlobs`; lifecycle test “snapshot manifests round-trip and reject incomplete or corrupt records”. |
| 189 / mode differs from provisioning manifest | Changed contract: provisioning metadata is paths only; private snapshot records the actual mode and byte digest at capture, and restores those. | `ProvisionedFileSnapshot.mode` documents snapshot-time mode; lifecycle test “provisioned blob storage captures bytes, verifies digests, and restores idempotently”. |
| 189 / source symlink swap | Fixed by #185 native descriptor I/O. | `native/worktree-file-io/main.c`; native test “source read stays on an opened directory when its pathname becomes an outside symlink”. |
| 189 / restore destination symlink swap | Fixed by #185 native descriptor I/O. | Native test “restore writes through its opened parent when the pathname becomes an outside symlink”; lifecycle symlink-ancestor test. |
| 189 / journal optional types coerced by regex | Superseded by exact v3/v4 journal validation and typed nullable v4 fields. | `parsedWorktreeRemovalJournal` in `git.ts`; existing Git journal/recovery tests. |
| 189 / local configuration accepts arbitrary lifecycle fields | Different schema: owner/timestamps/snapshotId are not in the current managed-worktree contract. Provisioned paths are validated on local-config load. | `isManagedWorktree` in `portable-config-core.ts`; `config-store-core.ts`; portable-config tests. |
| 190 / checkout size reads mutable source, ignores filters | Partially fixed by #185 (committed blobs); nested paths and transformations remained. This patch uses root-relative immutable trees, bounds EOL expansion, rejects filters/ident/encodings without executing them. | New lifecycle estimate and transformation tests; `managedWorktreeCheckoutBytes`. |
| 190 / estimator error becomes Remote 500 | Residual corrected: capacity failure classes map to existing `git_capability_denied` (409); unsupported transformations already use a typed Git error. | `aiden-remote-git.ts`, expanded Remote Git test. No new wire fields/codes. |
| 190 / rollback test still expects hook output | Old test superseded by #185 hook-free contract. | Existing lifecycle “managed worktree creation never executes repository Git hooks”; broader `git.test.ts` rollback tests. |
| 191 / nested provisioning paths | Fixed by #185: source canonical root plus `--full-name` for both listings. | `provisionWorktreeIncludedFiles`; lifecycle provisioning tests. |
| 191 / provisioned worktrees cannot be deleted | Fixed by #185 authoritative manifest/private payload path. | Lifecycle “a provisioned file inside an ignored directory does not block safe deletion”; application service snapshot-before-delete test. |
| 191 / failed setup leaves dirty checkout | Not applicable to shipped code: setup does not execute. Setup failure cleanup remains part of unfinished explicit setup feature. | Lifecycle plan exclusions; application service create only calls provisioning. |
| 192 / unknown ignored files are lost | Fixed by #185: unknown ignored files and mixed ignored directories block safe deletion. | Two lifecycle unknown-ignored tests and application service classification test. |
| 192 / same-path bytes change after snapshot | Fixed by #185: authorization compares captured Git tree/content, not only porcelain. | Lifecycle “content changed after the snapshot cannot be silently discarded”; `quarantineAndRemoveManagedWorktree` authorization callback. |
| 192 / tests accidentally use global Electron store | Not applicable: current lifecycle tests use temporary manifest roots and injected application dependencies. | `managed-worktree-lifecycle.test.ts`, `workspace-worktree-application-service.test.ts`. |
| 192 / undeclared Remote snapshot/epoch expiry response | Not applicable: current Remote response emits no snapshot object or expiry. Remote recovery identity remains unfinished scope. | `AidenRemoteGitService.deleteManagedWorktree`, OpenAPI `GitMutation`; unchanged native DTOs. |
| 192 / undeclared Remote force request | Not applicable: Remote exact-key request still permits only `confirmedForeground`; force is not exposed. | `aiden-remote-git.ts`, OpenAPI ForegroundConfirmation; native request DTOs. |
| 193 / dirty restore rollback cannot clean up | Replaced by durable resume, preserving partial restored work instead of deleting it. A failed restore remains retryable using the same journal/workspace identity. | Lifecycle “restore converges after a crash between checkout creation and journal update”; complete replay tests. |
| 193 / restore omits private payload admission | Still present on audit baseline; corrected by this patch with base + snapshot + private payload estimates, destination and common-dir checks before allocation, and completed-replay bypass. | Application service restore admission regression; lifecycle failure-preserves-snapshot/replay tests. |
| 193 / restore toast discards dirty editor | Not applicable because current sidebar has no restore toast. Any future action must use the normal dirty-editor guard. | `renderer/components/chat-sidebar.tsx`; restore UI remains unfinished. |
| 193 / toast loses nested/managed sources | Not applicable to absent toast. Current backend validates source repository common-dir identity and preserves `workspaceSubpath`; it does not infer source from a root-only sidebar match. | Application service `restore`, `ManagedWorktreeSnapshot.workspaceSubpath`. Discoverable UI still unfinished. |

## Residual admission patch

- Read complete committed trees even when the initiating workspace is nested or
  tracked source files are missing. Inspect checkout attributes using an isolated
  temporary index; never run filters to estimate their output. Reject unbounded
  filters, ident and working-tree encodings. Account for EOL expansion and per-file overhead.
- Recheck the captured creation commit in Git's mutation queue on destination
  and Git common-directory filesystems (bounded metadata/index budget, not a second object copy). Source HEAD movement does not select a
  different checkout. Provisioning reserves its enforced 256 MiB bound and checks
  again immediately before copying; no mutable source-size estimate is trusted.
- Restore admits the base tree, captured tree and validated private payload
  before restore journaling/checkout creation, with phase-specific retry budgets. Complete journal replay
  performs no new allocation and does not require free space.
- Unavailable/invalid capacity fails closed; missing destination roots use their
  nearest existing parent without creating directories in the capacity helper itself. The production caller may create the empty managed root before admission; no checkout/branch is created by a denied admission. No volume fallback to
  the source repository. Remote uses the existing capability-denied error.

Admission is a bounded preflight, not a filesystem reservation: other processes
can still consume disk after the check. Setup, GC, owner metadata, restore UI and
new Remote restore/force capabilities remain out of this corrective patch.

## Validation

- Git/lifecycle/application/Remote regression run: 127 passed. After final review
  fixes, the affected lifecycle/application suites passed again (27 tests).
- TypeScript and focused ESLint passed; `git diff --check` clean.
- Native descriptor path-race tests: 2 passed.
- Android workspace environment, Remote client and phase-0 contracts: 41 tests
  passed (Gradle unit tests with installed Android Studio JDK/SDK).
- Both independent GPT-5.6 Sol medium reviews are clear after fixes. Findings
  addressed: ident expansion, post-index-change execution during temporary
  read-tree, separate metadata budget, shared-volume aggregate, phase-specific
  restore retry capacity, and precise directory-creation wording.
- iOS physical execution is blocked: coordinator reports iPhone 13 Pro
  `00008110-00063CD91E98801E` locked; device preparation Code=-3,
  “Unlock Sambit’s iPhone to Continue”. The workspace/client/phase0 suites are
  queued behind other authorized device users. No simulator or device test was
  run by this task; existing native decoders already accept the unchanged
  `git_capability_denied` code. Hosted generic-device compilation is not XCTest
  execution evidence.
- Hosted checks and PR review remain pending at initial publication. Old stack
  heads and their 22 unresolved threads remain unchanged.
