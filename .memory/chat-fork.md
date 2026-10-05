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
  - The Pi journal was not forked in PR 1; PR 2 below adds it.
- **Tests.**
  - `chat-session-copy.test.ts`: cuts, titles, lineage survival, and corrupt lineage being dropped.
  - `chat-copy-contract.test.ts` (registered in `test:slash-commands`).
  - The parser test and `chat-copy-view.test.ts`.
  - `message-bubble.test.tsx`: which rows show fork actions.
  - `tests/e2e/chat-fork.spec.ts`: the real flow against the fake LM Studio.
- **CI note.** Renderer-only PRs skip the Linux packaging jobs, so the required Linux checks never post. #342 (prompt selection) was therefore landed through this branch.

## PR 2 — Pi journal fork (branch `feat/chat-fork-journal`)

- **What carries over.** A fork's journal is the source's active branch up to the last copied message's `AIDEN_CHAT_MESSAGE_MARKER`, extended through the commits that close every Aiden transaction open at that marker (a reply's marker sits inside its generation envelope). Tool results and compaction checkpoints before the cut come along; nothing after it does. `piJournalForkPrefix` computes the boundary and returns `undefined` when it isn't provable.
- **Why custom import.** Pi's branch-scope fork needs a complete AgentLane, which Aiden doesn't keep, and its tree-scope fork copies post-cut data. `PiSessionPort.importBranch` instead inserts one root-to-tip path into an empty journal. The skills-disabled projection view refuses imports.
- **Fresh markers.** `PiCompactionSessionStore.forkChat` then appends markers under the fork's new message ids for every copied message the prefix had synchronized, so `syncChatMessagesToPiSession` does not append them again.
- **Fallback.** No source journal, the rollout gate, or no provable boundary → returns false and creates nothing; the fork rebuilds model context from visible history like before. A thrown journal error in the IPC handler is logged as a `chat-degraded` diagnostic and never fails the fork.
- **Cleanup.** `copyVisibleHistory`'s `beforeInstall(chat, sourceMessageIds)` runs the journal fork. If the chat install then fails, the handler deletes the target journal unless the error requires reconciliation (startup `reconcileChats` also removes orphans).
- **Tests.** `main/services/pi-journal-fork.test.ts` (in `test:compaction`): context through the cut survives a reopen, no duplicate sync, the no-boundary fallbacks, and the `importBranch` guards. `chat-session-copy.test.ts` checks the source-id pairing.

## PR 3 — Fork with summary (branch `feat/chat-fork-summary`)

- **State.** `ChatForkLineageV1.summary` is a `ChatForkSummaryV1 { state: pending | ready | failed, afterMessageId, instructions?, text?, files?, error? }`. `afterMessageId` is the fork's own last copied message. The chat index keeps only `state` and `afterMessageId`; the full text lives on the chat.
- **Main.**
  - `ForkSummaryService` (`main/services/fork-summary-service.ts`) runs pi's `generateBranchSummary` on the *source's* provider and model. It uses the source journal after the cut when skills are on and the boundary is provable, and otherwise the visible messages.
  - pi's "explored a different branch" preamble and its file sections are stripped; the files are kept separately.
  - One attempt runs per fork. Cancel and failure both settle to `failed`. Retry keeps the instructions. Skip removes the summary.
  - At startup, `initializeForkSummaries` marks summaries left `pending` by a quit as failed.
  - Every change is broadcast as `chats:fork-summary-changed { chatId, forkedFrom? }`.
- **Hold.**
  - `appendMessage` refuses sends while a summary is pending or failed (`forkSummaryHoldsSend`).
  - The renderer mirrors this with `ChatMessageQueue.holdForForkSummary`, a separate flag from compaction's `holdReason`, so a compaction release cannot clear it. Follow-ups queue without pausing and send in order once the summary is ready or skipped.
  - The composer shows a status strip and queues instead of sending.
- **Model context.** `projectVisibleHistoryWithoutSkills` and `ensurePiForkSummary` place a ready summary as a branch-summary entry right after `afterMessageId`.
- **UI.**
  - `ForkSummaryCard` renders after `afterMessageId` in `MessageList`: pending (spinner, Cancel), failed (Retry, Continue without summary), and ready (a collapsed disclosure with Markdown and file lists).
  - Entry points:
    - a right-click `MessageForkContextMenu` on settled rows (Copy for a selection inside the row, the plain fork, and "Fork with summary…");
    - "With summary…" in the `/fork` picker.

    Both open `ForkSummaryDialog`, which has an optional focus textarea.
  - `forkSummaryRows` offers the summary only where messages follow the cut. A reply needs a later message; a prompt needs an earlier prompt, otherwise Edit in fork opens a draft.
- **Tests.**
  - `fork-summary-service.test.ts` (in `test:compaction`) and `chat-session-copy.test.ts`.
  - Queue hold cases in `chat-message-queue.test.ts`.
  - `fork-summary-card.test.tsx`: the card states.
  - `chat-copy-view.test.ts`: `withForkLineage` and `forkSummaryRows`.
  - `message-bubble.test.tsx`: the card's placement.
