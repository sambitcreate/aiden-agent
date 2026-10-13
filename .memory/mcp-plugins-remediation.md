# MCP and Plugins remediation stack — 2026-10-13

Plan: `docs/plans/mcp-plugins-remediation-plan.md`. Origin: five read-only audits comparing Aiden's MCP stack with Pi 1.2.0 (`/Users/sambitbiswas/projects/opp/pi`).

Key facts established by the audit:
- Desktop and Aiden-managed CLI MCP both run on `@modelcontextprotocol/sdk` 1.30.0; `pi-mcp` is declared by the CLI but unused. The CLI also loads Pi's built-in MCP extension (native `mcp.json`, plaintext `mcp-auth.json`) next to Aiden's `aiden-mcp.json`.
- Every chat turn awaits `collectMcpAgentTools` (all enabled servers, up to 17 s each); every Bot tool call re-inspects every server with a fresh client (`inspectConfiguredMcpToolsForBotCatalog`).
- SDK bugs Pi fixed in its own client and Aiden inherited: no single-flight refresh (concurrent 401s can delete freshly saved tokens), cancelled requests re-sent after an auth refresh, `nextCursor: ""`/null rejected, non-object `structuredContent` rejected by `CallToolResultSchema`.
- Pi 1.2.0 breaking changes that touch Aiden: `before_agent_start` union (`session-parity.ts`), `pi-durable` `ToolExecutionResult.output`, patch anchor `enableInstallTelemetry` moved to `SETTINGS_DEFAULTS`, theme schema URL. pi-codemode 1.0.3 can crash the main process on a built-in-patching script (fixed 1.0.4).

Status: plan committed; slices are implemented by Opus 5.5 medium subagents, reviewed and committed by the orchestrating session.

Slice 6 (Bots and schedules), implemented 2026-10-13:
- `createBotMcpScopeCache` (bot-mcp-inventory.ts): per-server scope cache keyed by server id + Bot connection fingerprint, fenced by `botRuntimeInventoryLeases.revision()` (CLI: its own lease registry); 60 s TTL, single-flight per key with its own 10 s inspection deadline, 5 min last-good grace for the same fingerprint. Identities (credential signature + incarnation reconcile) are still recomputed on every snapshot, so revalidation detects config/credential changes.
- Discovery keeps finished servers on deadline; per-server failures go to diagnostics (`mcp-degraded`, `phase: bot-inventory`, no server id).
- `mcpAuthorityConnectionSnapshot` (= credential snapshot: no name/description/enabled) backs Bot fingerprints, the Bot MCP credential signature, schedule bindings, and the CLI `mcpCredentialSignature` (now incarnation-based, never token values). Schedule bindings still accept the legacy runtime-snapshot digest until the server changes. Existing Bot grants re-approve once (formula change).
- `suggest_connection`/connect-card "connected" = renderer rule (own preset, valid, enabled, key or OAuth tokens); Composio-covered apps never report connected.
- Not done here: reuse of the manager's live inventory, `tools/list_changed` invalidation, schedule tool-inventory digest.

## Slice 5: MCP latency and caching (2026-10-13)

- Codemode-lane turns (`workspaceCodemodeEnabled` in llm-client, shared by the pre-discovery deferral decision and the extension composition) admit MCP servers ready within 1.5 s (`admitMcpServerDiscovery`); slower servers join `McpLateDiscovery` within their own 17 s budget. Late tools reach the harness through `lateDeferredTools` (snapshotted once per tool object, duplicates ignored, never declared). `tool_search` and codemode scripts that search/list or reference an unknown `tools.<name>` wait on `settled(signal)` first. Late servers never add prompt instructions. Strict (scheduled) runs and non-codemode turns keep blocking discovery.
- `createMcpToolInventoryCache({ ttlMs })`: desktop uses 30 s for servers without `tools.listChanged`; the CLI still calls it without a TTL (unchanged). Closing a client forgets its entry. Calls after an idle reconnect go through `callMcpToolOnLiveClient`, which checks the live client's own inventory (unknown tool fails before dispatch).
- `McpRecentFailures` (45 s, per connection generation) skips a server that just failed (diagnostic `failurePhase: mcp-recent-failure`, `backoffMs`); strict runs bypass it; disconnect/forget/closeAll clear it; a late success clears it.
- `McpBuiltToolsMemo` reuses MCP AgentTool objects while client, inventory object, server id/name/description, and lease are unchanged. The resource tool is still built per turn (it caches its own listing). The harness's `snapshotAgentTool` still clones parameters per harness, so pi-ai's validator WeakMap still misses across turns.
- `withConfiguredMcp` admission is per server (`createMcpAdmissionQueue().shared`), mutations stay exclusive and wait for in-flight admissions. `McpPendingJournalState` skips the journal read once this process knows it is empty.
- `mcpOAuthStore.get` serves decrypted sessions from memory (invalidated around every mutation, stale in-flight reads discarded) and throws `McpOAuthCredentialStorageError` for unreadable storage instead of `{}`; `hasOAuthTokens` maps it to false, re-authorize starts fresh. `bot-capability-credential-signatures.ts` (Bot lane) now sees the throw.
- Bot catalog and provider-auth connects are bounded by `connectMcpWithinDeadline` (10 s, client closed on timeout/abort).
- Prewarm (`prewarmMcpServers`): app ready, mcp:save, mcp:authorize, mcp:setPresetKey (when set), mcp:reconnect.
