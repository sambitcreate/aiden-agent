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

## #302 `codex/pi-1-integrations`

- **PR-302-1:** `executeNestedToolCall` keeps a per-parent running total of
  retained nested-argument bytes (`nestedRetainedBytes`, cleared with
  `nestedCalls` at the parent's `message_end` and at `agent_end`) instead of
  re-stringifying every prior call; it searches the transcript backwards in
  place and uses the fresh `getCallableTools()` array directly. Budget test:
  "nested call arguments are retained within per-call and per-script budgets …".
- **PR-302-2:** the codemode "Additional codemode images omitted" notice is
  one-shot (it was emitted for every image past the fourth). Kept on purpose:
  per-execute tool definitions (they close over that execute's counters), both
  `allSettled` waits, and host re-validation of VM images (untrusted copies).
  Note: the VM's own `image()` base64 regex runs out of regexp memory on
  multi-MB strings, so the 8 MiB host byte limit is rarely reachable.
- **PR-302-3:** `mcp.ts` builds one frozen discovery record per server (one
  sha256) shared by all its tools; the harness snapshots tool inventories with
  one shared clone map so sharing survives `cloneAndDeepFreeze`;
  `pi-tool-discovery.ts` caches validation for frozen records (WeakMap) and
  compares namespace records field by field. Inventory authority (`tools()` /
  `isCallable`) is still read on every call. The audit's "4 MB of duplicated
  strings" was overstated (V8 shares string values); the real cost was
  per-tool objects, hashes, and per-search validation/stringify.
- **PR-302-4 / X-1:** `main/services/bounded-json.ts` `copyBoundedJson` (node,
  depth, size bounds; `utf8Size` or `worstCaseJsonSize` measure) replaces the
  copies in `pi-tool-discovery.ts` `copySchema` and `mcp-tool-result.ts`
  `structuredContent`. #303's `jsonObject` should use it too (PR-303-1).
  Suite: `bounded-json.test.ts` (in `test:compaction`).
- **PR-302-5:** `mcp-tool-result.ts` `hasCanonicalPadding` replaces the
  decode→re-encode roundtrip (char before `==` ∈ `AQgw`, before `=` ∈
  `AEIMQUYcgkosw048`).
- Not done (by instruction): splitting #302. Suggested split: (a) codemode +
  tool discovery + nested calls, (b) MCP OAuth + MCP image results,
  (c) OpenAI provider login + its onboarding tile.

## #301 `codex/pi-1-compaction`

- **PR-301-1:** `renderer/shared/compaction.ts` exports
  `DEFAULT_COMPACTION_RESERVE_TOKENS` / `DEFAULT_COMPACTION_KEEP_RECENT_TOKENS`
  (the renderer cannot import pi); `pi-compaction-core.test.ts` asserts they
  equal pi's `DEFAULT_COMPACTION_SETTINGS`. Settings copy/placeholders use them.
- **PR-301-2 (verified real):** a keepRecent-only override resolved a reserve of
  16,384, which replaced the model-derived request reserve (≈8k on a 32k
  window) and shrank the input budget. `configuredCompactionReserveTokens`
  returns the bounded reserve only when `reserveTokens` is set; llm-client,
  child-agent-runtime and context-pressure use it for the input budget, while
  pi's compaction settings still get the full resolved budget.
- **PR-301-4:** `configStore.getCompactionSettings()` memoizes the parsed
  engine + overrides on the settings DataStore's cached-document identity (the
  store replaces that object on every write/reload). Context pressure uses it.
- **PR-301-5:** `settings:setCompactionModelBudget` merges/clears one model
  inside the settings mutation (no get→set lost update; refuses to overwrite an
  invalid hand-edited map). Memory page reads Codex models from the query cache
  (`enabled: false`) instead of a focus-refetching auth-status query, and
  memoizes suggestions.
- **Deferred PR-301-6 / X-7** ("Context & caching" section + model picker):
  spans #301 and #304's prompt-cache controls, needs a new settings nav entry,
  e2e navigation updates and a picker component — not a contained change.
