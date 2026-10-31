# Inbox sidebar (planned 2026-10-31)

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
- **Local prompts detach.** Leaving a local chat calls `cancel("lifecycle")` (`chat-pane.tsx:865-873`), and pending prompts settle `"detached"` (`tool-approval.ts`). Local Needs you therefore comes only from the open chat, a chat open in another window, Remote-origin runs, Bots, detached prompts (row "Unavailable", "Approval unavailable — return to retry") and `interruptedWaits` (row "Interrupted"). E2E must raise approvals from a second window or a Remote-origin run.
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

Related: [[chat-row-states]], [[sidebar-chat-row-context]], [[multi-host-control]].
