# Mobile transcript windowing

iOS and Android read chats through `GET /chats/{chatId}/messages` when the Mac advertises `chat-messages-window-v1` (contract revision 19). Client-only; no contract change.

- Open, reconcile, and stream-finish reads fetch the newest 50-message window. The window has no chat metadata, so the client keeps the current title/model and takes the window's `revision`.
- The first network read replaces the cached transcript. Later reads merge: when the new window overlaps the transcript on screen, earlier pages the reader loaded stay in front (`AidenTranscriptWindowing.mergingLatest`).
- "Load earlier messages" sits at the top of the transcript and pages with `before=<oldest server message id>` (local optimistic `local-` ids are skipped). Earlier pages live in memory and reach the cache only through a later merged save.
- `409 revision_conflict` on a page reloads the newest window, replacing the transcript.
- Without the feature, every read stays the whole-chat `GET /chats/{chatId}`. The title-pending refresh always uses the whole-chat read because the title is why it runs.
- `hasOlder` is not persisted, so a cached transcript shows no Load earlier control until the network window arrives.
- Scroll: iOS re-anchors to the previous first row after a prepend; Android's reverse-layout `LazyColumn` keeps position because earlier pages join the end of the item list.
- Code: iOS `AidenTranscriptWindowing` (Models/AidenChat.swift), `AidenChatViewModel.loadEarlierMessages`; Android `AidenTranscriptWindowing` (models/AidenChat.kt), `AidenChatViewModel.loadEarlierMessages`, `AidenLoadEarlierMessages.kt`. Tests: iOS `AidenChatTests` window cases, Android `AidenTranscriptWindowTest`.
