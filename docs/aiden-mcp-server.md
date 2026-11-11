# Aiden MCP server

Aiden can act as a [Model Context Protocol](https://modelcontextprotocol.io) server, so another app on the same computer (Claude Code, Codex, or any MCP client) can list Aiden's workspaces and chats, read them, and, with permission, start and follow Aiden turns.

Status (2026-11-11): the server core is in the desktop main process, behind the `mcpServer` host capability (macOS and Linux desktop; see `main/services/host-platform-capabilities.ts`). It is **off by default**. The Settings screen for turning it on and connecting apps is still to come (workstream W4b), and so is a headless `aiden serve` counterpart (W4c). Until those ship, the only way to turn the server on or issue an app is through the main-process functions listed under [Main-process API](#main-process-api).

## How an app connects

- **Transport:** stateless MCP Streamable HTTP. Each POST is a whole JSON-RPC exchange, answered as JSON. There are no sessions, no server-sent events and no `GET` stream.
- **Address:** `http://127.0.0.1:<port>/mcp`, loopback only. The server is a dedicated listener and is never served on the Remote Access LAN TLS listener, Tailscale or any other interface.
- **Port:**
  - Release builds try 49400 first, then the next seven ports up. Development builds start at 50400.
  - The first port that binds is saved in Aiden's Remote state file, so the URL stays the same across restarts and an app's configuration keeps working.
  - If another program later holds the saved port, the server reports `port_in_use` rather than moving, because moving would break every configured app silently.
- **Credential:** each app gets its own bearer token, a 43-character base64url secret shown once when it is issued. Aiden stores only a hash. A token is sent as `Authorization: Bearer <token>`.

Claude Code:

```sh
claude mcp add --transport http aiden http://127.0.0.1:49400/mcp \
  --header "Authorization: Bearer <token>"
```

Codex:

```sh
export AIDEN_MCP_TOKEN=<token>
codex mcp add aiden --url http://127.0.0.1:49400/mcp --bearer-token-env-var AIDEN_MCP_TOKEN
```

Use the port your Aiden reports if it is not 49400.

## Access levels

An app is a Remote device of type `agent`. Its capabilities are set to one of two levels when it is issued. When Aiden loads its Remote state, an app record is stripped of anything beyond the Supervised set, so an edit to the state file cannot widen an app's access:

| Level | Capabilities | Tools |
| --- | --- | --- |
| Read | `server:read`, `chat:read` | `aiden_server_info`, `aiden_workspace_list`, `aiden_chat_list`, `aiden_chat_read`, `aiden_chat_wait` |
| Supervised | Read, plus `chat:write` | Read tools, plus `aiden_chat_start`, `aiden_chat_send`, `aiden_chat_stop` |

An app is never granted `approval:respond`, files, Git, shell, Bots, schedules, settings, devices or pairing. A Read app does not see the write tools in `tools/list`, and calling one anyway is refused.

At most 16 apps can be connected at once, separately from the phone and Mac device limit.

## Tools

| Tool | What it does |
| --- | --- |
| `aiden_server_info` | Aiden's version, the computer's name, and this app's access level. |
| `aiden_workspace_list` | The person's workspaces. It leaves out the folders Aiden makes for a single chat, and the assistant's own workspace. |
| `aiden_chat_list` | Recent ordinary chats, newest first, with a cursor. It leaves out Bot chats, feature chats and assistant chats. |
| `aiden_chat_read` | A chat's recent messages, paged with `before`. |
| `aiden_chat_wait` | Waits up to `timeoutSeconds` (default 25, maximum 55) for a run this app started. Returns `running`, `waiting_for_approval` or `waiting_for_input` (each with `approveIn`/`answerIn`, for example "Aiden on Studio Mac"), `done` with the final reply, or `failed`. It returns early if the app disconnects. |
| `aiden_chat_start` | Starts a new chat in an offered workspace, with optional `providerId`/`modelId`, and sends the first message. Needs a `clientRequestId`. Retrying with the same one returns the same chat and run, and never starts a second turn. |
| `aiden_chat_send` | Sends a follow-up to an existing ordinary chat (also idempotent by `clientRequestId`). |
| `aiden_chat_stop` | Stops a run **this app** started. Another app's runs, and the person's own, cannot be stopped or waited on. |

Arguments are validated against each tool's schema, and unknown properties are rejected. A message can be at most 200,000 characters, and messages read back are capped at 20,000 characters each. Bot chats cannot be read or written by id, even when the id is known.

There is deliberately no tool for approvals or questions. When a turn needs one, `aiden_chat_wait` says so and where, and the person answers it in Aiden on that computer. A turn runs with the permissions of its workspace. In a Full-access workspace, tools run without asking, exactly as if the person had typed the message.

## Limits

- **Turns:** each app can start or send 10 turns a minute and have 2 runs at once. A retry of an accepted `clientRequestId` does not count again.
- **Requests:**
  - A request body over 1 MiB is answered 413 before any tool runs, whether its size is declared or streamed.
  - The server drains the rest of an oversized upload for up to 5 seconds so the app sees the 413, then cuts the connection.
  - A body that is not JSON gets JSON-RPC parse error `-32700`.
- **Connections:** at most 16 at once.

## Threat model

Who could call the server:

- **Other software running as the same user.** It can reach loopback but has no token, so it gets 401. The token check is constant-time over hashes, and a missing, malformed, wrong or revoked token gets the same 401 with `WWW-Authenticate: Bearer realm="aiden"`.
- **A web page in the person's browser.**
  - DNS rebinding is blocked by requiring the `Host` header to be exactly `127.0.0.1:<port>` or `localhost:<port>`, and refusing any `Origin` other than that same loopback origin, with 403.
  - The server sends no CORS headers, `OPTIONS` included, so a page cannot read a response even on a same-machine origin.
- **A phone or paired Mac.** Their Remote credentials are refused on `/mcp`, and an app token is refused on `/api/aiden/v1`, both with 401. The audiences never cross.
- **A connected app that misbehaves.**
  - It is limited to its access level, its own runs, ordinary chats and offered workspaces, and the rate and concurrency limits.
  - It cannot settle an approval or answer a question.
  - A Supervised app can still ask Aiden to do anything the chosen workspace allows without approval, which is why Supervised is a deliberate choice and Full-access workspaces run unattended.

Revoking an app:

- Rejects its token on the next request.
- Ends any `aiden_chat_wait` it has open ("This app was disconnected from Aiden.").
- Stops the runs it started, and denies their pending approvals, through the same revocation path as a phone.

Turning the server off closes the listener and every open connection.

Privacy:

- Aiden keeps a local note of which app started a chat (`startedBy {kind: "app", name}`, in `aiden-mcp-chat-provenance.json`, the newest 1,000 entries). It is never sent to phones, Macs or apps.
- App ids never appear in tool results.
- Server logs carry only `started`, `stopped`, `start-failed` (with a problem code) and `request-failed`, never a token, an app name, a path or chat text.
- No analytics events are sent for the MCP server.

The Remote Access threat model has the matching section: [`docs/security/aiden-remote-threat-model.md`](security/aiden-remote-threat-model.md#10-local-mcp-server-for-outside-apps).

## Main-process API

These are exported from `main/services/aiden-remote-service-main.ts` for the Settings IPC in W4b:

- `aidenMcpServerStatus()` returns `{supported, enabled, running, port?, url?, problem?}`.
- `setAidenMcpServerEnabled(enabled)` turns the server on or off and saves the choice.
- `issueAidenMcpApp({name, access: "read" | "supervised"})` returns `{credential, app}`. The credential is returned only this once.
- `listAidenMcpApps()` lists the connected apps.
- `revokeAidenMcpApp(appId)` disconnects one app. A phone's or Mac's id returns `false`.

Code: `main/services/aiden-mcp-server.ts` (listener, `AidenMcpHost`), `main/services/aiden-mcp-tools.ts` (tools and limits), `main/services/aiden-mcp-provenance.ts`, and agent-app state in `main/services/aiden-remote-state.ts`. Tests: `main/services/aiden-mcp-server.test.ts` (in `npm run test:aiden-remote`).
