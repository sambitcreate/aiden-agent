# Fork a chat from any message

Status: **Planned (decisions approved 2026-10-05)**. Not implemented yet. Written against `main` at `7e339cf1d` (0.53.0).

## Goal

A user can fork a workspace chat from any message on desktop, iOS, Android and paired Macs. A fork is a new chat in the same workspace that contains the conversation up to that point. The original chat is left unchanged. The fork remembers which chat and message it came from. Optionally, the fork can also carry a summary of what happened in the original chat after the fork point.

## Decisions

| Question | Decision |
|---|---|
| Naming | **Fork** everywhere. This covers UI copy, the `/fork` command, the Remote route and the feature token. |
| Busy chats | Keep today's rule. Forking is refused while the source chat is generating or waiting on an approval. |
| Sidebar | Flat list. Each fork row shows a small fork glyph and a "Forked from …" tooltip. Forks are not nested. |
| Summaries | Optional **Fork with summary**. The summary uses Pi's branch summarization, and the model sees it in the fork's context. |

## What already exists

Aiden already ships a narrow version on desktop:
- `/fork` ("Fork from a turn") opens a picker of completed assistant turns.
- `/clone` copies the whole visible chat.
- Code: `renderer/shared/slash-commands.ts`, `renderer/lib/chat-copy-view.ts`, and the composer dialog.

Both commands call `chats:copyVisibleHistory` (`main/handlers/chats.ts`), which calls `chatStore.copyVisibleHistory({ throughAssistantMessageId })` (`main/services/chat-store-core.ts`). That method:
- gives copied messages fresh IDs and their own copies of attachment and artifact bytes;
- refuses to run while the source chat is busy;
- adds `(fork)` or `(copy)` to the title.

Gaps in that version:

| Gap | Effect |
|---|---|
| The command is the only way in. Messages have no fork action. | Hard to discover. |
| It can only cut *after* an assistant turn. | You can't fork to rewrite a prompt and try again. |
| No lineage: `ChatMeta` has no `forkedFrom`. | A fork looks like any other chat except for its title. |
| Only the visible projection is copied, and the fork starts with no Pi journal. | The fork's model loses earlier tool results and compaction checkpoints. |
| No application-service method, Remote route or CLI command. | iOS, Android, paired Macs and `aiden serve` can't fork. |

## How opencode and pi do it

### opencode (`dev` at `907b3bc518`)

- **API:** `POST /session/:id/fork { messageID? }` deep-copies every message that comes strictly before `messageID` into a new session.
  - Message and part IDs are regenerated.
  - Assistant→user parent links and compaction tail IDs are remapped.
  - Tool, file and snapshot parts are copied as-is.
- **UI:**
  - Clicking a user message offers Revert, Copy and **Fork**.
  - `/fork` lists user messages newest first, with "Full session" at the top.
  - After forking, the new session opens with the forked prompt and its attachments in the composer.
- **Lineage:** v1 keeps none; the title just becomes `X (fork #N)`. The v2 client adds `fork: { sessionID, messageID }` and a `session.forked` event.
- **Files:** forking never touches the working tree.

### pi (`main` at `021eae60a`)

- **Session file:** an append-only tree of entries with `id`/`parentId`, plus a leaf pointer.
- **`/fork`:** calls `fork(entryId, { position: "before" })`. This copies the path from the root to the parent of the selected user message into a **new session file**, sets `parentSession` in its header, and puts the message text back in the editor.
- **`/clone`:** uses `position: "at"`.
- **`/tree`:** navigates within one file. It can summarize the branch being left into a `branch_summary` entry.
  - The summary uses a fixed Goal / Constraints / Progress / Decisions / Next steps format and lists the files read and modified.
  - The model receives it as "The user explored a different conversation branch…".
- **Hooks:** `session_before_fork` can cancel a fork. `session_start` fires with `{ reason: "fork" }`.
- **Aiden's pinned `@earendil-works/pi-agent-core@0.87.1` already exports:**
  - `SessionRepo.fork(source, { scope: "branch", entryId, position: "before" | "at" })`
  - `collectEntriesForBranchSummary`, `prepareBranchEntries` and `generateBranchSummary`
- **Aiden support:** `main/services/pi-session-port.ts` already turns `branch_summary` entries into model context.

### What we take from them

1. Two cut points:
   - *before a user message*, to edit it and resend;
   - *after a reply*, to continue from there.
2. Pre-fill the composer when cutting before a prompt.
3. Each fork is a separate chat, not an in-place tree. Remote, mobile caches and sidebar summaries all assume one linear transcript per chat.
4. Lineage is recorded explicitly.
5. The agent's own context is forked, not just the visible text.
6. pi's branch summary is reused so the fork can know what was tried after the fork point.

## Design

### Cut points

| Action | Shown on | Copies | Composer after navigation |
|---|---|---|---|
| **Fork from here** | Settled assistant reply | Everything through that reply | Empty |
| **Edit in fork** | User message | Everything *before* that message | That prompt's text, attachments and skill, ready to edit |

- `/fork` keeps working. Its picker gains user-message rows, which use the "before" cut point, alongside the existing assistant turns.
- `/clone` is unchanged.
- A request looks like `{ chatId, messageId, position: "after" | "before", summary? }`.
  - `after` requires a settled assistant message.
  - `before` requires a user message. On the first message, the result is an empty chat with the prompt pre-filled. This matches pi's `parentId === null` case.

### Fork with summary

The summary is offered only when the source chat has messages after the cut point.

**UI**
- The hover button always makes a plain fork.
- The message context menu and the `/fork` picker also offer **Fork with summary…**. This opens a small sheet with:
  - a single optional "Focus the summary on…" instructions field. pi uses the same field for custom instructions.
  - **Fork** and **Cancel** buttons.

**Content**
- The summary covers source entries after the cut point, up to the source's current tip.
- It is built with `collectEntriesForBranchSummary`, `prepareBranchEntries` (token budget, default 16k) and `generateBranchSummary`.
- It runs on the source chat's provider and model, through the existing compaction summarizer routing and usage accounting.
- If the source has no Pi journal, the summarizer runs over the visible messages after the cut.

**Storage**
- In the fork's Pi journal, the summary is a `branch_summary` entry that is a child of the cut entry. `pi-session-port` already feeds that entry type to the model.
- In the visible transcript, `forkedFrom.summary` holds `{ state: "pending" | "ready" | "failed", text?, files? }`. The lineage row renders it as an expandable "What happened after this point" card. This is the same treatment as the compaction checkpoint card.

**Async flow**
- The fork is created immediately with `summary.state = "pending"`, and generation runs in the background.
- While the summary is pending, the fork's first send is held. This reuses the queue-while-compacting hold: the composer stays editable, shows "Summarizing the original chat…", and queues the message.
- The summary can be cancelled. On cancel, or when generation fails, `state` becomes `"failed"` with **Retry** and **Continue without summary** actions, and any held message is paused rather than dropped.
- Progress and completion reach desktop and Remote clients through the existing `chats:metadata-updated` broadcast and chat revision bumps.

### Lineage

- `ChatMeta` gains an optional field. Existing chats load unchanged.

  ```ts
  forkedFrom?: {
    chatId: string;
    messageId: string;
    position: "after" | "before";
    at: number;
    summary?: { state: "pending" | "ready" | "failed"; text?: string; files?: { read: string[]; modified: string[] } };
  }
  ```

- **Title:** `Title (fork 2)`, numbered like opencode. This replaces the static `(fork)` suffix.
- **Transcript header:** a quiet "Forked from **{source title}**" row. It links to the source and scrolls to the message. If the source chat was deleted, the row reads "Forked from a deleted chat" with no link.
- **Sidebar:** the list stays flat. A fork row shows the fork glyph (the existing `fork` slash icon) and a "Forked from …" tooltip.
- **Bot chats:** forking is excluded. A Bot has one canonical chat.

### Pi journal fork

The visible copy stays the source of truth for the transcript.

**New method:** `PiCompactionSessionStore.forkChat(sourceChatId, targetChatId, cut, position, messageIdMap)`.
1. Resolve the cut to a journal entry through the `aiden.chat-message.v1` markers that `syncChatMessagesToPiSession` already writes.
2. Call `SessionRepo.fork(source, { scope: "branch", entryId, position, id: targetChatId })`.
3. Rewrite the copied markers to the fork's new visible message IDs, using the map from the visible copy.
4. Register the new journal in `aiden-journal-index.json`.

**Fallback:** a legacy chat, a missing journal, an ineligible chat or an unresolvable cut means no journal is forked, and the fork rebuilds lazily from visible messages as it does today. A fork never fails just because the richer copy wasn't possible.

**Atomicity:** the visible copy and the journal fork run under the existing dual-ID lock and recovery transaction.

### Workspace and files

A fork keeps the source `workspaceId`. It doesn't touch files, git branches or worktrees. This matches both opencode and pi. "Fork into a new worktree" is a possible later option.

### Busy chats

Unchanged: a fork is refused while the source chat is generating or waiting on an approval. In the UI:
- On desktop, the fork actions are disabled with a tooltip.
- On Remote, the route returns `409`, and mobile clients show the same reason.

## Surfaces

### Desktop

- **Shared service:** move fork and clone into `chat-application-service.ts` as `fork(input)`. IPC, Remote and the CLI daemon then share one implementation. `chats:copyVisibleHistory` becomes a thin caller and gains `position` and `summary`.
- **Message actions:**
  - `MessageBubble` and `MessageList` gain `messageId` and an `onFork(messageId, position, { summarize })` callback.
  - In `message-actions.tsx`, assistant replies get a **Fork** button that uses the shared squircle action shape.
  - User messages get **Edit in fork** next to the hover Copy button.
  - Both actions, plus **Fork with summary…**, also appear in a right-click context menu on the bubble.
- **Navigation and pre-fill:** reuse the `copyChat` path in `chat-pane.tsx` to update the cache, select the workspace and navigate. For `before`, seed the fork's per-chat draft (text, attachments, skill) and focus the composer.
- **Lineage UI:** the transcript header row, the summary card and the sidebar glyph.
- **Paired Macs:** `remote-chat-view.tsx` gets the same actions, routed through `HostChatAdapter.fork` → `peer-operation.ts` → the Remote route and gated on the peer's `chat-fork-v1` feature.

### Aiden Remote

- **New route:** `POST /chats/{chatId}/fork` (`forkChat`).
  - **Body:** `{ messageId, position, summary?: { instructions?: string } }`.
  - **Headers:** `Idempotency-Key`, and `If-Match` on the source revision.
  - **Response:** `{ chat, prefill? }`. For `before`, `prefill` is `{ text, attachmentIds, skill }`, and the attachments are re-referenced rather than re-uploaded.
  - **Errors:** `409` when the source is busy, `404` for an unknown message, `422` for an ineligible message.
- **Summary controls:** `POST /chats/{chatId}/fork-summary/retry` and `/cancel` drive the failed and pending states.
- **Projections:** chat and chat-summary projections gain `forkedFrom`, including `summary`. Older clients ignore the extra optional field.
- **Revision and feature token:** contract revision **21** plus feature `chat-fork-v1`. Claim the revision at merge time. Update all of these in the same change:
  - `docs/aiden-remote-api-v1.md`
  - `protocol/aiden-remote/v1/openapi.json`
  - `fixtures/contract.json`
  - the TS constants
  - Swift `AidenRemoteContract.swift`
  - Kotlin `AidenRemoteProtocol.kt`
  - the fixture tests

### iOS (`ios/AidenOnTheGo`)

- **Client:** `AidenRemoteClient.forkChat(chatId:messageId:position:summary:)`, plus the retry and cancel calls. The DTO gains `forkedFrom`.
- **Message context menu:** `AidenMessageView` currently offers Copy, Select Text and Ask About This. It gains:
  - **Fork from Here** and **Fork with Summary…** on assistant replies;
  - **Edit in Fork** on user messages;
  - matching accessibility actions.
  - All of these are hidden when the host lacks `chat-fork-v1`.
- **After forking:** push the new chat and seed the composer draft from `prefill`. This reuses the per-chat draft path and its pairing-generation fencing.
- **Lineage:**
  - a lineage row at the top of the transcript, with the summary card and the pending, failed and retry states;
  - a fork glyph in `AidenWorkspaceChatsView` rows.
- **New Swift files** must be registered in pbxproj and in the `scripts/check-ios-shipping-target.test.mjs` allowlist.

### Android (`android/app/.../AidenOnTheGo`)

- **Client:** `AidenRemoteClient.forkChat`, plus retry and cancel. `AidenChat` gains `forkedFrom`.
- **Message context menu:** `AidenMessageContextMenu.kt` currently offers Copy Text, Select Text, Ask about this and Share. It gains the same three actions, gated on the feature.
- **After forking:** navigate via `AidenChatViewModel` and seed the composer from `prefill`.
- **Lineage:**
  - a lineage row with the summary card in `AidenChatDetailScreen`;
  - a glyph in `AidenWorkspaceChatRow`.

### CLI (`packages/cli`)

- **`aiden serve`:** `remote-chats.ts` already composes `createChatApplicationService`. The route works there once the daemon journal adapter (`daemon-chats/journals/<sha256>.jsonl`) implements `forkChat` and summary generation.
- **CLI TUI:** it runs pi's interactive mode. Check whether pi's own `/fork` and `/tree` are reachable. If they are, document them in `packages/cli/README.md` instead of adding duplicates.

### Onboarding

No onboarding step: forking is not setup-critical. Advertise it as a bento tile only if you want it in the tour. A tile needs its own 1024 × 1024 asset.

## Delivery: five PRs

1. **Desktop fork**
   - Scope: `position`, lineage metadata and `(fork N)` titles, the application-service move, message actions, `/fork` picker user rows, pre-fill, lineage row and sidebar glyph.
   - Tests:
     - store tests for the `before` and `after` boundaries and lineage;
     - handler parse tests;
     - a picker test;
     - Playwright for both actions and the pre-fill.
2. **Pi journal fork**
   - Scope: `forkChat` with marker remapping and fallback.
   - Tests:
     - a replay test showing the fork's model context contains the source's tool results and compaction checkpoint up to the cut, and nothing after it;
     - a crash-recovery test.
3. **Fork with summary (desktop)**
   - Scope: background generation, `branch_summary` journal entry, `forkedFrom.summary` states, held first send, cancel/retry/continue, summary card, usage accounting.
   - Tests:
     - summarizer input boundaries: only entries after the cut;
     - the held-send lifecycle;
     - failure leaves held messages paused;
     - the model context contains the summary.
4. **Remote and daemon**
   - Scope: routes, projections, revision 21 contract set, CLI daemon, paired-Mac desktop actions.
   - Tests:
     - router tests for idempotency, `If-Match`, `409`/`404`/`422`, and summary retry/cancel;
     - fixture and contract tests;
     - a CLI daemon test.
5. **iOS and Android**
   - Scope: clients, menus, pre-fill, lineage row, summary card states, glyph.
   - Tests: focused decode and view-model tests on both platforms, and the mobile suites run.

Dependencies:
- 2 and 1 can land in either order.
- 3 needs 1 and 2.
- 4 needs 1. The summary routes need 3.
- 5 needs 4.
