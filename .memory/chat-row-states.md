# Chat row states and honest unread markers

Status: implemented for review on `feature/chat-row-states` (Hermex-inspired). Remote contract revision 16.

## Model
- Row state, in priority order: `needs_approval` > `needs_input` > `working` > `idle` (`renderer/shared/chat-row-state.ts`, `chatRowState`).
- `ChatActivityRegistry` (`main/services/chat-activity-core.ts`) tracks attention prompts by prompt id and stream. `llm-client.ts` raises approval attention for tool approvals and input attention through the ask-user-question coordinator's `withdraw` callback. Settling a stream clears its prompts, so a missed withdrawal cannot strand a row. Snapshots carry optional `approvalChatIds`/`inputChatIds`.
- Unread means assistant output arrived after the user last viewed the chat. `ChatMeta.lastAssistantAt` is computed in `chat-store-core.ts` `metaOf`. Markers live in `userData/chat-read-markers.json` (`ChatReadMarkerStore`), outside the chat index so marking read never bumps a summary revision. The first load stamps `baselineAt`, so history that predates tracking is never unread. Markers only move forward, are bounded (`MAX_CHAT_READ_MARKERS`), and broadcast `chats:read-markers-changed`.

## Surfaces
- Desktop: `ChatRowStatus` in the sidebar. The open chat never shows the unread dot, and `useMarkChatRead` in `chat-pane.tsx` reports reads while the document is visible (IPC `chats:markRead`). `aria-busy` is set only for Working.
- Remote: `/chat-summaries` rows carry `rowState` and `unread`. `POST /chats/{chatId}/read` takes `{}` or `{throughMessageId}` and returns 204; it needs `chat:read` plus readable chat access. Both are advertised as `chat-read-state-v1`, and the parser treats the fields as optional.
- iOS and Android: `displayRowState` gates on local `activity` (idle wins, so a stale server attention state cannot linger) and falls back to Working for older Macs. Unknown future states decode as nil or null. Rows use soft 12% semantic fills (warning for Approve, accent for Reply), a spinner for Working and an accent unread dot. Opening a chat clears unread locally and reports read once per chat revision when the feature is advertised.

## Follow-ups
- Bot chats are excluded; native Bot contact rows could adopt the same states later.
- Desktop `lastAssistantAt` uses assistant message `createdAt`, so a streaming reply counts once it persists.

## Review follow-up
- Both mobile clients capture and send the last message ID from the displayed chat snapshot, and skip empty snapshots, so a later persisted reply cannot be silently marked read.
- Read markers persist message position alongside time, and summary metadata carries the assistant position internally. Equal-millisecond replies compare message order; stale reports cannot move the boundary backward. Positions never enter Remote summary JSON.
- CI registry assigns all four newly added test files.
- Desktop focused tests (67), CI policy and typecheck pass; Android chat-summary tests and the iOS AidenRemoteClientTests simulator suite pass.
