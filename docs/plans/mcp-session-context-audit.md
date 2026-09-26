# Skill and MCP session context — remaining-scope audit

Date: 2026-09-22. Baseline: origin/main `c8c09e0d239dd596a68b7a5d5719d543399d077b`.
Status: Partial. This audit accounts for the original assignment; it does not claim the whole program is complete.

| Item | Classification | Evidence and completion boundary |
| --- | --- | --- |
| Skill model/user invocation policy | Implemented in separate green PR #214 | Latest head `f004cc75` passed verify, Electron E2E and Pullfrog, with no unresolved threads. Not yet on main. Preserve that branch. |
| Lazy skill bodies in model context | Already covered | `skill-tools.ts` loads captured instructions on tool invocation; `formatAvailableSkills` emits summaries. Bounded disk reads and content fingerprints intentionally remain eager during discovery, so this is not lazy disk I/O. |
| MCP advertised capabilities on desktop status | Concrete gap; implemented by this slice | `mcp.ts` previously discarded initialize metadata and unconditionally called tools/list. Status now returns the SDK's capability snapshot, including extensions; discovery failure retains it, failed initialization/revocation returns null, and resources-only servers avoid unsupported discovery. No authority is inferred from this metadata. |
| MCP resources scoped to selected servers | Concrete remaining deliverable | No production listResources/listResourceTemplates/readResource calls exist. `selectedMcpServers` already limits tool discovery to persisted enabled identities. Resource support must add exact selected-server routing, URI/server binding, Bot/scheduled authority, cancellation/lease revalidation, pagination and bounded result tests; a generic resource reader would bypass current positive tool allowlists. This is not an external blocker or an implemented feature. |
| MCP server instructions | Concrete remaining deliverable | No production getInstructions call or server-instruction prompt contribution exists. Completion requires a generation-owned contribution from only the admitted server identities, bounded untrusted content, removal when disabled, and provenance that cannot overwrite host/workspace authority. It must not inject all configured server instructions merely because they connected. |
| Tool/skill refresh between user generations | Already covered with bounded caches | `prepareGeneration` rebuilds allowed tools and reads the workspace registry; registry/discovery have bounded five-second caches and invalidation. `buildAgentTools` re-resolves configured MCP selections. Disabled selections and positive Bot/scheduled allowlists remain authoritative. This is not instant mid-generation refresh. |
| Global/workspace AGENTS instruction refresh per model request | Concrete remaining deliverable | Current main has no production AGENTS.md loader. `buildSystemPrompt` composes fixed host guidance and selected skill summaries; the Pi beforeProviderRequest extension hook patches provider options, not workspace instruction content. A safe implementation first needs bounded path/symlink-aware instruction discovery, precedence, scope/permission rechecks and context-budget tests, then an atomic prompt-only update at the model-request boundary. No external blocker is claimed. |
| In-place mutation of active tool sets | Intentionally excluded | Active turns own captured tools and extension snapshots. Refreshing tools during execution would violate the assignment's immutable in-flight-set requirement. Any future refresh must stage a new admitted generation snapshot. |
| MCP result spill storage / provider upgrades | Explicitly excluded ownership | Result storage belongs to the deliverables lane; provider dependency upgrades are excluded by assignment. |

## This slice's validation and product boundary

Desktop Settings `mcp:status` is the only consumer of the changed status contract. No remote REST/SSE schema, transcript/activity representation, or native-client behavior changes. iOS/Android do not consume this status type. No new first-run setup, model traffic or runtime capability is added, so onboarding and the feature-tour gallery are unchanged. The existing Settings test toast retains its failure behavior if tools/list fails; advertised metadata is diagnostic, not a success override.

The attempt owner still handles connection teardown and generation invalidation. Capturing capabilities is per initialized client, never a cross-server cache. Status testing does not alter runtime tools, MCP selection, global Skills opt-out or #214 policies.

## Research verification

The dated September 11/15 Notion digests were verified against primary sources:

- Codex commit `7a6f469`, “Expose advertised MCP server capabilities in status responses” — capture initialize metadata independently of tool discovery.
- DeepSeek commits `3ba5b6eb04` and `e08468954a` — scoped resource tools and server instructions require profile/session-specific plumbing, not just an SDK method call.

The implementation is original; no upstream source was copied. See `.memory/mcp-advertised-status.md` for suite/review evidence and exact remaining limits.
