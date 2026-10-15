# MCP and Plugins remediation (Pi 1.2.0 parity)

Status: Active (2026-10-13). Delivered as one twelve-PR stacked series, [#460](https://github.com/sambitcreate/aiden-agent/pull/460)–[#471](https://github.com/sambitcreate/aiden-agent/pull/471); each slice below is one PR, based on the previous one, and they merge in order. Slices with disjoint files are built in parallel waves (2–4, then 5–6, then 7–8), and the stack order follows that.

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

## Release gate

Slice 5 starts enabled MCP servers in the background at app start, and slice 11 is the one that stops stdio servers added outside Aiden from launching until they are approved. Today an enabled stdio server already runs on the next chat turn without approval, so slice 5 alone only moves that earlier; still, no release may be cut from `main` after slice 5 merges and before slice 11 does. Merge the stack in order and release after slice 11 (ideally after slice 12).

## Stack

Each slice lists its scope, the files it owns, and what done means. Slices touching disjoint files may be developed in parallel; commit order follows the stack.

### 1. Plan (this document) — [#460](https://github.com/sambitcreate/aiden-agent/pull/460)

### 2. MCP transport and OAuth correctness (`main/services/mcp*.ts`, `generation-bound-connection-cache.ts`) — [#461](https://github.com/sambitcreate/aiden-agent/pull/461)

- [x] Single-flight refresh-token exchange per server (shared by concurrent 401s across foreground, status, child and Bot clients) and compare-and-delete `invalidateCredentials("tokens")`.
- [x] Never re-send a JSON-RPC request after it was cancelled or timed out (SDK retries after an auth refresh).
- [x] Treat `nextCursor` `undefined`, `null` and `""` as the end of a list (tools and resources); lenient list schemas.
- [x] Accept any JSON value as `structuredContent` (lenient `tools/call` result schema; guard checks `=== undefined`).
- [x] Drop empty `scope=""` from `WWW-Authenticate` challenges; normalise null or empty optional fields in client-registration responses.
- [x] Root-path issuer comparison tolerates a single trailing slash.
- [x] Bound `Client.connect` (SSE `endpoint` wait included) by the connect deadline; `disconnect` awaits an in-flight attempt; no new connection after `closeAll`.
- [x] Stdio servers run in their own process group and the whole group is terminated; stdio env is the SDK default environment plus the server's declared env.
- [x] Remember a 403 `insufficient_scope` challenge scope for the next interactive authorize.
- [x] Per-page `tools/list` timeout.

### 3. Aiden CLI MCP (`packages/cli/src/mcp.ts`, `mcp-config-migration.ts`, `subagent-hosts.ts`) — [#462](https://github.com/sambitcreate/aiden-agent/pull/462)

- [x] Use the shared guarded `callMcpTool` / `listMcpToolInventory` path.
- [x] Cache inventory per connection; credential-independent connection cache key; single-flight connect.
- [x] Connect servers concurrently; keep the error cause.
- [x] `validateMcpServer` checks types before use; `remove` deletes the credential; malformed native `mcp.json` no longer blocks startup.
- [x] Remove dead `child-runner.ts` path.

### 4. Plugins settings robustness (`renderer/components/settings/*`, renderer queries, bad-preset handling in `main/handlers/phase2.ts`) — [#463](https://github.com/sambitcreate/aiden-agent/pull/463)

- [x] Save, Remove, Toggle and Reset surface errors; Toggle has a pending state.
- [x] A bad preset record no longer breaks the directory; list and preset errors render with Retry.
- [x] Bot-side setup invalidates `mcpServers` and `mcpPresets`; external config change invalidates presets.
- [x] Arguments are edited one per line (no whitespace splitting).
- [x] Accessibility and layout fixes (row-specific labels, container-width grid, SSE deprecation hint).
- [x] Replace source-grep Plugins tests (`mcp-settings.test.tsx`, `mcp-preset-icons.test.ts`) with rendered behavioural tests.

### 5. MCP latency and caching (`mcp.ts`, `llm-client.ts`, `mcp-tool-inventory.ts`, `mcp-credential-cleanup.ts`, `mcp-oauth-store.ts`) — [#464](https://github.com/sambitcreate/aiden-agent/pull/464)

- [x] Prewarm enabled servers (app ready, server save/enable, sign-in, API key, Reset connections). Chat-focus prewarm not done: the TTL cache and warm connections already cover a focused chat.
- [x] With codemode/`tool_search` available, start the turn with servers that are ready (or have a cached inventory) within a short window; late servers become callable once discovered, and tool search waits for them.
- [x] Short TTL inventory cache for servers without `tools.listChanged`; drop it on reconnect.
- [x] Negative cache (30–60 s) for servers that just failed; cleared by save, reconnect and Reset connections.
- [x] Per-server admission queue instead of one global tail.
- [x] In-memory OAuth session cache in `mcpOAuthStore`, invalidated on write.
- [x] Cache built `AgentTool` arrays per client generation.

### 6. Bots and schedules (`bot-*`, `schedule-mcp-binding.ts`, `bot-tool-sources-main.ts`) — [#465](https://github.com/sambitcreate/aiden-agent/pull/465)

- [x] Bot MCP scopes are cached per connection snapshot and credential incarnation, reuse the manager's inventory, and invalidate on configuration change and `tools/list_changed`.
- [x] A slow server no longer revokes scopes from servers that finished; last good scope survives a short grace window; per-server failures reach diagnostics.
- [x] `suggest_connection` reports connected only when the server is ready (credentials present), matching the renderer.
- [x] Schedule and Bot fingerprints exclude display name and description, and the prompt wording matches the server-level approval that is enforced (a tool-inventory digest was rejected: every server update would silently break schedules).

### 7. Model-facing MCP surface (`pi-codemode.ts`, `pi-tool-discovery.ts`, `mcp-tool-identity.ts`, `mcp-tool-result.ts`, `mcp-server-instructions.ts`, `mcp-resources.ts`, system prompt) — [#466](https://github.com/sambitcreate/aiden-agent/pull/466)

- [x] Codemode-nested MCP calls get a large script budget; the 32K cap applies only to model-facing text; omitted `structuredContent` is marked.
- [x] New tool naming (see Decisions); `describeTool` accepts identifier forms.
- [x] Ranked tool search (tokenised, stop words, OR scoring) and server-name namespace aliases.
- [x] Bounded `mcp_servers` system prompt section with one line per server, appended as a section patch on change; full instructions move behind `describeNamespace`; no tool-name arrays in the prompt.
- [x] Codemode declarations carry an MCP result `outputSchema` (`content`, `structuredContent`, `isError`).
- [x] Head-and-tail truncation; no duplicate structured JSON when a text block already carries it; resource reads truncate instead of failing; resource listing pages instead of failing above 128; tool-count overflow degrades instead of disabling codemode.
- [x] Direct declarations cap descriptions and fall back to `title`; activity labels read `server/tool`.
- [x] Child read lane keeps `structuredContent` with credential redaction.

### 8. OAuth controls and live status (`main/handlers/phase2*.ts`, `mcp-oauth*.ts`, preload, Settings) — [#467](https://github.com/sambitcreate/aiden-agent/pull/467)

- [x] Test connection and Authorize no longer persist an unsaved server.
- [x] `mcp:cancelAuthorize` and `mcp:signOut`; Cancel button; real authorization status.
- [x] Remove, Disable and Rename list dependent schedules and Bots.
- [x] Live per-server status (`mcp:statusChanged` push), tool/resource badges.

### 9. Exposure controls (config, runtime, Settings) — [#468](https://github.com/sambitcreate/aiden-agent/pull/468)

- [x] `exposure` (`auto` / `direct` / `hidden`) and per-tool hidden list on `McpServer`, validated in parse and portable config.
- [x] Foreground, Assistant, Bot and child paths honour it.
- [x] Settings row control and per-tool list.

### 10. Cleanup and catalog — [#469](https://github.com/sambitcreate/aiden-agent/pull/469)

- [x] Delete dead code (`mcpAgentToolResult`, `createNoRedirectFetch`, stale client version). `McpToolListCache` went in slice 5.
- [x] Replace source-grep MCP tests with behavioural tests.
- [x] Dev-only `npm run plugins:refresh` and catalog invariant tests.

### 11. Credential hygiene for custom servers (config store, `mcp.ts` transport, Settings) — [#470](https://github.com/sambitcreate/aiden-agent/pull/470)

- [x] Env and header values of custom servers move to the keychain (config.json keeps names + markers) and are masked in Settings; externally added stdio servers need first-run approval.
- [x] Servers switched off for the model are excluded from schedule pickers and `schedule_task`; an approved schedule bound to one fails with a clear reason.

### 12. Pi 1.2.0 lockstep upgrade — [#471](https://github.com/sambitcreate/aiden-agent/pull/471)

- [x] Root and CLI pins to 1.2.0 (`pi-ai`, `pi-agent-core`, `pi-codemode`, `pi-durable`, `chord`, `pi-coding-agent`, `pi-mcp`); drop the CLI `chord` dependency if unused.
- [x] `before_agent_start` union (`session-parity.ts`), `deliverAs` on `/attach`, `pi-durable` `output` rename, patch anchors (`SETTINGS_DEFAULTS.enableInstallTelemetry`, `PI_AI_VERSION`), theme `$schema` URL, reject `+`/`-`-prefixed server names.
- [x] Pi upgrade evaluation and CLI suites.

## Validation

Each slice runs `npm run test:mcp` plus the suites for the surfaces it touches, `npm run type-check`, and `npm run lint`. Slices touching the CLI run `npm run test:cli` and `npm --prefix packages/cli run type-check`. The whole stack must be green on hosted CI at each PR's exact head.
