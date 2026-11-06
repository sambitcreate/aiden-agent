# Aiden Live chat tools (voice upgrade PR 2)

- Branch `claude/project-thread-kc0y85-live-chat` (2026-11-06). Plan: `docs/plans/aiden-live-voice-upgrade.md` (PR 2 section).
- Five tools: `read_open_chat`, `send_to_open_chat`, `stop_open_chat`, `find_and_open_chat`, `start_new_chat`. Main (`main/services/gemini-live/live-chat-tools.ts`) declares them, validates arguments and forwards to the window through the renderer tool broker; the factory returns null when `aidenLiveChatAccess === false` or `AIDEN_EXPERIMENTAL_GEMINI_LIVE_CHAT=0`.
- The window side: `LiveChatToolsHost` (mounted in root-view) registers handlers on `liveSessionBus`; ChatPane registers its controller via `useLiveChatController` into `liveChatControl`, so sends reuse `handleSend` / `queueMessage` / `admitSteer` / `handleStop`. `start_new_chat` waits up to 5 s for an `isDraft` controller in the target workspace.
- Shared rules (limits, fixed error codes, transcript shaping, title matching, note text) live in `renderer/shared/live-chat-tools.ts`. `auto` sends when idle, steers when the run can take it, else queues.
- `find_and_open_chat` never guesses: titles scoring within 0.1 of the best return up to 3 `closeMatches` and open nothing.
- Spoken notes (`renderer/lib/live-chat-notes.ts`) carry title and state only (finished, error, approval, question), never reply text; a user Stop produces no note.
- `inputSource: "voice"` is persisted on user messages (append meta, first message, `chat:admitRunInput`) and projected to Remote revision 60 (provisional; origin/main was at 59 on 2026-11-06). Bot fixtures `bot-*.json` stay at 59; their tests now compare with their feature constants instead of the current contract revision.
- Settings: "Chats" group in Aiden Live settings (`live-chat-access-settings.tsx`); one-time toast saved with `aidenLiveChatAccessNoticeShown`.
- iOS/Android tests for the label were written but not run in the Linux build container.
