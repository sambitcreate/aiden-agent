# Saved helper conversations — 2026-11-22 (helper chat plan, Phase 2)

Plan: `docs/plans/subagent-helper-chat-plan.md` (PR 2 section). Branch `claude/subagent-helper-chat`; Phase 3 (the side-panel helper chat UI) reads what this phase saves.

## Shape

- `renderer/shared/subagent-transcript.ts`: `SubagentTranscriptV1` {version 1, runId, revision, trimmed, entries}. Entry 0 is `{kind: "task", text}`; later entries are `{kind: "message", text, steps: AgentStep[], startedAt, finishedAt?}`, using the main chat's `GenerationTimeline` step format. Strict parsers for the transcript, the live update and the `{streamId, update}` notification. Caps: 2 MB serialized, 600 entries, 200k chars of text per entry.
- Live update `SubagentTranscriptUpdateV1`: {runId, baseRevision, revision, trimmed, entryCount, changes[{index, entry}]}. Only changed entries are sent; the current message is re-sent whole on each update.
- Late joiner: subscribe first, then read the saved copy; `mergeSubagentTranscript(saved, live)` returns `{transcript, complete}` (`complete: false` on a revision gap). `foldLiveSubagentTranscript` keeps the newest 16 runs per window.

## Recording

- `subagent-transcript-recorder.ts` maps Pi events as the main chat does (`observe`: thinking, `toolcall_start` as a pending step, text with content offsets, `message_end` with `terminalAssistantActivityAnchors`, tool update/end with `result.details`), or takes the CLI's direct calls, into `GenerationTimelineProjector`. MCP tool labels are not special-cased (left as the generic label); `textStart` is 0 because text is per message; reasoning is not stored, so reasoning segments are not reconciled. Terminal status follows the main chat: cancelled once the runner calls `cancelling()` (before each `child.cancel` and on parent abort), blocked when the wrapped `beforeToolCall` refused the call (`toolBlocked(id)`; CLI: the approval rejected while the helper was not stopping), else failed/completed. In the CLI, as on the desktop, a tool that ends after the stop (even successfully) shows as cancelled. A failed final save is always reported once, even after an earlier failure was. Throttled to 250 ms with backoff after failures (2^n steps, cap 20); failures are reported once per run of failures and retries pause after `SUBAGENT_TRANSCRIPT_RETRIES_BEFORE_PAUSE` (5) until the next change; one save in flight at a time; revision 1 (task alone) is enqueued from the constructor.
- Each revision is persisted, then published. A failed persist publishes nothing, keeps the state dirty and retries; the final save tries 3 times, with unref'd backoff timers. Revision numbers advance only on a successful save, so the stream always chains.
- Trimming uses cached per-entry sizes (`trimSubagentTranscriptToBytes(..., entryBytes)`), and what a trim dropped is applied back to the recorder (closed messages frozen, dropped step ids and characters remembered), so later saves never bring it back.
- Text and every step string (label, target, detail) go through `sanitizeSubagentWorkText` (`subagent-work-text-filter.ts`, built on `sanitizePartialFindingsForParent`), the parent/helper credential filter: `[REDACTED CREDENTIAL]` / `[REDACTED]`, private key blocks (complete or cut off) hidden, same-line secret-named values (`OTP:`, `PIN=`, `PASSCODE:`, `CVV:`, `SEED:`) hidden, wrapped secret tails and recovery phrases hidden, prose such as `OTP: sent by SMS` or integer seeds kept, paths kept. The panel's `sanitizeVariant` also runs `redactSecretNamedSameLineValues`. Not the panel's `sanitizeSubagentSnapshotText`. While a message streams, `streamingVisibleText` holds back the unfinished last word and any open `-----BEGIN` block. Sanitizing is per entry, so a secret split across two entries is not caught. The filters are best-effort heuristics and cannot catch every layout. Round 3 coverage: phrase names after a leading word ("Secret recovery phrase", "My seed phrase"), "seed words", unindented/numbered/split/other-case phrase blocks (`redactUnindentedPhraseBlocks`, standard lengths 12–24 preferred) and unindented recovery codes; weak names (`otp`, `pin`, `cvv`, `seed`, `signature`, `private`) keep only values in `PLAIN_WEAK_VALUE` (algorithm/type/method words), and "PIN code"/"PIN number" are names; token counts (`max_tokens: 4096`) and path/file/version lines after a hidden value stay. Wrapped tails (`isWrappedSecretTail`, shared by both filters; the panel runs `redactWrappedSecretTails` too) chain, and accept a 16+ character piece without digits or a first token followed by a space. Known limit: a tail that reads as one capitalised word with punctuation ("Word.") is kept, because it cannot be told apart from "Done.".
- Edits: the helper's `write_file`/`edit_file` (`subagent-workspace-write.ts`) return `file_line_changes` details; the desktop passes `result.details` through `observe`, the CLI forwards them in `subagent-process.ts`, so steps carry `lineChanges`.
- `SubagentTranscriptRecordings` in `subagent-supervisor-core.ts` wraps every child (in-process and inference-process helpers). It hands the result back without awaiting `finish` (the final save is tracked and awaited by `supervisor.flush()`), and the supervisor's seal settles a recorder whose child never returns. `supervisor.flush({ transcriptWaitMs })` caps the transcript wait; `llm-client` passes `SUBAGENT_TRANSCRIPT_TURN_END_WAIT_MS` (250 ms) before `appendMessage`, while the CLI flushes fully before closing its store. On quit, `main/index.ts` waits up to 1 s (`SHUTDOWN_BUDGET_MS.subagentConversations`) on `flushPendingSubagentTranscripts()`, a module-level set of every pending final save across chats and Bots, once after the subagent runtime stops and once after the Bot runtime stops. `transcriptStatus` maps interrupted and timed_out to cancelled, other non-completed statuses to failed. CLI recorder calls are wrapped so a throwing recorder is reported once and never breaks the helper.

## Storage and deletion

- `subagent-transcript-store.ts`: `<root>/transcripts/<sha256(chatId)>/<runId>.json`, mode 0600, `writeFileAtomic`, 512 per chat (oldest by mtime pruned; stale `*.tmp` files older than 60 s from a crashed save are removed first). Reads: O_NOFOLLOW, size cap, strict parser, runId must match. An in-memory deleted fence refuses late writes after a chat delete.
- Desktop root `userData/subagent-runs-v2`. `subagentRunStore.deleteChat` removes transcripts early (best effort); `completeChatDeletion` removes them first and rethrows, so the tombstone stays for `reconcilePendingChatDeletions` on the next start.
- `subagents:get` returns `transcript` only after ownership is proven (the request comes from an active app window, the run belongs to that chat and workspace, and the chat's history references the run), asked with the owning chat id. No window-to-chat binding exists, so any live app window can read a chat it names.
- Live stream `chat:subagent-transcript`, sent only to the owning window, not journaled.

## Bots and the CLI

- Desktop Bot helpers record through the same factory; there is no read path for them (Bot runs have no history snapshot view).
- `aiden serve`: `bot-subagents.ts` saves under `<agentDir>/bot-subagent-history/<sha256(chatId)>/transcripts/…` with chat key `cliSubagentIdentity(chatId)`; `deleteCliBotSubagentHistory` removes them. Thinking steps are not recorded there. No Remote protocol revision was claimed; phones get nothing.

## Correction to the Phase 1 notes

The panel label rule is not an allow-list. `colonBlockNameIsLabel` accepts a bare all-capital word of letters with no secret hint; `blockNameHasSecretHint` applies the secret-ending match only to setting-shaped names (all caps, `_`/`-`, or camelCase) and otherwise needs an exact secret word, plus a few whole names and a whole-segment `PIN`. The plan's Risks row now says this.

Tests: `renderer/shared/subagent-transcript.test.ts`, `main/services/subagents/subagent-transcript-recorder.test.ts`, `main/services/subagents/subagent-transcript-store.test.ts`, `subagent-semantic-preservation.test.ts` (key blocks, same-line secret names, labels that survive), the CLI recording test in `packages/cli/tests/parity.test.mjs`, plus extensions to `subagent-history-read-core.test.ts`, `subagent-workspace-write.test.ts` and `renderer/lib/generation-stream.test.ts`.

# The helper chat — 2026-11-22 (helper chat plan, Phase 3)

Plan section "## The helper chat". Same branch; all three phases ship as one PR.

## Where it lives

- `renderer/components/subagent-helper-chat.tsx`: the read-only chat for one helper (header with status dot, name and "Role · Status · elapsed"; the task as the first bubble; each message drawn with the main chat's step rows via `subagentHelperTimeline`; problem box with **Ask main chat to retry**; bottom bar with Stop, Expand, Technical details). `subagent-helper-chat-expanded.tsx` fills the main pane (composer hidden; Back or Esc returns focus to the opener).
- `renderer/lib/subagent-helper-chat-state.ts`: pure helpers (tone, active, work summary, problem text and retry request, `subagentHelperApprovalFor`, timeline). `renderer/lib/subagent-helper-chat-store.ts`: per-chat store (saved copies, live updates merged with `mergeSubagentTranscript`, refetch on a revision gap, approvals routed to the main chat's handler, expanded run and opener). `chat-pane.tsx` and `environment-panel.tsx` wire it; `subagents-panel.tsx` and `subagent-detail.tsx` show it in the side panel, and the old summary view only as the fallback for helpers with no saved conversation (what it was asked, what it did, result; the context line moved into Technical details).
- `ui.tsx` ScrollArea gained a `bodyReplacement` path so the expanded chat stays visible (covered in `scroll-area-follow.test.tsx`).

## Status words

- One set everywhere: Queued, Running, Waiting on you, Done, Failed, Stopped (`STATUS_LABELS` in `subagent-view-state.ts`; starting→Queued, timed_out→Failed, interrupted/unknown→Stopped). `subagentStatusCounts` builds every count summary (card header, pill, overview, live announcement) in the order Waiting on you, Running, Queued, Failed, Stopped, Done. Status groups: Running, Waiting on you, Failed, Stopped, Done (unknown is Stopped). Stale leads: "Still running", "Still queued".
- A helper asking for a run grant stays `running` in its record ("Preparing a workspace update"). The helper chat shows "Waiting on you" (and the waiting tone) while it holds a matched approval; the card row and list still say Running. Known gap.
- The pill's narrow fallback and aria label still say "N finished" for a settled batch (a batch word, not a status word).

## Known limits

Non-helper approvals are hidden while a helper chat is expanded, and their shortcuts are off; the side-panel copy of an approval has no shortcuts; a running helper that missed early updates shows the fallback until its next save; the side panel keeps showing the same helper while it is expanded; the timed_out warning colour folded into red.

Tests: `subagent-helper-chat.test.tsx`, `subagent-helper-chat-state.test.ts`, `subagent-helper-chat-store.test.ts`, `scroll-area-follow.test.tsx`, E2E `tests/e2e/subagent-helper-chat.spec.ts`.
