# Prompts that survive a restart — 2026-10-29

Branch: `claude/project-thread-euhzg4-questions`. Desktop only (Mac and Linux); no Remote protocol change, phones unchanged (same scope as the #599 Resume card).

- `main/services/interrupted-waits-main.ts` keeps one open wait per chat in `interrupted-waits.json` (compact `DataStore`, normalized with `parseAskUserQuestions`, 7-day expiry, at most 100 records). `createInterruptedWaitStore` in `main/services/interrupted-reply.ts` holds the logic and is unit-tested.
- `llm-client.ts` remembers a wait when the ask-user or approval coordinator publishes a prompt. It forgets it only when the owner settled it (`AskUserQuestionSettledBy` "owner", or a timeout; for approvals the outcome "allowed"/"denied"). Host settlements (quit, crash, window or renderer loss, Stop) keep it. A first try that forgot on any withdraw failed the quit case, because the window closes before `abortAll`.
- `chats:interruptedWait` returns the wait only when the chat's latest run is interrupted and `askedAt >= run.startedAt`, so Stop or a new message hides it (a later run exists).
- Renderer: `chat-pane.tsx` rebuilds the question as a synthetic prompt (promptId = waitId) with the "restarted" `AskUserQuestionExpiryNotice`; submitting sends `formatRecoveredAskUserQuestionAnswers` as a normal message and then dismisses. Closing the card dismisses and leaves the Resume card. An approval wait only adds its summary to the Resume card.
- Tests: `interrupted-reply.test.ts`, `ask-user-question-coordinator.test.ts`, `tests/e2e/interrupted-question-resume.spec.ts`.
