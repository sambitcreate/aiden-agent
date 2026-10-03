# Multi-host PR 5a: local sidebar organization

Status: **In review**. This is the local-only first half of §6 ("Sidebar organization") of the [desktop multi-host control plan](desktop-multi-host-control-plan.md). It is based on `main` and can merge on its own.

PR 5b adds remote rows, the machine filter, the globe marker, cross-machine grouping and offline/stale state. It plugs into the projection module from this PR and does not change it.

## Scope

The existing **Organize sidebar** menu gains three radio groups.

- **View**
  - *Workspaces*: the existing workspace groups. The master plan calls these "Projects". The UI keeps Aiden's existing "Workspaces" wording.
  - *Recent*: the existing flat chronological buckets (Recent / Yesterday / month / Older).
  - *Needs attention*: a new triage view. Chats are ordered by tier, then by last activity, newest first. Each tier that has chats gets its own section, in this order:
    1. Needs approval
    2. Needs input
    3. Working
    4. Unread
    5. Other chats
- **Sort chats**: *Last activity* (default) or *Created*. Applies in the Workspaces and Recent views.
- **Sort workspaces**: *Last activity* (default), *Created* or *Manual*. Applies in the Workspaces view.

## Decisions

- **Pure projection module.** `renderer/lib/sidebar-organization.ts` is pure and generic.
  - Its inputs are plain summaries:
    - project: `key`, `name`, `searchText`, `createdAt`, `lastActivityAt`
    - chat: `key`, `projectKey`, `title`, `createdAt`, `lastActivityAt`, `attention`
  - Callers may extend the summaries with their own payload, and get the same objects back.
  - The local adapter (`renderer/lib/sidebar-workspace-groups.ts`) maps `Workspace` / `ChatMeta` plus the row-state signals into summaries. PR 5b adds a remote adapter that feeds the same function.
- **Attention tier.** The tier comes from the existing row signals: `chatRowStateFor(...)` for approval, input and working, and `isChatUnread(...)` for unread. Working-and-unread counts as Working. The chat you have open never counts as unread, the same rule its row badge already follows.
- **Ordering inside Needs attention.**
  - Always by last activity, as the master plan specifies. The chat-sort preference does not apply here.
  - The *Sort chats* group is hidden in this view.
  - The *Sort workspaces* group shows only in the Workspaces view.
- **Missing or invalid timestamps** sort after every dated item. Ties break by name or title (`localeCompare`), then by key, so identical names keep a deterministic order.
- **Workspace last activity** is the newest of the workspace's own `updatedAt` and its chats' last activity. This is the existing rule, now applied inside the projection.
- **Recent with *Created* sort** buckets each chat by its creation time. Chats without a usable timestamp go in "Older". The clock (`now`) is injectable for tests.
- **Manual order**
  - Stored as a list of host-qualified project keys: `projectOrderKey(hostId, projectId)` → `encodeURIComponent(hostId) + ":" + encodeURIComponent(projectId)`, with `LOCAL_SIDEBAR_HOST_ID = "local"`.
  - Choosing *Manual* saves the order currently on screen, so the list does not jump.
  - Workspaces missing from the stored order go after the stored ones, in last-activity order. This follows T3 Code's `orderItemsByPreferredIds`.
- **Reordering**
  - In Manual sort, with no search, workspace headers can be dragged. A thin accent line shows the drop position; it is a functional indicator, not a decorative border.
  - The keyboard alternative is **Move up** / **Move down** in the workspace's Actions menu. These items:
    - show only in Manual sort
    - are disabled at either end of the list
    - are disabled while a search is active, because the filtered neighbours would hide the effect
- **Shortcuts follow the screen.** Chat jump shortcuts (⌘1–9) and previous/next navigation follow the rows in the order they are displayed. Before this change, Workspaces mode re-sorted the visible rows by recency.
- **Preferences**
  - Same storage key, `aiden-agent.sidebar.v1`, with these new fields: `view`, `chatSort`, `projectSort`, `projectOrder`.
  - A legacy `organization` value is migrated: `workspace` → `projects`, `recent` → `recent`.
  - The legacy `organization` field is still written, so a downgraded build keeps the user's view.
  - `projectOrder` is bounded to 500 keys. Malformed keys are dropped. `local:` keys are pruned against the workspace registry. Other host keys are kept, for PR 5b.
- **No onboarding change.** This is an organizational preference, not a setup-critical feature.

## Tests

- `renderer/lib/sidebar-organization.test.ts`
  - Projection behaviour: tiers, ties, missing timestamps, identical names, manual order with unknown and stale keys, search, and move helpers.
  - Preference migration and bounds.
- `renderer/lib/sidebar-workspace-groups.test.ts`: the local adapter's admission rules (registered workspaces only; no Bot, Assistant or orphan chats).
- `renderer/components/sidebar-organize-menu.test.tsx`: the rendered menu's radio semantics and which groups show in each view.
- `renderer/components/chat-sidebar.test.tsx`: the source-grep assertions about organization were replaced by the behavioural coverage above.
- `tests/e2e/chat-shell-interactions.spec.ts`: the Needs attention section order driven by live activity snapshots, and Manual sort with Move down persisting across a reload.
