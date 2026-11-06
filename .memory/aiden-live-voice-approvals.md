# Aiden Live: answering chat approvals by voice (PR 3 of the voice upgrade, 2026-11-06)

Branch `claude/project-thread-kc0y85-live-approvals`. Plan section: `docs/plans/aiden-live-voice-upgrade.md` → PR 3.

- Core: `renderer/lib/live-chat-approvals.ts`. `liveChatApprovals` store (chat pane publishes `{chatId, approvals, decide}`), `liveApprovalVoiceAnswerable` (tap-only policy: allow-list of plain workspace tools, no `details`, `canAllow` not false, `scopes` must include `once`, sensitive-word screen), `liveApprovalAction`/read-out text, and `LiveChatVoiceApprovals` controller (singleton `liveChatVoiceApprovals`). Ribbon source is `"approvals"`.
- Hooks: `renderer/components/assistant/use-live-chat-voice-approvals.ts`. `useLiveChatVoiceApprovals(settings)` in `AssistantDock` (off until settings load); `usePublishLiveChatApprovals` + `useLiveApprovalVoiceHint` in `chat-pane.tsx`; `ChatApprovalCard` takes `liveVoice` ("voice" | "tap" | null).
- Answers always go through the chat pane's `decideApproval(prompt, decision)` with no options, i.e. allow once. No "answered by voice" marker: the approval record has no field and adding one is a Remote contract change.
- The publisher drops approvals carried over from the previous chat on the first render after a chat switch (same array reference, new chatId).
- Live's own Computer Use voice approvals (`assistant-live-voice-approval.ts`) now use `matchLiveVoicePhrase` allow/deny; their receipts and baselines are unchanged (the dock still does not mount that listener).
- Settings: `live-voice-approval-settings.tsx` (switch `aidenLiveVoiceApprovals`, languages line, What to say fold).
