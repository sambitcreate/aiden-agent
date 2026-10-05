# Pi 1.0.3 runtime upgrade

Aiden's desktop and standalone CLI now use exact Pi 1.0.3 packages. The integrated upgrade includes permissioned Tool Scripts, deferred MCP tool discovery with complete bounded inventories, image generation and classification, opt-in local classification, foreground cache warming, provider-authenticated MCP connections, and per-model compaction budgets.

## Existing data

- Built-in Azure moves from `azure-openai-responses` to `azure`. The API identifier and `AZURE_OPENAI_*` environment variables are unchanged. Existing chats, schedules, selections, pins, visibility, thinking preferences and compaction budgets resolve the new identity. Explicit custom provider routes still win.
- Encrypted credentials migrate atomically before use. If both identities exist, the current Azure credential remains active and the legacy ciphertext is retained in `retiredAzureCredential` for recovery. That entry is never offered as an account and cannot reappear after logout. Cached catalogs prefer the current entry.
- CLI migration respects `AIDEN_CODING_AGENT_DIR`, global model/settings/cache files, and project `.aiden/settings.json`. A collision between different model endpoint configurations stops with a reconciliation error instead of overwriting either endpoint. A legacy endpoint also stops if both credential identities (including retained collision recovery data) exist, preventing a new credential from being paired with the old endpoint. API identifiers inside model definitions are preserved. Auth migration uses the encrypted CLI store and its existing writer lease.
- Existing Bot grants bind exact provider identities and credential fingerprints. They are deliberately not rewritten into new authority. An Azure Bot binding that becomes unavailable must be selected and authorized again by its owner; ordinary historical chats and schedules use the shared alias resolver.
- The named `@aiden/pi-legacy-harness` remains on 0.87.1 for journal, summary and legacy compaction compatibility. This is explicit compatibility debt, not a second live inference stack.

## Client behavior

Per-thinking-level sampling is supported for custom models through portable `customModelOptions.<model>.samplingParamsByThinkingLevel`. Allowed levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; allowed finite numeric parameters are `temperature`, `top_p`, `top_k`, `min_p`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`, and `seed`. Values have an absolute bound of 1,000,000; provider-specific ranges remain the provider's responsibility. Request fields such as messages, tools and model IDs cannot be overridden through sampling metadata. The same bounded field survives remote catalog normalization. Built-in Pi model behavior is inherited from the pinned package.

Pi's sandbox output caps are enforced before Aiden's smaller display limits. The CLI's codemode worker is a standalone bundle because Pi 1.0.3 snapshots it into a data URL. Other CLI workers and OAuth modules retain the shared chunk graph. The CLI inherits Pi's codemode image temp-file behavior; desktop keeps validated inline raster output and its private artifact lifecycle instead of exposing Pi temp paths.

Desktop and Aiden-managed CLI MCP connections retain the official MCP SDK's OAuth contract, metadata overrides, client names, encrypted sessions and provider grants. Pi's changed `clientMetadataDocument(metadata)` API belongs to native Pi MCP. **Desktop/Aiden-managed CIMD configuration is deferred:** Aiden does not yet publish a client metadata document with its own registered redirect URIs. Do not substitute Pi's identity or rename official SDK methods. Native `aiden pi-mcp` inherits Pi 1.0.3 behavior. A future CIMD change must bind the document URL and callback identity into credential invalidation and test both authorization-server support and DCR fallback.

Project `mcp.json` overrides remain native Pi CLI functionality. Desktop/Aiden-managed MCP stays in its existing owner-managed registry: automatic project overrides would change the reviewed server/credential authority. `pi-env` is evaluation-only; see project memory. No pi-durable journal migration, Chord transport, virtual models, or native-port replacement is included.

## Validation boundary

Local replay, types, builds, behavioral suites, CLI worker tests, Electron UI tests, and focused native suites are recorded in the execution plan and PR. Merge requires green hosted CI on the exact PR head. Signed installed-candidate evaluation, physical-device acceptance, live paid-provider calls, and rollout advancement remain release gates; this change does not claim those results or advance rollout.
