# Workspace metadata concurrency — 2026-09-28

Baseline a9baa4aa3027893e5455043083465c34b4c8b4ac; branch feature/workspace-metadata-performance. Scoped X06/X07 from the read-only September performance audit. Rechecked complete paginated file lists of all 36 open PRs: #85 has 295 files, #37 has 209. Neither owns workspace-files.ts or legacy aiden-remote-files.ts. Inspected #85's related llm-client changes; no llm-client change is needed here.

## Implementation and limits

- Desktop Files and eligible Gemini preparation share the existing fresh recursive index. Metadata now runs in batches of at most four, bounded by remaining entry capacity. Commit results in enumeration order; preserve breadth-first selection, numeric final ordering, 4,000 entries, depth20, skip counters and symlink treatment. A pre-aborted index does no filesystem work.
- Legacy Remote listing still separately inspects every identity. Four claims checks may overlap, then handles issue serially in index order after cancellation is checked. Cancellation/stat failure drains the batching layer before returning. Capacity keeps the existing 429 response; omission, expiry, device/workspace/revision checks and read/write validation remain intact. No new file content reads or open handles.
- No completed-index cache, in-flight deduplication, or authority metadata reuse. Sizes and timestamps contribute to Gemini's exact snapshot, and external writes/renames/root replacements must be visible on the next request. Total stat/identity work is unchanged: this reduces serial wait time, not repeated-work counts. Fresh traversal, directory materialization/sorting, and Gemini's awaited preparation remain. The secure native lazy path and non-Mac fallback are unchanged.
- Bulk per-entry inspections now share one FIFO batch budget across requests: at most four active inspections and 64 waiting batches. Queued cancellation removes its waiter immediately; started work drains before handoff. Root admission and directory enumeration stay outside this budget as before. Index metadata remains non-atomic. Identity inspection now drains both realpath lookups on failure before releasing the shared budget.

## Reproduction and evidence

Clean npm ci with pinned Pi0.87.1, Node22.22.3, macOS arm64. Run:

```
npx tsx scripts/benchmark-workspace-metadata.ts
METADATA_LATENCY_MS=1 npx tsx scripts/benchmark-workspace-metadata.ts
```

The script reads the baseline sources from Git into a temporary directory (does not switch checkouts), generates wide and depth20 synthetic trees, runs before/after, asserts identical Gemini snapshot strings and Remote projections apart from random ids, counts actual filesystem calls and cleans up. The optional delay models per-stat latency; it is not a packaged-app timing claim.

Latest unmodified-filesystem run after local native builds completed (single-run milliseconds):

| Tree / operation | Before | After |
| --- | ---: | ---: |
| Wide / Gemini index | 571 | 517 |
| Wide / legacy Remote | 1622 | 1202 |
| Deep / Gemini index | 579 | 145 |
| Deep / legacy Remote | 3090 | 1925 |

Wide index: 4001 stats, 1 realpath, 1 readdir in both versions. Wide legacy: 8001 stats, 8001 realpaths, 1 readdir in both. Deep index: 3981 stats, 1 realpath, 21 readdirs; deep legacy: 7981 stats, 8001 realpaths, 21 readdirs. Output4000 in each case; zero readFile/open calls. Peak stat and file-identity concurrency moves1→4. Timing is noisy under shared-host load: an earlier wide index sample regressed318→391ms while native compilation was active. Use counters/tests as structural evidence; do not claim a universal local-disk speedup.

## Validation and review

- Existing test:aiden-remote: 533 passed, 1 existing skip (19 peer +507 Remote +7 revocation runtime).
- Workspace index/Gemini suites: 30 passed, 1 existing Linux-only skip. New tests assert four-operation cap, drain on cancellation/failure, exact4000 selection/ordering, capacity429, no handles from revoked in-flight batch, external edits/root replacement, depth and symlink semantics. Test files were already registered; no package/test-chain edits.
- Android AidenWorkspaceEnvironmentTest:12 passed. Inspected Android and iOS lazy400/404 fallback and legacy DTO validation; unchanged wire behavior requires no native implementation changes.
- iOS AidenWorkspaceEnvironmentTests:11 passed on iPhone17 Pro iOS27 simulator9F4FDF41-3FE3-477D-B92B-127C43FE927E, Xcode-beta, unsigned regression run. Current ios/AGENTS.md permits simulator regression. Not physical/release acceptance.
- TypeScript, scoped ESLint, whitespace checks passed.
- Independent fresh-context gpt-6-astra medium reviewer cleared the scoped diff before publication and independently ran36 focused tests (1 Linux-only skip). Residual limits above documented.

No UI, onboarding, protocol, plan status, model catalog, deployment or provider traffic change. Publication and exact-head hosted CI/Pullfrog/Hermes acceptance follow separately.

The optional1ms stat-delay sample returned wide index7455→1963ms, wide legacy15813→3218ms, deep index5504→1420ms, deep legacy14997→17999ms. The last sample was slower despite peak concurrency4; shared-host scheduling affects wall time even with simulated latency. No latency threshold is a test acceptance gate.


## Pullfrog aggregate-budget follow-up

Pullfrog review5343514849 on56120a385 flagged that independent four-operation batches could multiply filesystem pressure across requests. Added shared FIFO admission with a64-batch waiting cap, prompt cancellation while queued, drain-before-handoff for started checks, and explicit overload rejection. Queue-full requests follow the existing workspace error path; handle capacity still uses429. Avoids caching/deduplication or authority reuse. Slow filesystem calls can hold the active batch; queued cancellation does not wait for them.

The identity helper now awaits both root/candidate realpath results even if one fails, closing the previous sibling-lookup drain limitation. Behavioral tests cover two simultaneous Remote listings plus a desktop index, canceled waiters without releasing another request's budget, queue overflow/recovery, synchronous inspector failures, and failed identity sibling draining.

Fresh independent gpt-6-astra medium re-review cleared production/tests and independently ran46 tests,1 Linux-only skip. Full test:aiden-remote rerun:535 passed,1 existing skip. Android12 and iOS simulator11 workspace tests passed again. TypeScript/scoped ESLint/whitespace pass. No native implementation or wire shape change.

Benchmark now includes overlapping Files/Gemini/Remote requests and copies baseline metadata/identity helpers too, allowing comparison against the initial published56120a385 head. `repeatedFileStats` counts repeated file-path stats, including repeated index scans in overlapping cases; it must not be read as identity-only work there. Root stats and directory reads are included in total counters but outside bulk admission. New-head hosted checks/reviews are required after push.

Comparison against initial published56120a385 (no injected latency): three overlapping requests peak at12 stats before versus4 after, on both wide and deep trees. Counts remain16003 wide /15943 deep stats, with identical projected outputs and no content reads/opens. Wide concurrent completion550→601ms and deep455→558ms: aggregate admission intentionally trades some concurrent throughput for bounded shared filesystem pressure. Single-request peaks remain4; this follow-up does not claim additional single-request speedup.


## Remote Bot follow-up and caller inventory

Pullfrog review5343756347 found the Bot listing identity loop outside the shared budget. Bot listings now admit each identity check through the same gate, retain serial policy revalidation after admission, and issue handles only after the shared cancellation/drain check. Active and archived Bot authority/error mappings stay separate from workspace authority. The two new regressions fail on published6fc57fae: overlapping Bot/workspace stat peak6 exceeds4, and a revocation during identity inspection still issues1 handle. Both pass with the follow-up (peak<=4 and zero revoked handles).

The budget covers **bulk metadata for recursive workspace file snapshots and their legacy file-handle issuance**, not all filesystem or opaque-handle work in the process:

| Caller / operation | Budget coverage |
| --- | --- |
| Desktop Files (`main/handlers/workspaces.ts`) | Shared per-entry index metadata |
| Eligible Gemini turn preparation (`llm-client.ts`) | Same shared per-entry index metadata |
| Headless CLI `files list` (`packages/cli/src/git-commands.ts`) | Same per-entry index helper, with its own process-local budget |
| Legacy Remote workspace file snapshot (`aiden-remote-files.ts`) | Index metadata and independently inspected file identities |
| Legacy Remote Bot file snapshot (`aiden-remote-bot-files.ts`), active or archived authority | Index metadata and serial, policy-revalidated file identities |
| Root admission, directory enumeration, sorting | Existing per-request behavior, outside this per-entry budget |
| Secure native lazy Files browsing | Existing bounded native direct-child enumeration and reused confined identities; separate path, unchanged |
| Approved-root workspace picker (`aiden-remote-workspace-browser.ts`) | Separate setup/registration authority surface; serial root/directory/breadcrumb identity checks retain their existing limits and are outside recursive file snapshots |
| One-off handle validation for read/write, directory handles/cursors | Existing authority operations, outside bulk listing admission |

Searched every production caller of `listWorkspaceFiles` and `inspectAidenFilesystemIdentity`. The only remaining bulk identity loop is the approved-root workspace picker listed above, deliberately excluded from this file-snapshot scope. This is not a process-wide syscall cap. Both native Bot Files models retain their generic error handling and opaque DTO validation; no route or wire changes are required.


Fresh independent Astra medium caller/blast-radius review cleared the Bot follow-up; its43 tests passed with1 existing Linux-only skip. The CLI inventory omission it identified is corrected above. Final local reruns: full Remote537 passed/1 skipped; Android55 tests passed across workspace, Remote client and Bot contracts; iOS13 simulator tests passed (workspace11 plus Bot routes and scoped-grant revocation). TypeScript and scoped ESLint passed. Paginated recheck of38 other open PRs found no overlap in the Bot/identity/helper follow-up files (#85:295 files, #37:209). Latest-head hosted checks and bot re-review remain separate gates after push.
