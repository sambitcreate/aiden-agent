# MCP and Plugins remediation stack — 2026-10-13

Plan: `docs/plans/mcp-plugins-remediation-plan.md`. Origin: five read-only audits comparing Aiden's MCP stack with Pi 1.2.0 (`/Users/sambitbiswas/projects/opp/pi`).

Key facts established by the audit:
- Desktop and Aiden-managed CLI MCP both run on `@modelcontextprotocol/sdk` 1.30.0; `pi-mcp` is declared by the CLI but unused. The CLI also loads Pi's built-in MCP extension (native `mcp.json`, plaintext `mcp-auth.json`) next to Aiden's `aiden-mcp.json`.
- Every chat turn awaits `collectMcpAgentTools` (all enabled servers, up to 17 s each); every Bot tool call re-inspects every server with a fresh client (`inspectConfiguredMcpToolsForBotCatalog`).
- SDK bugs Pi fixed in its own client and Aiden inherited: no single-flight refresh (concurrent 401s can delete freshly saved tokens), cancelled requests re-sent after an auth refresh, `nextCursor: ""`/null rejected, non-object `structuredContent` rejected by `CallToolResultSchema`.
- Pi 1.2.0 breaking changes that touch Aiden: `before_agent_start` union (`session-parity.ts`), `pi-durable` `ToolExecutionResult.output`, patch anchor `enableInstallTelemetry` moved to `SETTINGS_DEFAULTS`, theme schema URL. pi-codemode 1.0.3 can crash the main process on a built-in-patching script (fixed 1.0.4).

Status: plan committed; slices are implemented by Opus 5.5 medium subagents, reviewed and committed by the orchestrating session.
