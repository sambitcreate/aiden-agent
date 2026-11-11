# Aiden MCP server for outside apps (W4a, 2026-11-11)

A loopback MCP server that lets Claude Code, Codex or any MCP client use Aiden's chats. Ported in spirit from T3 Code PR #33196 (no code copied). Off by default. W4a is the core; W4b (2026-11-11, stacked on W4a) adds Settings → Connections → Apps using Aiden, its IPC, the "Started by" label and an onboarding tile; there is no `aiden serve` wiring yet (W4c). User docs: `docs/aiden-mcp-server.md`; threat model section 10 of `docs/security/aiden-remote-threat-model.md`; Settings layout in `docs/settings-design-system.md` (Apps using Aiden). README and PRODUCT.md describe it as macOS and Linux desktop, matching the `mcpServer` capability.

## Layout

- `main/services/aiden-mcp-server.ts`
  - `AidenMcpServer`:
    - a dedicated `http` listener on 127.0.0.1, `/mcp` only
    - each POST builds a fresh SDK `Server` and a stateless `StreamableHTTPServerTransport` with `enableJsonResponse`
    - a response close aborts the call's signal, which `aiden_chat_wait` uses
  - `AidenMcpHost` owns the on/off reconcile, port selection and commit, and issue, list and revoke.
- `main/services/aiden-mcp-tools.ts`
  - `AidenMcpToolRunner` holds the 9 `aiden_*` tools, TypeBox schemas, per-app limits, the `clientRequestId` cache and the run ownership map.
  - It calls the shared `AidenRemoteChatService` and `AidenRemoteStreamService`, the same ones phones use.
- `main/services/aiden-mcp-provenance.ts`
  - The local-only `startedBy {kind:"app", appId, name, startedAt}` log, in `aiden-mcp-chat-provenance.json` under userData, holding the newest 1,000 entries.
  - A failed write is swallowed, so the turn still runs.
- `aiden-remote-state.ts`
  - Device type `agent`, with `AGENT_CAPABILITY_CEILING` (read: `server:read` and `chat:read`; supervised adds `chat:write`), re-applied on every parse.
  - `MAX_AIDEN_REMOTE_AGENT_APPS = 16`.
  - `issueAgentApp`, `listAgentApps`, `mcpServerSettings`, `setMcpServerEnabled` and `commitMcpServerPort`.
  - The `mcpServer {enabled, port?}` setting lives in the Remote state document.
- `aiden-remote-router.ts`: an `agent` token on `/api/aiden/v1` gets 401, like an unknown one.
- `aiden-remote-streams.ts`: added `watch` for the wait tool.
- `aiden-remote-service-main.ts`
  - Builds the host inside the Remote runtime (`runtime.mcp`).
  - `initializeAidenRemoteService` starts the host's reconcile; stop and settle also stop it.
  - Exports `aidenMcpServerStatus`, `setAidenMcpServerEnabled`, `issueAidenMcpApp`, `listAidenMcpApps` and `revokeAidenMcpApp` for W4b's IPC.
- `host-platform-capabilities.ts`: `mcpServer` is darwin or linux.

## Verified behaviour

- **Port:**
  - Release builds use 49400 and the next 7 ports; development builds use 50400 and the next 7.
  - The first port that binds is committed. After that only the saved port is tried, and if it is busy the status is `problem: "port_in_use"`.
- **Requests:**
  - Host must be `127.0.0.1:<port>` or `localhost:<port>`, and any Origin other than the same loopback origin gets 403. No CORS headers are sent, OPTIONS included.
  - A missing or bad token gets 401 with `WWW-Authenticate: Bearer realm="aiden"`.
- **Body limit:**
  - Over 1 MiB, declared or streamed, gets 413.
  - The server drains the rest for up to 5 s and then destroys the socket. Using `connection: close` instead raced the client's upload, and the client saw ECONNRESET in place of the 413.
- **Write tools:**
  - They need `chat:write`, and Read apps do not see them listed.
  - Turns are limited to 10 a minute and 2 concurrent runs per app; an idempotent retry does not count.
  - Waits are at most 55 s and default to 25 s.
- **Reach:**
  - `aiden_workspace_list` and `aiden_chat_start` exclude `noWorkspace` folders and `ASSISTANT_WORKSPACE_ID`.
  - Chat list is regular chats only. `requireOrdinaryChat` refuses by id every chat the list hides (Bot, feature, assistant), via `AidenRemoteChatService.isListedChat`, with the unknown-id answer so existence is not leaked.
  - Assistant and feature chats are still readable and sendable by id, as on phones.
- **No approval tool.** `aiden_chat_wait` returns `waiting_for_approval` or `waiting_for_input` with `approveIn` / `answerIn` set to "Aiden on <computer name>".
- **Revoke:**
  - It runs `revokeAidenRemoteRuntimeDevice`, which denies approvals, cancels runs and closes watchers.
  - It then runs `tools.revokeApp`, which aborts that app's waits with "This app was disconnected from Aiden."
  - A phone or Mac id returns false.
- **Tests:** `main/services/aiden-mcp-server.test.ts` (13 tests, in `test:aiden-remote` and `scripts/ci-test-registry.json`) runs a real registry, streams and chat service over fakes.
  - Its client is `@earendil-works/pi-mcp` `McpClient`. ESLint forbids importing `@modelcontextprotocol/sdk/client*`.
  - A fake generation's finish must check `owner.isDestroyed()` first, because `owner.send` throws after revocation.

## W4b: Settings, IPC and provenance

- `main/handlers/aiden-mcp.ts`: `registerAidenMcpHandlers({handle, owner, service})`, injectable so the test registers it over a real `AidenRemoteStateRegistry`. `owner(event)` throws unless the sender is the active window. Channels `remote:mcpStatus`, `remote:mcpSetEnabled` (boolean only), `remote:mcpIssueApp` (the only channel carrying a credential; revokes the new app if the owner window was destroyed before the answer), `remote:mcpListApps`, `remote:mcpRevokeApp`, `remote:mcpChatProvenance` (`{name, startedAt}`, never the app id). `setEnabled(true)` doubles as retry for `port_in_use` / `start_failed`.
- `renderer/shared/aiden-mcp.ts`: views, parsers, `aidenMcpClientSnippets(url, token)` (export line with single quotes escaped; Claude Code uses `--header 'Authorization: Bearer ${AIDEN_MCP_TOKEN}'`, Codex `--bearer-token-env-var AIDEN_MCP_TOKEN`). `renderer/lib/aiden-mcp.ts`: query keys and `useAidenMcpChatProvenance` (used by `chat-pane.tsx` for the `data-chat-started-by` line).
- `renderer/components/settings/aiden-mcp-settings.tsx`: section id `otherApps` (Connections tab, gated by `SettingsCapabilities.mcpServer`). The credential lives only in the issued sheet's component state, never React Query.
- Onboarding: `otherApps` wide tile in the extend group (`apps-using-aiden-art.tsx`, coral tint), shown only when `visibleOnboardingFeatures(..., {mcpServer})` is true.
- `lastSeenAt` is 0 until the first connect and is updated at most every 5 minutes; a revoked token still authenticates to a device record with `revoked: true`, so the handler test checks `revoked`, not absence.
- Tests: `main/handlers/aiden-mcp.test.ts`, `renderer/components/settings/aiden-mcp-settings.test.tsx` (in `test:aiden-remote`), the onboarding gallery test, and `tests/e2e/aiden-mcp-settings.spec.ts`.
- jsdom pitfall: inside `waitFor`, never `assert.equal(queryByX(...), null)`. A failing assert formats the whole jsdom node and can take minutes, which looks like a hang. Use `assert.ok(node === null)`.

## Open for W4c

- `packages/cli` has no `@modelcontextprotocol/sdk` dependency and no MCP host wiring in `aiden serve`.
