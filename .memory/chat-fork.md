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

## PR 4 — Remote, peer and `aiden serve` (branches `feat/chat-fork-remote`, `feat/chat-fork-peer`)

- **Shared service.** `ChatForkService` (`main/services/chat-fork-service.ts`) creates forks for the desktop IPC handler, Remote and the CLI daemon. One copy at a time; the source is held idle; `ChatForkCaller` carries per-surface checks (`assertSource` under the copy lock, `assertInstallable` before install, workspace admission). `journalRequired` (set by `aiden serve`, whose model context exists only in the journal) turns a journal failure into `unavailable` and deletes the target journal.
- **Routes.** Revision 21, features `chat-fork-v1` and `chat-fork-summary-v1`. `POST /chats/{id}/fork` and `/chats/{id}/fork-summary/{retry|skip|cancel}` need `chat:write`, `If-Match` and `Idempotency-Key`. A `before` cut returns `prefill {text, attachments}` with the prompt's attachments restaged for the calling device.
- **Wire summary.** The desktop keeps `instructions` and `files`; `projectForkSummary` sends `{state, afterMessageId, focus?, text?, error?}`. File paths never leave the Mac, and `error` passes only if it is one of `FORK_SUMMARY_AIDEN_ERRORS`, else "The summary could not be generated.". Requests take `summary: {focus?}`.
- **Status codes.** Summary actions answer 409 `revision_conflict` only for `ForkSummaryStateError` (the summary moved on); any other error falls through to the router's internal-error path. A fork whose result (chat plus staged prefill) would exceed the durable-operation size limit is refused with 413 before install. Replays of any rejection come back as 409 `internal_error`, because the idempotency ledger stores only contract codes.
- **Peer.** `peer-operation.ts` `forkBody` accepts only `focus`; `remote-host-adapter.ts` maps the wire `focus` back to the desktop's `instructions`.

## Mobile PR — Android half (branch `feat/chat-fork-android`)

- **Client.** `AidenRemoteClient.forkChat` posts `/chats/{id}/fork` with `If-Match` and an `Idempotency-Key`, expects `201 {chat, prefill?}`, and rejects a result that has no lineage or is the source chat. A blank focus sends `summary: {}`. `retryForkSummary`, `skipForkSummary` and `cancelForkSummary` post to `/fork-summary/{retry|skip|cancel}`. 409 `operation_in_progress` and `revision_conflict` get their own copy in `AidenChatForkErrors`.
- **Models.** `AidenChat.forkedFrom` (an `AidenChatForkLineage`, optional summary) and `AidenChatSummary.forkedFrom` (lineage only; summary rows never carry the summary). The summary is `{state, afterMessageId, focus?, text?, error?}`; `instructions` is rejected everywhere in chat payloads.
- **Gating.** `supportsChatFork` (`chat-fork-v1`) and `supportsChatForkSummary` (`chat-fork-summary-v1`) on the installation; `AidenChatForkEligibility` mirrors the Mac's cut rules (settled replies; user prompts that are not the first; no `local-` ids; no running turn).
- **UI.** `AidenMessageContextMenu` gains Fork from here, Fork with summary… (opens `AidenForkSummaryDialog`, 1,000-character focus) and Edit in fork. After a fork the view model sets `forkNavigation`; the screen pushes the fork, so Back returns to the source. `prefill.text` becomes the fork's draft and its attachments are staged in memory in `AidenChatDraftStore` and taken once by the fork's view model. The transcript shows `AidenForkLineageRow` at the top and `AidenForkSummaryCard` after `afterMessageId`; a pending or failed summary holds sends. Workspace chat rows show a `CallSplit` glyph.
- **Handoff fencing.** `fork()` captures the pairing `createdAt`, a `reserveChatWrite()` token and `AidenChatDraftStore.purgeAuthority(instanceId)` before the POST, as `send()` does. The cache save, `setDraft(chatId, text, authority)` and `stageAttachments(chatId, attachments, authority)` refuse writes after `purge`, and `forkNavigation` is published only if the client, pairing, cache token and draft authority are still current after the IO, so an unpair during the handoff leaves nothing behind.
- **Retry keys.** The saved `forkAttempt` key is kept only when `AidenChatForkErrors.isOutcomeUnknown` (no HTTP error response, or `idempotency_in_flight`). Every other error response clears it, because the Mac's idempotency ledger settles that key as a rejection and replaying it would only return `internal_error`.
- **Tests.** `AidenRemoteClientTest` (fixture request shapes, prefill, summary routes, 409 copy, optional lineage), `AidenChatTest` (eligibility, Edit in fork → navigation → prefill seeding, summary hold and skip, hidden without the features, unpair during the handoff, busy rejection then a fresh key, lost response then the same key) and `AidenBotContractTest` (`focus` accepted and `instructions` rejected under `forkedFrom.summary`). `testFetchedForkDecodesEverySummaryState` decodes the fixture's `chatFork.summaryStates`.

## Mobile PR — iOS half (branch `feat/chat-fork-ios`)

Both halves ship together from `feat/chat-fork-mobile`, which also carries the Android unit-test loopback fix (see `android-unit-test-dns.md`).

- **Client.** `AidenRemoteClient.forkChat` POSTs `chats/{id}/fork` with `If-Match` and `Idempotency-Key`, expecting 201 `{chat, prefill?}`.
  - A nil `summaryFocus` means a plain fork with no `summary` key. An empty or whitespace string sends `summary: {}`; otherwise `summary: {focus}`.
  - Focus is trimmed and capped at 1,000 UTF-16 units, matching the Mac.
  - The result fails closed: it must be a different chat whose lineage records the requested source, message and position, and a prefill is accepted only for `before`.
  - `retryForkSummary` and `skipForkSummary` return the Chat; `cancelForkSummary` returns `cancelled`.
- **Private-key scanner.** `AidenBotPrivateResponseValidator` refuses any `instructions` key in a scoped chat read, including under `forkedFrom.summary`; the wire field is `focus`, so no exception is needed. The fork POST result is not scoped.
- **Gating.** `supportsChatFork` reads `chat-fork-v1`. `supportsChatForkSummary` additionally needs `chat-fork-summary-v1`.
- **DTOs.**
  - `AidenChat.forkedFrom` and `AidenChatSummary.forkedFrom` decode leniently: a damaged lineage becomes nil and a damaged summary is dropped on its own.
  - Rows strip the summary. `CachedChatSummary` persists the row lineage.
  - iOS has no messages-window DTO, so the window's `forkedFrom` is not consumed.
- **Retry keys.** `AidenChatForkAttempt` keeps the fork's normalized request (chat, revision, message, position, trimmed focus), its request context and its `Idempotency-Key` in the chat view model. The key is reused only for the same request on the same activation after an unknown outcome: no Aiden error response, a cancellation, a 201 that could not be accepted, or `idempotency_in_flight`. Success or any other error drops it, matching Android and the Mac's ledger.
- **Navigation.** Forks open through `AidenForkableChatDetailView`, which keeps a per-source `AidenChatForkTrail` and pushes each fork as its own `navigationDestination(isPresented:)` level. The compact stack path holds persisted workspace IDs, so fork routes don't go into it. Back walks fork → fork → source in the compact sidebar, the workspace list and the regular-width detail column, where the sidebar keeps the source selected. A size-class change drops the trail.
- **UI.** `Features/Chat/AidenChatFork.swift` holds the eligibility rules, the lineage row, `AidenForkSummaryCard`, `AidenForkSummarySheet` and the prefill handoff.
  - Context-menu and accessibility actions:
    - settled replies after a prompt: Fork from Here;
    - replies with a later message: Fork with Summary… (summary feature only);
    - non-first prompts: Edit in Fork.
  - `AidenChatDetailView(onOpenChat:)` opens the fork. Bot details pass nothing, so they get no fork actions.
  - Chat-list rows show `arrow.triangle.branch`.
- **Edit in fork prefill.**
  - The text is saved to `AidenChatDraftStore` for the fork, with `isCurrent` checks before and after; a pairing change removes it. The fork's normal draft restore then loads it.
  - Valid restaged attachments go through the MainActor `AidenChatForkPrefillHandoff`, keyed by instance and chat and purged on unpair. The fork's `load()` adopts them as owned uploads.
- **Hold.** Sends are not held client-side; the Mac refuses them while a summary is pending or failed. The card polls every 3 seconds while pending.
- **Tests.**
  - `AidenRemoteClientTests`: the fixture request and response, summary body shapes, lineage validation, summary actions, lenient decoding, and row stripping. `testForkSummaryStatesDecodeInChatReadsAndChatLists` decodes every `chatFork.summaryStates` entry.
  - `AidenChatTests`: eligibility, feature gating, and the Edit in fork seeding end to end.
