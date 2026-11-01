# Inbox sidebar (planned 2026-10-31; Phase 0 and 1a–1c built)

Plan: `docs/plans/inbox-sidebar-plan.md`. Before/after page: https://claude.ai/artifact/TvjFoaj4FL5Ej5pn69GVqc (private). Research came from 10 passes over OpenCode's Inbox (`~/projects/opencode`) and T3 Code's sidebar (`~/projects/opp/t3code`).

## Owner decisions
- Option D, Hybrid Inbox: Needs you / Updates / Earlier, plus a Working shelf pinned to the bottom. Opt-in, labelled Beta; By workspace stays the default.
- Inbox **replaces** the Needs attention view: a stored `view: "attention"` migrates to `"inbox"`.
- One stored value: `SidebarPreferences.view` (localStorage). The Appearance → Sidebar cards and the Organize menu share it through `useSidebarView()`. There is no `AppearanceConfig.sidebarStyle`.
- Rows have no inline actions or request preview (owner, 2026-10-31): two-line ~46 px rows like OpenCode's, coloured status + wait time, the request only in the tooltip. Clicking opens the chat or Bot with Deny (or the answer field) focused; Approve/Deny/answer happen there. Hover icons (Mark read; Phase 2 Done/Snooze/Pin) overlay Updates/Earlier/Pinned rows only.
- Phase order:
  - 0: split `chat-sidebar.tsx` into `renderer/components/sidebar/`.
  - 1: desktop, no Remote revision.
  - 2: `ChatTriageStore` for Done, Snooze and Pin, kept outside the chat index like read markers; `inbox-signals-v1`; Dock badge; `aiden serve` hosts.
  - 3: phones on the host-computed `inboxBucket`.
- Bots appear only in the Inbox, and only while they need the person, have a failed run or have an unread reply. This is an amendment to the unified sidebar plan.
- Phase 1 adds no analytics event; `sidebar_view_changed { view }` is an optional later item.

## Edge-case review facts (2026-10-31, folded into the plan)
- **Local prompts detach.** Leaving a local chat calls `cancel("lifecycle")` (`chat-pane.tsx:865-873`), and pending prompts settle `"detached"` (`tool-approval.ts`). Local Needs you therefore comes only from the open chat, a chat open in another window, Remote-origin runs, Bots, detached prompts (row "Unavailable", "Approval unavailable — return to retry") and `interruptedWaits` (row "Interrupted"). E2E must raise approvals from a Remote-origin run (Aiden has one main window, so the second-window option does not exist).
- Times and summaries come from `HostRunRegistry` via `chats:pendingAttention` → `{ kind, summary, since, runStartedAt, count }`. `ChatActivityRegistry` holds only id sets. Opening a chat focuses Deny on the docked approval card; nothing scrolls.
- Remote summary rows can't carry prompt text (`protocol.ts:2491`), so remote tooltips are status/host/wait until 2b adds `attentionSummary`. Non-online hosts' rows dim, freeze and leave the counts and badge.
- ⌘1–9 skips remote rows today; including them is a behaviour change, keyed by `projectOrderKey(hostId, chatId)` and following the frozen order. Bot routes swap in `BotSidebar`, which owns ⌘1–9 there.
- `aiden serve` lacks `/host/events`, `HostRunRegistry`, read markers and activity; 2d builds them. Desktops don't negotiate `bot:issues`, so remote Bot state goes on feed Bot rows. Triage is last-writer-wins per field with a revision (Undo uses `ifRevision`). Phones have 30 of 32 feature tokens used.

## Phase 0 done (2026-10-31, branch `claude/inbox-sidebar-plan`)
- `renderer/components/sidebar/`:
  - `chat-row.tsx`: `ChatRow` for local and remote rows. Status pill, context slot, ⌘ hint, the context menu and ••• menu from one `menu: ChatRowMenu` builder. `layout: ChatRowLayout` is `"standard"` only; the Inbox two-line row joins that union rather than forking the component. The rule "the open chat never shows unread" (`selected`) lives here. `aria-busy` is `busy || state === "working"`.
  - `row-group.tsx`: `RowGroup`, the disclosure group used by workspace and remote project groups.
  - `section-header.tsx`: `SectionHeader` (label, count, accessory, actions, optional collapse button).
  - `sidebar-overflow-menu.tsx`: moved out of `chat-sidebar.tsx`. Placement maths is the pure `overflowMenuPlacement(trigger, sidebar, viewportHeight)`.
  - `remote-chat-row-menu.tsx`: `remoteChatRowMenu(actions, handlers)` builds the remote row's menu items.
- `chat-sidebar.tsx` keeps state, data reads and view switching.
- Remote ••• menu: `remoteChatRowActions(chat, remoteHostCapabilities(view))` in `sidebar-remote-groups.ts`.
  - Open is always shown.
  - Mark read needs an unread row plus `markRead` (`chat-read-state-v1` + `chat:read`).
  - Rename needs `rename` (`chat:write`) and the row's `revision`.
  - On stale hosts, Mark read and Rename are disabled.
  - The calls go through a short-lived `RemoteHostAdapter`, and the host feed refreshes the rows.
  - Rename stores only `{hostId, chatId, hostLabel}`. On Save it reads the revision from the newest feed row, because the host bumps the summary revision on every write and a Working chat moves often. On `revision_conflict` it retries once if the row moved, otherwise it toasts "This chat changed on <host>. Try again." A host unpaired while the dialog is open closes it with an error toast.
  - `RemoteHostAdapter.chatChanged` now reaches every live adapter for the same host (module-level `liveAdapters`), so a sidebar rename makes the open remote pane's `RemoteChatSession` reread. Invalidating `hostQueryKeys.messagesWindow` would do nothing: the session reads and writes that cache directly and it has no `useQuery` observer.
  - Delete and other control actions are omitted.
- `usePeerHostSidebar` now also returns `views`.
- Tests: `renderer/components/sidebar/chat-row.test.tsx` (happy-dom: menu rendering, RowGroup toggle) and `sidebar-overflow-menu.test.ts`, run by `test:chat-row-states`; the cross-adapter reread is in `main/services/peer-remote-chat-control.test.ts`.

## Phase 1a data layer done (2026-10-31, same branch; no UI yet)
- `renderer/lib/sidebar-inbox.ts` (pure, no clock/storage): `inboxState(signals, now, recentWindowMs?)`, `organizeInbox(rows, now, {recentWindowMs, earlierLimit, showAllEarlier})` → sections + `hiddenCount`, `earlierMoreCount`, `needsYouCount` (online hosts only), and the freeze helpers `inboxDisplayOrder`, `releasedInboxOrder`, `freezeInboxOrder({previous, next, touched, present, earlierOverflow?, earlierLimit?})`. The open chat is never unread and never ages out of Earlier. Rows key by `projectOrderKey(hostId, chatId)`.
- (Superseded by 1b: `attention` is gone and migrates to `inbox`.) `SIDEBAR_VIEWS` now includes `"inbox"` alongside `"attention"`; the attention→inbox migration and removal are left to 1b. Until then a stored `inbox` lays out like attention. `SidebarPreferences.workingShelfCollapsed` (default false).
- `renderer/lib/use-sidebar-view.ts` owns `SIDEBAR_PREFERENCES_KEY`: `readSidebarPreferences()`, `writeSidebarPreferences(patch, validLocalProjectIds?)` (re-reads storage, merges per field, prunes, skips no-op writes), `useSidebarView()`, `useWorkingShelfCollapsed()`. Cross-window via `storage`. `chat-sidebar.tsx` writes only its own changed fields through it.
- `chats:pendingAttention(ids)` → `ChatPendingAttention[]` (`renderer/shared/chat-pending-attention.ts`): `{chatId, kind: approval|question|detached|interrupted|working, summary ≤200, since?, runStartedAt?, count}`. Unknown/idle chats omitted; >2,000 or unsafe ids throw. `chats:dismissDetachedAttention(id)` clears Unavailable prompts (1b should call it when the chat opens). Bridge: `chatsApi.pendingAttention` / `dismissDetachedAttention`.
  - Main: `main/services/chat-pending-attention.ts` (`DetachedPromptLog`, `createPendingAttentionRecorder`, `pendingAttentionForChat`, `readInterruptedRunWaits`), wired in `chat-pending-attention-main.ts` (service + handler). `llm-client.detachRenderer` calls `runDetached(streamId)` before settling prompts (skipped while quitting: those become interrupted waits); `recordRunBegin` site calls `runBegan(chatId)`.
  - `HostRunRegistry.promptRaisedAt(id)` is new. A detached run that raises a new prompt after the detach never journals it (send fails), so it is not logged.
- Tests: `sidebar-inbox.test.ts`, `use-sidebar-view.test.tsx` (test:sidebar), `main/handlers/chat-pending-attention.test.ts` (test:chat-row-states).

### Phase 1a review fixes (2026-10-31)
- Short-circuited prompts: `ToolApprovalCoordinator` and `AskUserQuestionCoordinator` take an `onShortCircuited(prompt)` third constructor arg, called (guarded by try/catch) when a request is refused because its stream was detached (not on cancel/abort). `llm-client` wires it to `pendingAttentionRecorder.promptShortCircuited(streamId, prompt)` (since = now), skipping unattended runs (`ActiveGeneration.promptsUnattended`) and quitting. This replaces the "not logged" note above.
- `pendingAttentionForChat` ignores an interrupted wait whose `runStartedAt` predates the live run's (chat shows Working).
- `InterruptedWaitStore.snapshot()` (one load → `{chatIds, forRun}`) replaced `chatIds()`; `readInterruptedRunWaits(ids, {waits, onError})` reads once per call; main wiring logs `logger.warn("chats", …)`.
- `releaseChatContext` (chat delete) calls `detachedPromptLog.clearChat`.
- `clipPendingAttentionSummary` strips `\p{Cc}`/`\p{Cf}` (bidi overrides, zero-width) after collapsing whitespace.
- Earlier cap: an open chat past the cap takes the last of the 20 slots; `InboxOrganization.earlierOverflow` lists the rest (`earlierMoreCount` = its length). `freezeInboxOrder` takes `earlierOverflow` keys + `earlierLimit`: a row that only fell past the cap is not leaving; frozen Earlier drops new arrivals, then untouched overflow rows, to stay at the cap; `heldEarlierMoreCount(held, live)` is the frozen Show more count. 1b must pass both and use that count.
- `useSidebarPreferencesFromOtherWindows(cb)` in `use-sidebar-view.ts`; `chat-sidebar.tsx` refreshes its sort/order/expansion/filter/grouping state (and `writtenPreferences`) from it.
- (Superseded by 1b.) A stored `inbox` shows as Needs attention in the sidebar title and the Organize menu (radio checked, no Sort chats group).
- `parseSidebarPreferences(value, validIds?, knownViews = SIDEBAR_VIEWS)`; the downgrade test parses with `knownViews` minus `inbox` and expects `projects`.

## Phase 1b/1c done (2026-10-31, same branch)
- `parseSidebarPreferences` maps a stored `"attention"` to `"inbox"`; `SIDEBAR_VIEWS` no longer has `attention`. The sidebar title reads "Inbox" in the Inbox and "Recents" otherwise; the Organize radio is `aria-label="Inbox (Beta)"`.
- `renderer/components/sidebar/inbox-view.tsx` (`InboxView`, `InboxRowContext`): Needs you / Updates / Earlier as `role="group"` sections, Earlier capped at 20 then "Show N more", the collapsible Working shelf (≤40% of `[data-sidebar]` height via ResizeObserver), "Nothing needs you" (`role="status"`) when the three main sections are empty. Rows are wrapped in `<div data-inbox-row={projectOrderKey}>`; the root has `data-inbox-view` and `data-inbox-frozen`.
  - Freeze (`useListInUse`): pointer inside, `:focus-visible` inside (not when `data-input-modality="pointer"`), or any `[role=menu|dialog|alertdialog]` in the DOM (MutationObserver on `<body>` childList, re-checked once the observer attaches, because the Organize menu that switches to the Inbox can close in between). Window blur or a hidden window releases. Search and machine-filter changes reset the order at once. Leaving Needs you lingers 400 ms; a held row shows its live status. FLIP: moved rows slide ≤40 px for 150 ms, skipped under Reduce Motion, past 40 moving rows, and right after a reset or a freeze release.
  - ⌘1–9 and chat.previous/next follow the frozen order (remote rows included) through `registerCommand("chat.jump.N")` in `chat-sidebar.tsx`; on Bot routes with `view=inbox` the Inbox stays.
- `renderer/lib/sidebar-inbox-view.ts`: `localInboxEntries`, `remoteInboxEntries`, `filterInboxEntries`, `inboxRowStatus` (label, wait, tone), `inboxRowDescription` (tooltip + `aria-description`: "Approve: …", "Question: …", "Approval unavailable — return to retry: …"), `inboxRowAction` (Mark read on unread Updates/Earlier rows, Acknowledge on Failed Needs you rows, nothing else), `markReadThroughMessageId`.
- `ChatRow layout="inbox"` in `chat-row.tsx`: two-line row, `data-inbox-status`, one hover icon (`data-inbox-action`), no request preview.
- `chat-sidebar.tsx` queries `chats:pendingAttention` keyed on the activity revision (never polled) for the newest 2,000 chats. `chat-pane.tsx` calls `dismissDetachedAttention` on open and invalidates the query; after a prompt resolves it restores focus only when the previous focus was outside `[data-sidebar]`.
- Tests: `renderer/lib/sidebar-inbox-view.test.ts`, `renderer/components/sidebar/inbox-view.test.tsx` (test:sidebar); e2e `tests/e2e/inbox-sidebar.spec.ts` (real approval → Approval row → New Agent → Unavailable row and tooltip → reopen clears it; mocked Remote-origin approval via `remote:getPendingApproval` + `chats:activity-changed` revision 1_000_000 → ⌘1 and row click focus Deny → Allow moves the row to Working) and the Inbox case in `chat-shell-interactions.spec.ts` (held places while hovered, then Needs you / Earlier / Working).
- Not built yet: the blocked-host Reconnect notice (blocked hosts' rows are just left out), Bots in the Inbox, the Appearance → Sidebar cards and README/PRODUCT/settings docs (all 1d).

Related: [[chat-row-states]], [[sidebar-chat-row-context]], [[multi-host-control]].
