# Chat fork from any message — 2026-10-05

Plan: `docs/plans/chat-fork-plan.md` (five PRs). This note tracks what has landed.

## PR 1 — desktop fork (branch `feat/chat-fork-desktop`)

- **Cut points.** `chatStore.copyVisibleHistory` takes `forkAt: { messageId, position }`. `after` keeps a settled assistant reply. `before` keeps everything strictly before a user prompt, which is how Edit in fork works. The legacy `throughAssistantMessageId` input remains for Bot copies and records no lineage.
- **Lineage.** `ChatMeta.forkedFrom` is a `ChatForkLineageV1 { chatId, messageId, position, at }`, parsed strictly by `parseChatForkLineageV1` in `renderer/shared/chat-copy-contract.ts`.
  - `readChat` drops an invalid lineage instead of letting `isValidMeta` hide the chat.
  - Bot chats never get a lineage.
- **Titles.** Forks are named `Title (fork)`, then `(fork N)`, numbered past the highest sibling in the destination workspace. Forks of forks reuse the base title. Clones keep the `(copy)` suffix.
- **IPC.** `chats:copyVisibleHistory` accepts three request shapes:
  - `{chatId}` → clone;
  - `{chatId, throughMessageId}` → legacy fork after a reply;
  - `{chatId, messageId, position}` → fork at the given cut.
  
  Bot chats reject `before`.
- **UI.**
  - Hover actions: settled replies show "Fork from here" (in `MessageActions`); sent prompts show "Edit in fork" (next to Copy). Both use the `ForkMessageButton` component.
  - `MessageList` forwards `onFork` through a ref so settled rows stay memoized. The streaming row and Bot chats get no actions.
  - While the chat is busy or needs recovery, the buttons are `aria-disabled` and their title gives the reason.
  - `/fork` picker rows also get "Edit in fork".
- **Pre-fill.** Edit in fork seeds the new chat's composer: the text goes to the localStorage draft, and the attachments go to a one-shot in-memory seed (`seedComposerAttachments` / `takeComposerAttachmentSeed`; bytes are never persisted). Editing the *first* prompt opens a renderer-only chat draft instead, so no empty chat is persisted.
- **Lineage UI.** The chat header shows a second line with "Forked from “X”", which links to the source, or "Forked from a deleted chat". Sidebar rows get a `GitFork` glyph, a tooltip, and `aria-description`.
- **Deferred.**
  - Moving fork into `ChatApplicationService` waits for PR 4 (Remote).
  - The right-click context menu and skill pre-fill are not built.
  - The Pi journal is not forked yet (PR 2), so the forked model context is rebuilt from visible messages only.
- **Tests.**
  - `chat-session-copy.test.ts`: cuts, titles, lineage survival, and corrupt lineage being dropped.
  - `chat-copy-contract.test.ts` (registered in `test:slash-commands`).
  - The parser test and `chat-copy-view.test.ts`.
  - `message-bubble.test.tsx`: which rows show fork actions.
  - `tests/e2e/chat-fork.spec.ts`: the real flow against the fake LM Studio.
- **CI note.** Renderer-only PRs skip the Linux packaging jobs, so the required Linux checks never post. #342 (prompt selection) was therefore landed through this branch.
