# Multi-host PR 6: remote chat view and live observation

Status: **In review**. Row 6 of the [desktop multi-host control plan](desktop-multi-host-control-plan.md) (§5 Renderer). Stacked on PR 5b ([remote sidebar rows](desktop-multi-host-pr5b-remote-sidebar.md)), which is stacked on PR 3 ([peer manager](desktop-multi-host-pr3-peer-manager.md)) and PR 2 ([host contract](desktop-multi-host-pr2-host-contract.md)).

This PR is about viewing and live observation only. Send, stop, approvals, questions, steer, rename and delete come in PR 7.

## Scope

- **Query keys.** `hostQueryKeys` gains `chat(hostId, chatId)` and `messagesWindow(hostId, chatId)` under `["host", hostId, …]`. Unpairing a host already drops everything under `host(hostId)`.
- **Mapper** (`renderer/lib/hosts/remote-chat-mapper.ts`). This is pure code.
  - It maps the remote chat projection or summary row to `Chat`, and window messages to `ChatMessage`.
  - ISO times become milliseconds.
  - A message `outcome` becomes `providerFailure` when the category is known.
  - Attachments keep their metadata only, with no bytes.
  - HTML artifacts are dropped, because their frame reads local media.
  - It merges paged windows: newest window refresh, older pages, and a revision conflict fallback.
- **Translator** (`renderer/lib/hosts/remote-stream-translator.ts`). This is a pure reducer from `PeerRunEvent` to the same transcript state the local pane feeds `MessageList`: streaming text and reasoning, timeline, tool activity, pending prompts, and terminal outcome.
  - `snapshot` resets the text.
  - A `gap` snapshot also reseeds pending prompts and asks for a window refetch.
  - A different `streamId` starts a fresh run.
  - Sequences at or below the cursor are dropped.
  - `run.ended` is applied once even though it repeats the terminal sequence.
  - A `truncated` subscription asks for a refetch before its events apply.
  - Terminal events and `run.started` also ask for a refetch, so the persisted turn replaces the stream.
- **Adapter** (`renderer/lib/hosts/host-chat-adapter.ts` and `remote-host-adapter.ts`).
  - `HostChatAdapter` exposes `capabilities`, `getMessagesWindow`, `observe` and `markRead`.
  - The remote adapter wraps `peerHostsApi` behind an injectable transport.
  - It captures the supervisor generation when a read starts and drops a response that lands after the generation moves.
  - It filters live run frames by host and stream key.
- **Session** (`renderer/lib/hosts/remote-chat-session.ts`). This is a small, framework-free store for one open remote chat.
  - It loads the newest window and then observes the chat's run stream.
  - Window refetches run in order with stream events: refetch, then resume.
  - It handles Load older.
  - It marks offline hosts stale and refreshes after a reconnect.
  - A disposed session ignores everything.
  - The React view reads it through `useSyncExternalStore`.
- **View** (`renderer/main/remote-chat-view.tsx`). This replaces the 5b placeholder on `/host/$hostId/chat/$chatId`.
  - It reuses `MessageList` and `ScrollArea`.
  - The header shows the globe marker, the machine name and its availability.
  - A Load older control appears above the transcript.
  - Pending approvals and questions are shown read-only, with no action buttons.
  - When the host is offline or blocked, the last-known transcript stays visible as stale, alongside the 5b Reconnect or Connections row.
  - There is no composer. A footer note explains that sending from this Mac arrives later.
  - Local-only panels (terminal, Environment/browser, computer use, open in editor, reveal in Finder, BTW, compact, context meter) are not rendered, and no local API is called.

## Decisions

- **No local adapter yet.** PR 6 has no local caller of `HostChatAdapter`. `local-host-adapter.ts` arrives with the `useChatSession` extraction in PR 7.
- **Read-only prompts have no buttons.** Disabled buttons would advertise controls that do nothing. The card names the host where the prompt can be answered.
- **Translator state, not callbacks.** The reducer returns the same values `chat-pane` passes to `MessageList`. That makes it a pure and exhaustively testable function. `useChatSession` in PR 7 can consume the state directly or wrap it in `StreamCallbacks`.
- **Paging.** The newest 50 messages load first, and Load older fetches 50 more using `before`. A `revision_conflict` on an older page reloads the newest window instead of guessing. The full `chat` operation is never used for the transcript.
- **Mark read.** Marks are sent through the newest persisted message only while the host is connected and grants `chat-read-state-v1`. A new idempotency key is minted for each mark.
- **No contract changes.** This PR uses the PR 2 and PR 3 operations and IPC unchanged, so iOS and Android are unaffected.

## Tests

- `renderer/lib/hosts/remote-chat-mapper.test.ts`: mapping, dropped fields, window merges.
- `renderer/lib/hosts/remote-stream-translator.test.ts`: reset, gap reseed, run switch, duplicate and `run.ended` sequences, truncation, terminal outcomes.
- `main/services/peer-remote-chat-view.test.ts`: real PR 2 host services (run registry, run streams, host feed and messages window) behind the real `PeerHostManager` and live IPC handlers, driving the real adapter and session. It covers these cases:
  - A run started on the host's own screen streams to this Mac.
  - A gap is recovered through a snapshot and a window refetch.
  - A large chat opens one window at a time.
  - Late responses are fenced after a reconnect.
- `renderer/main/remote-chat-view.test.tsx`: the view states (live, stale or offline, Load older, read-only pending approval), rendered to static markup.

## Interfaces for PR 7

- `HostChatAdapter` keeps methods keyed by `chatId`, so PR 7 adds `send`, `cancel`, `respondApproval`, `answerQuestion`, `steer`, `rename` and `remove` next to the read methods. `HostChatCapability` already names them.
- `RemoteChatSession` is the remote half of `useChatSession(adapter, ref)`. Its snapshot (`messages`, `hasOlder`, `run`) maps onto the pane's transcript inputs through `remoteRunTranscript`.
- `RemoteChatView` renders `MessageList` with exactly the props `chat-pane` passes. PR 7 replaces it with the shared pane once the hook is extracted.
