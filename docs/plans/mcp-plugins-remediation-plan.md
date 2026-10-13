# MCP and Plugins remediation (Pi 1.2.0 parity)

Status: Active (2026-10-13). Delivered as one stacked PR series; each slice below is one PR, based on the previous one. Slices with disjoint files are built in parallel waves (2–4, then 5–6, then 7 and 9), and the stack order follows that.

## Why

A full sweep on 2026-10-13 compared Aiden's MCP and Plugins surfaces with upstream Pi (`/Users/sambitbiswas/projects/opp/pi`, v1.2.0). Aiden pins every `@earendil-works/*` package at 1.0.3. Neither the desktop nor Aiden-managed CLI MCP uses `pi-mcp`: both run on `@modelcontextprotocol/sdk` 1.30.0 with Aiden's own lifecycle, OAuth and tool layers. The CLI additionally loads Pi's built-in MCP extension next to Aiden's.

OAuth hardening is broadly at parity. The gaps are turn latency (every turn and every Bot tool call waits on MCP), a handful of SDK bugs Pi has fixed in its own client, the model-facing MCP surface (naming, search, server listing, result typing, exposure), the Plugins settings UX, and the Pi 1.2.0 upgrade.

## Decisions

- **Stay on the official SDK for this series.** Fix the bugs in Aiden's fetch policy, transport wrapper and provider. A `pi-mcp` migration (single-flight refresh, per-request send signals, process-group stdio, CIMD for free; no legacy SSE) is a follow-up spike, not part of this stack.
- **Bump `@modelcontextprotocol/sdk` to the latest 1.x** only if the private SSE re-auth seam (`mcp-sse-auth-lifecycle.ts`) and its shape-drift tests still pass; otherwise stay on 1.30.0 and record why.
- **Upgrade Pi to 1.2.0 in lockstep** (root and `packages/cli`), including `pi-durable` 1.2.0. Pre-1.0: the one-way Bot `session.sqlite` migration is accepted.
- **MCP agent tool names** become `<server>__<tool>` with every character outside `[A-Za-z0-9_]` mapped to `_`, and a stable hash suffix only when a name collides or exceeds 64 characters. Authority (Bot grants, schedule bindings, subagent scopes) is keyed on server id plus raw tool name, so no persisted authority migrates. Desktop and CLI change together.
- **Exposure model.** Each MCP server gets an `exposure` of `auto` (default: deferred behind codemode/`tool_search` when available, otherwise direct), `direct`, or `hidden`, plus an optional per-tool hidden list. Bots and the Assistant honour the same setting.
- **CIMD stays deferred.** It needs an Aiden-hosted HTTPS client metadata document. Until that exists the Figma preset keeps its current client name.
- **Plugin catalog refresh is dev-time only** (`npm run plugins:refresh`), never at runtime, matching the models.dev posture.

## Stack

Each slice lists its scope, the files it owns, and what done means. Slices touching disjoint files may be developed in parallel; commit order follows the stack.

### 1. Plan (this document)

### 2. MCP transport and OAuth correctness (`main/services/mcp*.ts`, `generation-bound-connection-cache.ts`)

- [ ] Single-flight refresh-token exchange per server (shared by concurrent 401s across foreground, status, child and Bot clients) and compare-and-delete `invalidateCredentials("tokens")`.
- [ ] Never re-send a JSON-RPC request after it was cancelled or timed out (SDK retries after an auth refresh).
- [ ] Treat `nextCursor` `undefined`, `null` and `""` as the end of a list (tools and resources); lenient list schemas.
- [ ] Accept any JSON value as `structuredContent` (lenient `tools/call` result schema; guard checks `=== undefined`).
- [ ] Drop empty `scope=""` from `WWW-Authenticate` challenges; normalise null or empty optional fields in client-registration responses.
- [ ] Root-path issuer comparison tolerates a single trailing slash.
- [ ] Bound `Client.connect` (SSE `endpoint` wait included) by the connect deadline; `disconnect` awaits an in-flight attempt; no new connection after `closeAll`.
- [ ] Stdio servers run in their own process group and the whole group is terminated; stdio env is the SDK default environment plus the server's declared env.
- [ ] Remember a 403 `insufficient_scope` challenge scope for the next interactive authorize.
- [ ] Per-page `tools/list` timeout.

### 3. Aiden CLI MCP (`packages/cli/src/mcp.ts`, `mcp-config-migration.ts`, `subagent-hosts.ts`)

- [ ] Use the shared guarded `callMcpTool` / `listMcpToolInventory` path.
- [ ] Cache inventory per connection; credential-independent connection cache key; single-flight connect.
- [ ] Connect servers concurrently; keep the error cause.
- [ ] `validateMcpServer` checks types before use; `remove` deletes the credential; malformed native `mcp.json` no longer blocks startup.
- [ ] Remove dead `child-runner.ts` path.

### 4. Plugins settings robustness (`renderer/components/settings/*`, renderer queries, bad-preset handling in `main/handlers/phase2.ts`)

- [ ] Save, Remove, Toggle and Reset surface errors; Toggle has a pending state.
- [ ] A bad preset record no longer breaks the directory; list and preset errors render with Retry.
- [ ] Bot-side setup invalidates `mcpServers` and `mcpPresets`; external config change invalidates presets.
- [ ] Arguments are edited one per line (no whitespace splitting).
- [ ] Accessibility and layout fixes (row-specific labels, container-width grid, SSE deprecation hint).
- [ ] Replace source-grep Plugins tests (`mcp-settings.test.tsx`, `mcp-preset-icons.test.ts`) with rendered behavioural tests.

### 5. MCP latency and caching (`mcp.ts`, `llm-client.ts`, `mcp-tool-inventory.ts`, `mcp-credential-cleanup.ts`, `mcp-oauth-store.ts`)

- [ ] Prewarm enabled servers (app ready, server enable/save, chat focus).
- [ ] With codemode/`tool_search` available, start the turn with servers that are ready (or have a cached inventory) within a short window; late servers become callable once discovered, and tool search waits for them.
- [ ] Short TTL inventory cache for servers without `tools.listChanged`; drop it on reconnect.
- [ ] Negative cache (30–60 s) for servers that just failed; cleared by save, reconnect and Reset connections.
- [ ] Per-server admission queue instead of one global tail.
- [ ] In-memory OAuth session cache in `mcpOAuthStore`, invalidated on write.
- [ ] Cache built `AgentTool` arrays per client generation.

### 6. Bots and schedules (`bot-*`, `schedule-mcp-binding.ts`, `bot-tool-sources-main.ts`)

- [ ] Bot MCP scopes are cached per connection snapshot and credential incarnation, reuse the manager's inventory, and invalidate on configuration change and `tools/list_changed`.
- [ ] A slow server no longer revokes scopes from servers that finished; last good scope survives a short grace window; per-server failures reach diagnostics.
- [ ] `suggest_connection` reports connected only when the server is ready (credentials present), matching the renderer.
- [ ] Schedule and Bot fingerprints exclude display name and description; schedule approval binds a tool-inventory digest, and the prompt wording matches what is enforced.

### 7. Model-facing MCP surface (`pi-codemode.ts`, `pi-tool-discovery.ts`, `mcp-tool-identity.ts`, `mcp-tool-result.ts`, `mcp-server-instructions.ts`, `mcp-resources.ts`, system prompt)

- [ ] Codemode-nested MCP calls get a large script budget; the 32K cap applies only to model-facing text; omitted `structuredContent` is marked.
- [ ] New tool naming (see Decisions); `describeTool` accepts identifier forms.
- [ ] Ranked tool search (tokenised, stop words, OR scoring) and server-name namespace aliases.
- [ ] Bounded `mcp_servers` system prompt section with one line per server, appended as a section patch on change; full instructions move behind `describeNamespace`; no tool-name arrays in the prompt.
- [ ] Codemode declarations carry an MCP result `outputSchema` (`content`, `structuredContent`, `isError`).
- [ ] Head-and-tail truncation; no duplicate structured JSON when a text block already carries it; resource reads truncate instead of failing; resource listing pages instead of failing above 128; tool-count overflow degrades instead of disabling codemode.
- [ ] Direct declarations cap descriptions and fall back to `title`; activity labels read `server/tool`.
- [ ] Child read lane keeps `structuredContent` with credential redaction.

### 8. Exposure controls (config, runtime, Settings)

- [ ] `exposure` (`auto` / `direct` / `hidden`) and per-tool hidden list on `McpServer`, validated in parse and portable config.
- [ ] Foreground, Assistant, Bot and child paths honour it.
- [ ] Settings row control and per-tool list.

### 9. OAuth controls, live status, secrets and approvals (`main/handlers/phase2*.ts`, `mcp-oauth*.ts`, preload, Settings)

- [ ] Test connection and Authorize no longer persist an unsaved server.
- [ ] `mcp:cancelAuthorize` and `mcp:signOut`; Cancel button; real authorization status.
- [ ] Remove, Disable and Rename list dependent schedules and Bots.
- [ ] Secret-looking env and header values move to the keychain and are masked; externally added stdio servers need first-run approval.
- [ ] Live per-server status (`mcp:statusChanged` push), tool/resource badges.

### 10. Pi 1.2.0 lockstep upgrade

- [ ] Root and CLI pins to 1.2.0 (`pi-ai`, `pi-agent-core`, `pi-codemode`, `pi-durable`, `chord`, `pi-coding-agent`, `pi-mcp`); drop the CLI `chord` dependency if unused.
- [ ] `before_agent_start` union (`session-parity.ts`), `deliverAs` on `/attach`, `pi-durable` `output` rename, patch anchors (`SETTINGS_DEFAULTS.enableInstallTelemetry`, `PI_AI_VERSION`), theme `$schema` URL, reject `+`/`-`-prefixed server names.
- [ ] Pi upgrade evaluation and CLI suites.

### 11. Cleanup and catalog

- [ ] Delete dead code (`mcpAgentToolResult`, `McpToolListCache`, `createNoRedirectFetch`, stale client version).
- [ ] Replace source-grep MCP tests with behavioural tests.
- [ ] Dev-only `npm run plugins:refresh` and catalog invariant tests.

## Validation

Each slice runs `npm run test:mcp` plus the suites for the surfaces it touches, `npm run type-check`, and `npm run lint`. Slices touching the CLI run `npm run test:cli` and `npm --prefix packages/cli run type-check`. The whole stack must be green on hosted CI at each PR's exact head.
