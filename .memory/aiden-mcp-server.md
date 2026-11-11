# Aiden MCP server for outside apps (W4a, 2026-11-11)

Core only: a loopback MCP server that lets Claude Code, Codex or any MCP client use Aiden's chats. Ported in spirit from T3 Code PR #33196 (no code copied). Off by default, with no Settings UI yet (W4b); `aiden serve` hosts it too (W4c, below). User docs: `docs/aiden-mcp-server.md`; threat model section 10 of `docs/security/aiden-remote-threat-model.md`. README and PRODUCT.md make no claims until W4b ships.

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
  - Turns are limited to 10 a minute and 2 concurrent runs per app; an idempotent retry does not count, even after the 128-entry request cache forgets it or a restart (`AidenRemoteChatService.hasRecordedRequest` checks the durable ledger before admission).
  - MCP app chats and turns send no `chat_created` / `chat_message_sent` (`deviceReportsAnalytics` is false for `agent` devices).
  - Waits are at most 55 s and default to 25 s.
- **Reach:**
  - `aiden_workspace_list` and `aiden_chat_start` exclude `noWorkspace` folders and `ASSISTANT_WORKSPACE_ID`.
  - Chat list is regular chats only. `requireOrdinaryChat` refuses by id every chat the list hides (Bot, feature, assistant), via `AidenRemoteChatService.isListedChat`, with the unknown-id answer so existence is not leaked.
  - Phones can still read and send to assistant and feature chats by id; MCP apps cannot.
- **No approval tool.** `aiden_chat_wait` returns `waiting_for_approval` or `waiting_for_input` with `approveIn` / `answerIn` set to "Aiden on <computer name>".
- **Revoke:**
  - It runs `revokeAidenRemoteRuntimeDevice`, which denies approvals, cancels runs and closes watchers.
  - It then runs `tools.revokeApp`, which aborts that app's waits with "This app was disconnected from Aiden."
  - A phone or Mac id returns false.
- **Tests:** `main/services/aiden-mcp-server.test.ts` (13 tests, in `test:aiden-remote` and `scripts/ci-test-registry.json`) runs a real registry, streams and chat service over fakes.
  - Its client is `@earendil-works/pi-mcp` `McpClient`. ESLint forbids importing `@modelcontextprotocol/sdk/client*`.
  - A fake generation's finish must check `owner.isDestroyed()` first, because `owner.send` throws after revocation.

## Headless server (W4c, 2026-11-11)

`aiden serve` hosts the same endpoint, and `aiden apps list|connect|revoke|on|off` manages it.

- **Wiring:**
  - `packages/cli/src/apps.ts` has `createCliMcpHost` and `cliAppsCommand`.
  - `packages/cli/src/apps-display.ts` holds the connect rendering, the snippets and `CLI_MCP_DEFAULT_PORT`. It has type-only imports, so the admin client never loads the SDK.
  - The SDK is pinned at `@modelcontextprotocol/sdk` 1.32.1 in `packages/cli/package.json`, the desktop pin.
- **Inside the Remote runtime.** `createCliRemote` builds the host:
  - The chat runtime is shared through a memoized `loadChatApi` (a failed load is retried).
  - MCP gets its own cached `AidenRemoteWorkspaceService`, so it never rebuilds Remote's host feed.
  - `revokeDevice` is the one shared path that drains feeds, runs and Bot sessions and calls `revokeAidenRemoteRuntimeDevice`; `remote revoke` uses it too.
  - `start()` calls `mcp.initialize()` after Remote is up, and a failure only logs. `stop()` stops MCP first.
  - `--no-remote` means no MCP server: `serve.ts` refuses `apps` with a restart hint.
- **Port.** 49500–49507 (`CLI_MCP_DEFAULT_PORT`), a +100 shift from the desktop's 49400, mirroring Remote's 49220 → 49320. It is saved in `remote.json`. Tests pass `mcpPort: 0`.
- **Off by default.** `connect` calls `setEnabled(true)` before `issueApp`, so a failure to enable never loses a just-issued token. An argument error refuses before either step. The default access is Read.
- **Connect output.** On a TTY, `commands.ts` renders text with the token once and `claude mcp add --scope user --transport http aiden <url> --header 'Authorization: Bearer ${AIDEN_MCP_TOKEN_<NAME>_<ID>}'` / `codex mcp add aiden --url <url> --bearer-token-env-var AIDEN_MCP_TOKEN_<NAME>_<ID>`, the per-app name from core's `aidenMcpTokenEnvName` (renderer/shared/aiden-mcp-token-env.ts), the same one W4b's Settings sheet prints. Piped output is JSON plus a stderr warning, like pairing.
- **Analytics.** `remote-chats.ts` passes `deviceReportsAnalytics` (false for `agent` devices), matching the desktop. `aiden apps` sends nothing.
- **Docker.** Container loopback is unreachable from the host, which is documented. MCP without Remote would be a possible follow-up.
- **Tests.** `packages/cli/tests/mcp-apps.test.mjs` (in the CLI `test` script; the registry covers it through `test:cli`):
  - spawned `aiden serve` end to end: off by default, connect, 401s, Read tools, a real chat through a fake provider, provenance, revoke, off/on, and the port across a restart
  - in-process refusals and a phone id
  - `--no-remote`
  - the snippets never carrying the token

## Open

- W4b: the Settings UI and IPC over the five main exports, plus a "Started by" label from provenance (nothing reads it yet).
