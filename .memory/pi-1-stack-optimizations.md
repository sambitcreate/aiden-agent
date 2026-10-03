# Pi 1.0 stack optimization pass (2026-10-03)

Follow-up fixes from the 2026-10-03 optimization audit, applied on each stacked
PR's own branch (#299 → #302 → #301 → #304 → #303 → #306 → #305 → #307) after
merging `origin/main` into #299 and cascading each parent into its child.

## #299 `codex/pi-1-runtime`

- **PR-299-1:** `packages/cli/src/mcp-config-migration.ts` peeks at `mcp.json`
  before taking the `aiden-mcp.json` lease. A missing file or a native pi config
  object (not an Aiden server array) returns without locking, so `storeFor()`
  reads (`aiden mcp list`, schedule saves, subagent inventory, CLI startup) no
  longer throw "Another Aiden process owns …" beside another process's writer.
  Real migrations still re-read and validate under the lease. Covered by
  `packages/cli/tests/parity.test.mjs` ("MCP reads stay available …").
- **PR-299-2:** the `@aiden/pi-legacy-harness` alias (pi-agent-core 0.87.1)
  nested a second pi-ai 0.87.1 plus openai 6.40.0 (16 MB) and @google/genai
  2.21.0 (11 MB). A root `overrides` entry scoped to `@earendil-works/pi-ai@0.87.1`
  now resolves those two SDKs to the hoisted openai 7.19.0 / @google/genai 2.24.0
  (alias tree 40 MB → 13 MB). Safe because the legacy boundary
  (`main/services/pi-legacy-harness.ts`) exposes no provider factories or
  streams; importing it loads pi-ai's core but never openai or genai (verified
  with a module-resolve probe). The legacy pi-ai 0.87.1 itself stays: pi-ai 1.0
  changes the estimation/normalization semantics the frozen journal and
  compaction boundary depends on, so dropping it needs a replay evaluation.
  If a future change exposes legacy provider code, remove the override first.
