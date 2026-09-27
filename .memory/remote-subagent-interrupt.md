# Remote subagent interrupt — September 27, 2026

Branch feature/remote-subagent-interrupt. Source: Hermex P1 (Hermes subpage 6).
Follow-on to the Mobile Task Progress and Subagents plan, which shipped a
read-only public agent roster.

- Route: `POST /chats/{chatId}/agents/{agentId}/interrupt`, feature
  `chat-agent-interrupt-v1`, contract revision 16. There is no new capability.
  It needs `chat:write` plus the negotiated `agents:read` grant, and `bot:write`
  for retained Bot chats. There is no Idempotency-Key. Archived chats get
  `mutation_blocked`.
- The public agentId is `publicId("agent", chatId, runId)`. The Remote handler
  maps it back through the current roster and calls
  `SubagentControlMainV2.stopForChat`. That method resolves the owning document
  privately and uses the same stop path as the desktop panel.
- Responses:
  - 200 returns the refreshed current-turn roster. A terminal agent is a no-op
    200.
  - 404 means the agent is not in the current turn.
  - 409 `operation_stale` means a legacy or unbound run.
- iOS (`AidenChatFeature.interruptAgent`, `AidenAgentDetailView`) and Android
  (`AidenChatViewModel.interruptAgent`, `AidenAgentDetailSheet` with
  `AidenAgentStopControl`) show a destructive Stop with confirmation. It appears
  only for non-terminal agents in the current roster, and only when the Mac
  advertises the feature and the device holds the grants. The sheet follows the
  live roster.
- Other PRs in the same wave may also claim revision 16. Renumber at merge time
  (see the papercuts note for the 7 conflicting files).
