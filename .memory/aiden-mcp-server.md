# Aiden MCP server for outside apps (W4a, 2026-11-11)

Core only: a loopback MCP server that lets Claude Code, Codex or any MCP client use Aiden's chats. Ported in spirit from T3 Code PR #33196 (no code copied). Off by default, with no Settings UI yet (W4b) and no `aiden serve` wiring (W4c). User docs: `docs/aiden-mcp-server.md`; threat model section 10 of `docs/security/aiden-remote-threat-model.md`. README and PRODUCT.md make no claims until W4b ships.

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

## Open for W4b and W4c

- W4b: the Settings UI and IPC over the five main exports, plus a "Started by" label from provenance (nothing reads it yet).
- W4c: `packages/cli` has no `@modelcontextprotocol/sdk` dependency and no MCP host wiring in `aiden serve`.
