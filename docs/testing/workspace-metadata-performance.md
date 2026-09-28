# Workspace metadata concurrency — 2026-09-28

Baseline a9baa4aa3027893e5455043083465c34b4c8b4ac; branch feature/workspace-metadata-performance. Scoped X06/X07 from the read-only September performance audit. Rechecked complete paginated file lists of all 36 open PRs: #85 has 295 files, #37 has 209. Neither owns workspace-files.ts or legacy aiden-remote-files.ts. Inspected #85's related llm-client changes; no llm-client change is needed here.

## Implementation and limits

- Desktop Files and eligible Gemini preparation share the existing fresh recursive index. Metadata now runs in batches of at most four, bounded by remaining entry capacity. Commit results in enumeration order; preserve breadth-first selection, numeric final ordering, 4,000 entries, depth20, skip counters and symlink treatment. A pre-aborted index does no filesystem work.
- Legacy Remote listing still separately inspects every identity. Four claims checks may overlap, then handles issue serially in index order after cancellation is checked. Cancellation/stat failure drains the batching layer before returning. Capacity keeps the existing 429 response; omission, expiry, device/workspace/revision checks and read/write validation remain intact. No new file content reads or open handles.
- No completed-index cache, in-flight deduplication, or authority metadata reuse. Sizes and timestamps contribute to Gemini's exact snapshot, and external writes/renames/root replacements must be visible on the next request. Total stat/identity work is unchanged: this reduces serial wait time, not repeated-work counts. Fresh traversal, directory materialization/sorting, and Gemini's awaited preparation remain. The secure native lazy path and non-Mac fallback are unchanged.
- Concurrency is per operation, not global. Index metadata remains non-atomic. Existing nested identity realpath Promise.all behavior is unchanged; batch draining does not claim every failed helper's sibling syscall has settled.

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
