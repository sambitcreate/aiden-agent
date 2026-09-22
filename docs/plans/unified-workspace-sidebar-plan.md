# Unified Workspace Sidebar

Status: Active — Phases 1 and 2 are implemented on desktop, iOS, and Android; physical-device performance acceptance remains open.

## Outcome

Aiden now treats registered workspaces and their chats as one navigation graph. The default sidebar is grouped by workspace; a persisted **Recent only** mode presents the same chats as one time-ordered list. A chat is never rendered in both projections at once.

“Workspace” remains Aiden's canonical product and protocol term. The project-oriented screenshots are interaction references, not instructions to introduce a second Project entity or migrate existing IDs.

## Three independent proposals and triage

| Proposal | Strongest idea | Cost or risk | Decision |
| --- | --- | --- | --- |
| A — projection-first | Reuse the existing unscoped chat read and workspace registry, then build one client-side projection. Expansion is side-effect free and new-chat creation is explicit. | Mobile still receives full chat payloads for its global home read. | Selected as the Phase 1 baseline because it changes no shared protocol and ships the information architecture consistently. |
| B — summary-contract-first | Add a paginated chat-summary endpoint before changing any client UI. | Delays the user-facing improvement and introduces a cross-client/server migration before the navigation semantics are proven. | Deferred from Phase 1, then implemented as Phase 2 after the navigation semantics shipped. |
| C — adaptive-outline-first | Use the same grouped outline, but emphasize iPad detail-column selection and Android adaptive behavior. | Also proposed a new summary contract in the first delivery. | Its adaptive-navigation recommendations were incorporated into Proposal A. |

The integrated plan therefore used A's low-risk Phase 1 data path and C's iPad detail-column behavior, then delivered B/C's summary endpoint as a compatible Phase 2 migration.

## Interaction contract

- Default organization is **By workspace**. Each workspace is a disclosure row containing its chats.
- Expanding or collapsing a workspace never creates a chat, switches execution context, or navigates away.
- **New chat** is an explicit row/action. Selecting an existing chat may switch the active execution workspace before opening it.
- **Recent only** is an alternate projection, not a second section below the workspace outline.
- Search matches workspace names and chat titles. A matching workspace reveals its chats; a matching chat reveals its owning workspace.
- Empty workspaces remain visible and expose an explicit **New chat** action.
- Reserved Assistant records, Bot homes, archived workspaces, and chats whose workspace is no longer registered are excluded.
- Organization and disclosure state are device-local. Native clients scope it to the paired Aiden installation.
- Bots remain a separate product area and do not enter the workspace outline.

## Phase 1 implementation

### Electron

- The sidebar reads the registered workspace list plus the existing unscoped regular-chat metadata query.
- A pure projection whitelists chats by registered workspace ID, sorts workspace groups by newest activity, powers search, and produces the alternate recent list.
- The active workspace opens by default, disclosure state persists in bounded local storage, and long groups expose a bounded initial slice with **Show more**.
- Workspace actions moved onto their owning row: new chat, open latest chat, reveal folder, and safe remove/delete-worktree flows. Empty workspaces never create a chat through an open action.
- Sidebar organization and per-workspace ellipsis menus anchor outside the sidebar's right edge, preserving the navigation beneath them at every saved sidebar width; lower triggers align upward, tall menus scroll within available height, and open menus recompute on viewport changes.
- Existing route-driven selection, title reveal, keyboard chat shortcuts, working indicators, rename, and delete behavior are reused across both organizations.

### iOS and iPadOS

- The home list uses the same workspace-owned projection and a persisted per-installation organization/disclosure store.
- iPhone retains push navigation. On regular-width iPad, selecting a chat presents it in the detail column rather than a modal sheet.
- Device-local workspace archive state is applied before projection and stale disclosure IDs are pruned.
- Chat-list readiness is scoped to the active installation/request lease. Initial reads (including reads with cached rows), installation switches, and failures block new-chat/workspace creation until the current installation loads successfully; failures render an explicit retry state and stale requests cannot overwrite a newer load. Connection-driven task cancellation is non-failing, and a unique load-attempt fence lets the restarted task supersede the cancelled request without being skipped.

### Android

- Compose uses the same pure workspace-owned projection and explicit empty-workspace creation row.
- Organization and disclosure state persist per installation in the existing product navigation store and are removed with installation data.
- The separate directory is retained as **Manage Workspaces** for CRUD and environment details.
- Chat-list readiness is scoped to the active installation/client request. Initial reads (including reads with cached rows), installation switches, and failures block every creation entry point until the current installation loads successfully; failures render an accessible retry state and stale requests cannot complete a newer load.

## Independent review hardening

Two fresh-context reviews were completed before publication, split across desktop behavior and native-client parity. Their confirmed findings were incorporated:

- Workspace disclosure preferences are pruned only after authoritative registries/snapshots load, so cold launch and installation changes cannot erase state.
- Desktop chat loading and failures are distinct from a successful empty result; empty-workspace creation is available only after the list resolves.
- Desktop shortcuts are derived from the rows actually rendered, and duplicate workspace names are disambiguated in rows, actions, accessibility labels, and destructive confirmations.
- Native workspace groups render a bounded preview with explicit **Show more**, Android chat rows retain stable identity, and equal-timestamp ordering matches desktop/iOS.
- iOS sidebar preferences live in the purgeable product-navigation store, archived IDs are pruned, and one selected-chat identity survives compact/regular transitions.
- Android pruning waits for a completed workspace refresh and disclosure controls expose expanded/collapsed semantics to TalkBack.
- The projection tests are registered in the normal `npm test` preflight, not only in a feature-local script.

## Phase 2: bounded remote summaries

- `GET /api/aiden/v1/chat-summaries` now provides an authenticated `chat:read` metadata projection with a default page size of 100 and a maximum of 200. It is sourced exclusively from the bounded chat index and opens zero transcript files.
- The projection contains only chat ID, workspace ID, title/title-pending state, timestamps, summary revision, and `idle`/`active` status. Reserved Assistant records, Bot homes, and malformed index records fail closed or are omitted before projection.
- Results use stable newest-first ordering. Integrity-protected opaque cursors retain a bounded five-minute server snapshot; deleted chats are skipped, while updates and newly created chats do not duplicate or reorder an in-progress walk. Invalid, forged, expired, evicted, and post-restart cursors fail explicitly.
- `/server.features` advertises `chat-summaries-v1`. iOS and Android prefer paginated summaries only when advertised, preserve their installation-scoped cache/readiness fences, and fall back to the existing `/chats` read for older Mac builds. Opening a chat still performs the authoritative full `GET /chats/{id}` detail read.
- The TypeScript, Swift, and Kotlin decoders share contract-revision 10 fixtures, tolerate harmless additive response fields, reject forbidden private fields, and cover missing-required-field failures. Synthetic benchmark fixtures cover representative and pathological list sizes; physical iPhone/iPad and Android profiling remains an operator acceptance gate.

## Acceptance gates

- A chat appears exactly once in either organization and never leaks from a removed/reserved workspace.
- Disclosure has no create/navigation side effect; explicit create targets the selected workspace.
- Cross-workspace chat selection reconciles the active execution context.
- Search, empty workspaces, long groups, workspace removal, managed-worktree deletion, archive state, and installation switching remain deterministic.
- Keyboard focus remains visible on non-text controls; text fields keep Aiden's background/caret focus treatment without accent borders.
- Focused desktop projection/sidebar tests, TypeScript, onboarding, iOS source/test compilation, and Android unit/lint/assemble gates pass.
