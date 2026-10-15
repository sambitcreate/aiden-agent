# Multi-host PR 5b: remote sidebar rows

Status: **Complete**; merges with the multi-host stack. This is the remote half of §6 ("Sidebar organization") of the [desktop multi-host control plan](desktop-multi-host-control-plan.md). It is stacked on PR 3 ([peer manager](desktop-multi-host-pr3-peer-manager.md)) and merges PR 5a ([local sidebar organization](desktop-multi-host-pr5a-sidebar-organize.md)).

## Scope

- **Remote adapter.** Each paired host's feed cache (PR 3) maps into the same `organizeSidebar` inputs as local workspaces. Every remote row is host-qualified, so identical chat IDs, workspace IDs and names on two machines never collide.
- **Machine filter.** *All machines* (default), *This Mac*, or one paired host. It lives in the Organize menu and shows only when a host is paired. When it is not *All machines*, a compact chip in the sidebar header names the machine and clears the filter.
- **Globe marker.** Remote chat and workspace rows carry a soft globe. Its tooltip and accessible name are "On <host name>". Two hosts with the same name get a short instance suffix.
- **Group across machines.**
  - *Keep separate* (default): one group per machine and workspace, labelled with the machine.
  - *Same repository*: merges workspaces whose repository `canonicalKey` matches, with a badge per machine.
  - *Same repository and path*: also requires the same `relativePath`.
  - Workspaces without a repository identity never merge.
- **Offline and stale.** When a host is offline or blocked, its last-known rows stay visible, marked stale and read-only. The host shows "Offline · Reconnect" (or "Needs re-pairing" when blocked). Mutations on its rows are disabled.
- **Needs attention.** Remote chats join the attention view from the feed's run state and row hints.
- **Navigation stub.** A remote chat opens `/host/$hostId/chat/$chatId`, a placeholder pane that PR 6 replaces with the real remote chat view.

## Decisions

- **Supervision starts only with an enabled host.** The sidebar reads the registry list (`remote:peersList`, which never starts the manager). It asks for statuses and feeds only when at least one host is enabled. With no paired host, nothing new renders and the Organize menu is unchanged.
- **Renderer store.** `usePeerHostSidebar()` keeps one snapshot per host. It applies `remote:host-feed` messages with a pure reducer, takes `remote:peer-host-state` only when its `generation` is newer, and refetches when `remote:peers-changed` fires. A feed message whose epoch or sequence does not follow the snapshot triggers a fresh snapshot read rather than a guess.
- **Query keys.** Host-scoped data uses `["host", hostId, …]` (`renderer/lib/hosts/host-query-keys.ts`). Host-agnostic lists use `["hosts", …]` so a host ID can never shadow them.
- **Row keys.** Remote project keys are `projectOrderKey(hostId, workspaceId)`, the same host-qualified form PR 5a stores for manual order. Chat keys use the same encoding with the chat ID. Local keys keep the `local` host.
- **Attention.** The newest run for a chat wins while it is working, waiting for approval or waiting for input. Otherwise the summary's `rowState` applies. Unread is the summary hint or the newest run's flag.
- **Local repository identity.** Merging needs the local workspaces' repository identity. A new `workspaces:repositoryIdentity` read reuses the cached Git info read, and is only made when a peer is paired and a merging mode is chosen.
- **Reconnect.** `remote:peerReconnect` restarts a backing-off host immediately with a fresh backoff schedule. It does nothing for a blocked host: blocked hosts clear only by re-pairing or disabling and re-enabling, as in PR 3, so the sidebar links those to Settings → Connections instead.
- **Three separate selections.** The machine filter only changes the list. The host of the selected chat comes from the route. The composer host is untouched (PR 8).
- **Merged groups and new chats.** A merged group's "new chat" uses the local workspace when it has one. Asking which machine to use belongs to PR 8.
- **No onboarding change and no tour tile.**

## Tests

- `renderer/lib/sidebar-remote-groups.test.ts`: identical names and IDs across hosts, the filter, the grouping modes, stale rows, attention.
- `renderer/lib/hosts/peer-host-feed-state.test.ts`: the feed reducer and status ordering.
- `renderer/components/sidebar-remote.test.tsx`: the filter chip, the globe marker, machine badges, and the offline and blocked status rows, rendered to static markup.
- `renderer/components/sidebar-organize-menu.test.tsx`: the Machines and Group across machines menu groups, shown only with a paired host.
- `renderer/lib/sidebar-organization.test.ts`: preference migration for the new fields.
- `main/services/peer-host-manager.test.ts` and `main/handlers/peer-host-live.test.ts`: reconnect.
- The sidebar Playwright suite runs real Electron with no peer fake, so this PR adds no e2e.

## Interfaces for PR 6, 7 and 8

- **Route.** `/host/$hostId/chat/$chatId` (`hostChatRoute` in `renderer/main/router.tsx`) rendered a placeholder in this PR. PR 6 replaced it with `RemoteChatView` (`renderer/main/remote-chat-view.tsx`); the path and params stay.
- **Selection.** `ChatSidebar` takes `activeRemoteChat: { hostId, chatId } | null`, kept apart from the local `activeChatId`. The composer host is not set here.
- **Rows.** These live in `renderer/lib/sidebar-remote-groups.ts`.
  - `RemoteSidebarProject` and `RemoteSidebarChat` carry `remote: true`, `hostId`, `hostLabel` and `stale`.
  - Groups are `SidebarProjectEntry` (`primary` plus `members`).
  - Keys are `projectOrderKey(hostId, id)`.
- **Hooks.** These live in `renderer/lib/hosts/use-peer-host-sidebar.ts`.
  - `usePeerHostSidebar()` returns `{ hosts, feeds }`.
  - `useLocalRepositoryIdentities(ids, enabled)`.
  - Query keys come from `hostQueryKeys` (`list`, `statuses`, `host`, `feed`).
- **IPC.** `remote:peerReconnect` (`peerHostsApi.reconnect`) and `workspaces:repositoryIdentity` (`workspacesApi.repositoryIdentity`).
