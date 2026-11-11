# Aiden MCP server

Aiden can act as a [Model Context Protocol](https://modelcontextprotocol.io) server, so another app on the same computer (Claude Code, Codex, or any MCP client) can list Aiden's workspaces and chats, read them, and, with permission, start and follow Aiden turns.

Status (2026-11-11): the server is in the desktop main process, behind the `mcpServer` host capability (macOS and Linux desktop; see `main/services/host-platform-capabilities.ts`). It is **off by default**. Turn it on and connect apps in **Settings → Connections → Apps using Aiden** ([below](#set-it-up-in-settings)). A headless `aiden serve` counterpart (workstream W4c) is still to come.

## Set it up in Settings

**Settings → Connections → Apps using Aiden** appears only where the `mcpServer` capability is on.

1. Turn on **Let apps use Aiden**. **Add app** stays unavailable until the server has an address, because the token is shown only once and its setup commands need that address. The status beside the switch says **Listening on port N**, **Off**, **Port N is in use** (another program holds the saved port) or **Couldn't start**. For the last two, **Try again** starts the server on the same port once it is free. The **Address** row copies the URL apps connect to.
2. Choose **Add app**, give it a name (up to 80 characters, for example "Claude Code"), and pick **Read only** or **Supervised** ([Access levels](#access-levels)).
3. The next sheet shows the app's token **once**, with copy buttons for the token and for ready-made Claude Code and Codex commands. Each command reads the token from an environment variable named for that app, such as `AIDEN_MCP_TOKEN_CLAUDE_CODE_K3J9QX` (the app's name plus the start of its id), so the client's saved configuration never holds it, and setting up a second app in the same shell profile never replaces the first app's token. Closing the sheet forgets the token; if you lose it, revoke the app and add it again.
4. Each added app is listed with its access level, the day it was added and when it last connected ("Not used yet" until it first does; this is updated at most every five minutes). **Revoke** asks first, then disconnects the app at once.

A chat an app started shows **Started by <app>** under its title in Aiden on this computer.

## How an app connects

- **Transport:** stateless MCP Streamable HTTP. Each POST is a whole JSON-RPC exchange, answered as JSON. There are no sessions, no server-sent events and no `GET` stream.
- **Address:** `http://127.0.0.1:<port>/mcp`, loopback only. The server is a dedicated listener and is never served on the Remote Access LAN TLS listener, Tailscale or any other interface.
- **Port:**
  - Release builds try 49400 first, then the next seven ports up. Development builds start at 50400.
  - The first port that binds is saved in Aiden's Remote state file, so the URL stays the same across restarts and an app's configuration keeps working.
  - If another program later holds the saved port, the server reports `port_in_use` rather than moving, because moving would break every configured app silently.
- **Credential:** each app gets its own bearer token, a 43-character base64url secret shown once when it is issued. Aiden stores only a hash. A token is sent as `Authorization: Bearer <token>`.

Claude Code (the single quotes keep `${AIDEN_MCP_TOKEN_CLAUDE_CODE_K3J9QX}` literal in its saved configuration; Claude Code expands it from the environment when it connects):

```sh
export AIDEN_MCP_TOKEN_CLAUDE_CODE_K3J9QX='<token>'
claude mcp add --transport http aiden http://127.0.0.1:49400/mcp \
  --header 'Authorization: Bearer ${AIDEN_MCP_TOKEN_CLAUDE_CODE_K3J9QX}'
```

Codex:

```sh
export AIDEN_MCP_TOKEN_CODEX_P7QD2M='<token>'
codex mcp add aiden --url http://127.0.0.1:49400/mcp --bearer-token-env-var AIDEN_MCP_TOKEN_CODEX_P7QD2M
```

Use the port your Aiden reports if it is not 49400; the Settings sheet fills in the real address. Each app reads its token from its own variable, `AIDEN_MCP_TOKEN_<NAME>_<ID>` (the app's name and the start of its id, from `aidenMcpTokenEnvName` in `renderer/shared/aiden-mcp-token-env.ts`), so the desktop and `aiden apps connect` print the same name and two apps in one shell profile keep separate tokens. The Settings sheet shows each app's own variable name. Set it wherever the client is started from, for example your shell profile.

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

Arguments are validated against each tool's schema, and unknown properties are rejected. A message can be at most 200,000 characters, and messages read back are capped at 20,000 characters each. A chat `aiden_chat_list` leaves out (Bot, feature or assistant) cannot be read, waited on, sent to or stopped by id, even when the id is known. Every chat tool answers it exactly as it answers an unknown id (`This Aiden chat no longer exists.`), so an app cannot tell such a chat exists. MCP apps are trusted less than paired phones, which can open assistant chats.

There is deliberately no tool for approvals or questions. When a turn needs one, `aiden_chat_wait` says so and where, and the person answers it in Aiden on that computer. A turn runs with the permissions of its workspace. In a Full-access workspace, tools run without asking, exactly as if the person had typed the message.

## Limits

- **Turns:** each app can start or send 10 turns a minute and have 2 runs at once. A retry of an accepted `clientRequestId` does not count again, even after a restart or after many newer requests: Aiden's durable request record answers it.
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

- Aiden keeps a local note of which app started a chat (`startedBy {kind: "app", name}`, in `aiden-mcp-chat-provenance.json`, the newest 1,000 entries). Only this computer's Aiden window reads it, for the **Started by** label; it is never sent to phones, Macs or apps.
- App ids never appear in tool results.
- Server logs carry only `started`, `stopped`, `start-failed` (with a problem code), `request-failed` and `revoke-bot-notices-unavailable` (an app was disconnected while Bot storage waits for repair), never a token, an app name, a path or chat text.
- No analytics events are sent for the MCP server: a chat an app starts sends no `chat_created`, and its turns send no `chat_message_sent`.

The Remote Access threat model has the matching section: [`docs/security/aiden-remote-threat-model.md`](security/aiden-remote-threat-model.md#10-local-mcp-server-for-outside-apps).

## Main-process API and Settings IPC

These are exported from `main/services/aiden-remote-service-main.ts`:

- `aidenMcpServerStatus()` returns `{supported, enabled, running, port?, url?, problem?}`.
- `setAidenMcpServerEnabled(enabled)` turns the server on or off and saves the choice. Calling it with `true` while the server is on but not running (`port_in_use`, `start_failed`) tries again.
- `issueAidenMcpApp({name, access: "read" | "supervised"})` returns `{credential, app}`. The credential is returned only this once.
- `listAidenMcpApps()` lists the connected apps.
- `revokeAidenMcpApp(appId)` disconnects one app. A phone's or Mac's id returns `false`.
- `aidenMcpChatProvenance(chatId)` returns the app that started a chat, if any.

Settings reaches them through `main/handlers/aiden-mcp.ts`, which accepts calls only from the active Aiden window:

| Channel | Returns |
| --- | --- |
| `remote:mcpStatus` | The status above. |
| `remote:mcpSetEnabled` | The new status. Takes only a boolean. |
| `remote:mcpIssueApp` | `{credential, app}`. The only channel that ever carries a credential. If the asking window closes before the answer arrives, the app is revoked again. |
| `remote:mcpListApps` | Live apps, newest first, as `{id, name, access, createdAt, lastSeenAt}`. `lastSeenAt` is 0 until the app first connects. |
| `remote:mcpRevokeApp` | `{revoked}`. |
| `remote:mcpChatProvenance` | `{name, startedAt}` or `null`. |

The renderer keeps the credential only in the state of the sheet that shows it. It is never put in the React Query cache, logged or saved.

Code: `main/services/aiden-mcp-server.ts` (listener, `AidenMcpHost`), `main/services/aiden-mcp-tools.ts` (tools and limits), `main/services/aiden-mcp-provenance.ts`, and agent-app state in `main/services/aiden-remote-state.ts`. Settings: `renderer/components/settings/aiden-mcp-settings.tsx`, `renderer/shared/aiden-mcp.ts` (views and client commands) and `renderer/lib/aiden-mcp.ts`. Tests: `main/services/aiden-mcp-server.test.ts`, `main/handlers/aiden-mcp.test.ts` and `renderer/components/settings/aiden-mcp-settings.test.tsx` (in `npm run test:aiden-remote`), and `tests/e2e/aiden-mcp-settings.spec.ts`.
