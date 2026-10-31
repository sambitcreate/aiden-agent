# Inbox sidebar (planned 2026-10-31)

Plan: `docs/plans/inbox-sidebar-plan.md`. Before/after page: https://claude.ai/artifact/TvjFoaj4FL5Ej5pn69GVqc (private). Research came from 10 passes over OpenCode's Inbox (`~/projects/opencode`) and T3 Code's sidebar (`~/projects/opp/t3code`).

## Owner decisions
- Option D, Hybrid Inbox: Needs you / Updates / Earlier, plus a Working shelf pinned to the bottom. Opt-in, labelled Beta; By workspace stays the default.
- Inbox **replaces** the Needs attention view: a stored `view: "attention"` migrates to `"inbox"`.
- One stored value: `SidebarPreferences.view` (localStorage). The Appearance → Sidebar cards and the Organize menu share it through `useSidebarView()`. There is no `AppearanceConfig.sidebarStyle`.
- Rows have no inline actions or request preview (owner, 2026-10-31): two-line ~46 px rows like OpenCode's, coloured status + wait time, the request only in the tooltip. Clicking opens the chat or Bot with its approval or question card focused; Approve/Deny/answer happen there. Hover icons (Mark read; Phase 2 Done/Snooze/Pin) overlay Updates/Earlier/Pinned rows only.
- Phase order:
  - 0: split `chat-sidebar.tsx` into `renderer/components/sidebar/`.
  - 1: desktop, no Remote revision.
  - 2: `ChatTriageStore` for Done, Snooze and Pin, kept outside the chat index like read markers; `inbox-signals-v1`; Dock badge; `aiden serve` hosts.
  - 3: phones on the host-computed `inboxBucket`.
- Bots appear only in the Inbox, and only while they need the person, have a failed run or have an unread reply. This is an amendment to the unified sidebar plan.

Related: [[chat-row-states]], [[sidebar-chat-row-context]], [[multi-host-control]].
