# Cache-first loading states for every client

Status: Approved (2026-10-17); in progress. Decisions are recorded at the end.

Progress:
- 2026-10-17: I1 (iOS Home and Recents) and the cache-hit half of I2 implemented on the plan PR: saved workspace list in `AidenChatCache` (seeded on connect, purged on unpair), Home hydrates saved Recents before the connection guard, `AidenReadPresentation` with `AidenChatListSkeleton`, quiet connecting hint, Usage skeleton sheet, Scheduled Tasks enabled from cache, New chat waits for the connection, cache-first open of Recents rows, and top-five transcript prefetch (off in Low Data Mode). Needs a simulator build and test run on the Mac. Remaining iOS work: cold-cache transcript skeleton in the chat view, usage disk cache, I3 onward.

## Problem

Aiden's clients still show loading states that carry no information. The clearest case is the iOS home screen on a cold launch: the Recents list says "No Chats Yet / Start a new Workspace chat to begin." behind a "Connecting to Aiden Agent…" spinner, and Scheduled Tasks and Usage are greyed out. The phone already has the user's chats on disk; it just doesn't show them.

The audit below covers every read on iOS, Android and the desktop renderer, as of `main` at `1575fda4`. Android already did most of this work in the Material 3 overhaul (PR #374, `.memory/android-optimistic-loading.md`), so it is the reference pattern. iOS has the pattern only for Bots. The desktop has caching in memory but nothing that survives a relaunch, and many screens use text-only "Loading…" placeholders.

## Product rule

This extends Android's rule to every client:

1. **Saved data renders first.** Any screen with data on disk renders it on the first frame and revalidates underneath. A refresh, or a failed refresh, never replaces saved rows.
2. **Skeletons only for a true first read.** A shaped skeleton (the outline of the real rows) appears only when nothing is saved and a read is in flight or about to start, including while connecting.
3. **Empty means confirmed empty.** "No chats yet" and similar empty states appear only after the host has answered with an empty list. Connecting, offline and "not loaded" are never shown as empty.
4. **Connection state is quiet.** Connecting is a small status (top-bar dot or a one-line hint), never a modal overlay over content. Offline shows saved data plus one inline banner with Retry.
5. **No indeterminate spinner for reads.** Spinners stay only for user-started writes (Send, Save, Pairing, Run now), and even then prefer pending labels on the control. Determinate progress bars (downloads) are fine.
6. **Writes are optimistic where they can be undone** (rename, favourite, pause/resume) with rollback and a snackbar/toast on failure; destructive writes keep a pending label until the host answers.
7. **Nothing blocks on the network that the cache could answer.** Navigation (opening a chat, a deep link, a sheet) happens at once from the cache; the fresh read fills in.

Reduce Motion: skeletons hold still (no shimmer), matching Android's `AidenBotSessionSkeleton` and iOS's `AidenBotSkeletonBlock`.

## Shared foundations (one per platform, built first)

| Piece | Android (exists) | iOS (new) | Desktop (new) |
| --- | --- | --- | --- |
| Read presentation decision | `AidenReadPresentation.of(hasContent, isFetching, hasSettled, failed)` | `AidenReadPresentation` enum + `of(...)` in `Features/Shared`, generalising `aidenBotsHomeContentState` / `aidenBotUsesColdLoadingPlaceholder` | `useReadPresentation(query)` in `renderer/lib/` over React Query state (`data`, `isPending`, `isFetching`, `isError`) |
| Revalidation gate | `AidenRevalidation.isDue` (60 s) | Same 60 s gate, applied on scene activation and connect | React Query `staleTime` already does this |
| Small snapshot cache | `AidenReadSnapshotCache` (per installation, 2 MiB/entry, 64 entries, purged on unpair) | `AidenReadSnapshotCache` in `Persistence/`, same limits and purge from `purgeInstallationDataUnlocked` | Main-process `ReadSnapshotStore` under userData, exposed over IPC, used to seed React Query at startup (see Desktop) |
| Skeleton primitives | `AidenSkeletonBlock`, `AidenSkeletonListRow`, `AidenSkeletonList` | Promote `AidenBotSkeletonBlock` to `AidenSkeletonBlock` / `AidenSkeletonListRow` / `AidenSkeletonList` in `Features/Shared` | `renderer/components/ui/skeleton.tsx` (`Skeleton`, `SkeletonRows`), replacing the hand-written `bg-control animate-pulse` spans |
| Quiet connection hint | `AidenBotConnectionHintRow`, top-bar status dot | Toolbar status dot + one-line hint; no overlay | Sidebar host row status (exists) |
| Capability fallback | `installation.serverFeatures` used only for bot activity | Persist last `/server` capabilities per installation | n/a |

Both phones should also persist the last `/server` answer (capability flags) per installation. Gates like `serverInfo?.supportsBotDurableSession` are false while connecting, which sends durable-session Macs down legacy paths and makes rows pop in late. Reading the saved flags until `/server` answers, as `aidenBotActivitySupported` already does on Android, fixes that everywhere.

Both phones should cache the model catalog per installation (bounded, purged on unpair). Today it is memory-only on both, so the composer model chip, Usage artwork, Bot create model rows and Providers all wait for the network.

No Remote protocol change is needed. Everything here reuses existing endpoints and ETag/304 handling.

## iOS (Aiden On The Go)

Paths are under `ios/AidenOnTheGo/`.

### I1. Home and Recents (the screenshot)

Root cause, confirmed in source:

- `AidenHomeModel.load` (`Features/Remote/AidenWorkspaceShellView.swift:324`) returns unless `connectionState == .connected`, and the cached summaries are read after that guard (`:343`). The on-disk Recents cache is never read while connecting or offline.
- `AidenWorkspaceSidebarProjection.make` (`:584`) drops every chat whose `workspaceId` is not in `coordinator.workspaces`. That list is memory-only and empty until `GET /workspaces` returns, so even cached summaries would project to nothing.
- The empty state (`:1290`) checks `!homeModel.isLoading`, which is false while connecting, so "No Chats Yet" shows.
- `ProgressView("Connecting to Aiden Agent…")` is a material overlay (`:915`), and a bare `ProgressView()` overlay follows once connected (`:1327`).
- Scheduled Tasks is disabled when not connected (`:1480`) though it has a disk cache; Usage is disabled until `usage != nil` (`:1486`) and is never cached; the New chat FAB (`:1611`) and per-workspace New chat (`:1265`) wait for connected + `chatListLoadState == .loaded`.

Changes:

- Persist the workspaces list in the new snapshot cache and seed `coordinator.workspaces` on activation, as Android's coordinator does; reconcile create/update/remove answers into it.
- Split `AidenHomeModel.load` into `hydrate()` (cache, no connection needed, runs on activation) and `refresh()` (network, connected only).
- Drive the Recents and Workspaces sections through `AidenReadPresentation`: saved rows, else a Recents-shaped skeleton (icon + title bar + age bar, 6 rows) while connecting or loading, else the empty state only after a settled empty answer, else an offline/failed state.
- Remove the connecting overlay and the bare `ProgressView()` overlay. Show connection as the toolbar status dot plus, when offline, the existing `AidenOfflineBanner` above saved rows.
- Scheduled Tasks opens from cache when not connected (read-only, offline banner inside). Usage gets a disk cache (`AidenUsageCache`, last range per installation) and a dashboard skeleton when nothing is saved, so the row is never disabled.
- New chat is available as soon as a workspace is known (from the snapshot). Sending while connecting queues through the existing pending-send/draft store.
- Search filters saved rows while connecting and shows "No Matching Chats" only over a settled list.
- "Loading more chats…" becomes two skeleton rows at the end of the list.

### I2. Opening a chat

- `openChat(_ summary:)` (`AidenWorkspaceShellView.swift:1835`) waits on `GET /chats/:id` before navigating, with no feedback. Navigate at once, as Bot chats already do (`AidenProductShellView.swift:936`): show the cached transcript, or a transcript skeleton, then fill in.
- `AidenChatDetailView` has no first-load state at all on a cold cache. Add `AidenTranscriptSkeleton` (alternating bubble shapes) for `messages.isEmpty && isLoading`, and an inline error with Retry instead of a blank screen.
- Cache the model catalog so the composer chip shows the last-known model at once.
- Prefetch the transcript for the top Recents rows after the summaries refresh (bounded, Wi-Fi or not low-data), so the common open is instant.

### I3. Workspaces directory, archived and workspace chat list

- Directory (`:2111`) and Archived (`:2378`) show "No Workspaces" while connecting. Use the snapshot plus presentation; skeleton rows on a cold first read.
- Workspace detail (`:1791`) shows "Choose a Workspace" when a restored path lands before workspaces load. With the snapshot this resolves at once; otherwise show the detail skeleton, not the placeholder.
- `AidenWorkspaceChatsModel.load` (`Features/Remote/AidenChatFeature.swift:879`) is cache-first but sets `isLoading` after the cache await, so "No Chats" can flash (`:4970`). Set the loading state before the await and replace the bare `ProgressView()` overlay (`:5017`) with skeleton rows.

### I4. Bots

Bots are the model, with these gaps:

- Bots home sets `isLoading = connectionState == .connected` (`Features/Bots/AidenBotsHomeView.swift:899`), so connecting with no cache shows "No saved Bots". Treat connecting as unsettled (skeleton).
- Routines (`AidenBotRoutinesView.swift:133`) has no cache and shows an empty list with a disabled Add. Cache routines in `AidenBotCache`, add a skeleton.
- Memory (`AidenBotMemoryView.swift:329`) has no cache. Cache the last `MEMORY.md`/`USER.md` view per Bot in `AidenBotCache`.
- Bot session transcript is memory-only (16 entries, `AidenBotSessionModel.swift:374`). Persist the last window per Bot in `AidenBotCache` so a cold open shows the conversation, not skeleton bubbles.

### I5. Scheduled tasks

- `load()` is cache-first but returns early when not connected (`Features/Remote/AidenScheduledTasksView.swift:216`); keep hydration outside that guard. Replace `ProgressView("Loading tasks…")` (`:766`) with skeleton rows on a cold read only.
- Run History shows "No completed runs yet." while loading (`:871`) and is network-first (`:456`). Make it cache-first with a skeleton, and gate the empty text on a settled answer.

### I6. Settings, Providers and folder browser

- App Settings: the Memory toggle shows a default "on" while disabled (`AidenWorkspaceShellView.swift:3288`); Read Aloud shows "Set up on your Mac" while status is nil (`:3303`). Cache these settings per installation (like Android's `AidenSettingsCache`) and use a skeleton switch row until the first answer.
- Desktop Transcription "Loading desktop speech models…" (`:3431`) and Providers "Loading providers" (`AidenProvidersView.swift:26`): cache the last answer; skeleton rows on a cold read.
- Folder browser "Loading approved folders…" / "Loading folders…" (`:3755`, `:3840`): cache approved roots; skeleton rows for a folder page.

### I7. Files and Git

- Files (`Features/Remote/AidenWorkspaceEnvironmentView.swift:439`) is network-first and uses its disk cache only when offline. Make it cache-first: render the saved tree and documents, revalidate underneath, skeleton only on a cold read.
- Git (`:969`) runs review → branches → worktrees in series with no cache. Cache each in the snapshot cache (as Android does), run the three reads in parallel, and keep Git writes waiting on a fresh review (saved snapshot ids may be stale).

### I8. Attachments, pickers, pairing

- Thumbnail and viewer spinners (`AidenChatFeature.swift:6862`, `:7100`) read the disk cache first already; replace the spinner with a skeleton in the image box, sized from the attachment's known dimensions.
- The photo picker skeleton, pairing, camera, simulator and Live Activity states are writes or live streams and stay as they are.

## Android

Paths are under `android/app/src/main/java/sbtbiswas/AidenOnTheGo/`. Most surfaces already follow the rule; these are the remaining gaps.

### A1. Connection presentation

- Home shows a full banner card ("Connecting to Aiden Agent…", Retry) whenever not connected, including every cold-launch connect (`features/workspaces/AidenWorkspaceHomeScreen.kt:391`). Bots home and Scheduled show their offline banners during connecting too (`AidenBotsHomeScreen.kt:409`, `AidenScheduledTasksScreen.kt:490`). Show the banner only for OFFLINE; connecting is the top-bar dot.
- `ContentView.kt:73` pins an offline block that pushes content down and has hardcoded strings. Fold it into the inline banner and move the strings to resources.
- Nothing reconnects automatically after OFFLINE. Add a backoff reconnect (on network-available and ON_START) so saved data revalidates without a tap.

### A2. Home and directory

- The FAB is hidden until `chatListLoadState == LOADED` (`AidenWorkspaceHomeScreen.kt:365`) and section "+" is blocked (`:574`). Allow New chat once workspaces are known, queueing the send.
- Usage is disabled with nothing cached and only shows a snackbar (`:435`). Open the sheet with a dashboard skeleton.
- Offline with no cache shows "No Workspaces Yet" (`:894` treats OFFLINE as settled). Show an offline state instead.
- Workspace directory shows "No active workspaces" with no presentation gating (`AidenWorkspaceShellScreen.kt:518`), and the chat listing passes `hasSettled = true` (`:1306`), flashing "No chats in this workspace yet". Gate both through `AidenReadPresentation`, and seed the listing from `chatCache` summaries for that workspace.
- Folder browser (`:891`): cache roots, skeleton rows, and show errors instead of a blank list.

### A3. Chat

- The chat VM captures `boundClient` once (`features/chat/AidenChatViewModel.kt:276`) and the VM key ignores the client (`AidenChatDetailScreen.kt:147`), so after Retry or any client refresh an open chat silently stops loading and sending. Rebind on client change and reread on the CONNECTING → CONNECTED transition and ON_START.
- Cache the model catalog so the composer model chip (`AidenComposerView.kt:355`) doesn't pop in; share it with the home VM.
- Deep links wait for CONNECTED and `client.chat(id)` before navigating (`MainActivity.kt:115`). Navigate from the cache at once.
- "Loading earlier messages" text pill becomes skeleton bubbles at the top.

### A4. Bots

- `AidenBotChatRoute.kt:99` still shows a centred `CircularProgressIndicator`, and because `:51` gates on `serverInfo?.supportsBotDurableSession` (null while connecting) durable-session Macs land there on every cold open and may call the legacy `createBotChat`. Use the persisted capability flags and open the durable session view from cache.
- Bots home shows `AidenBotHomeSkeleton` forever when offline with no cache (`AidenBotsHomeScreen.kt:78`). Return the offline-empty state the `bots_empty_offline_*` strings were written for.
- Durable session transcript is memory-only (`AidenBotOutbox.kt:195`). Persist the last window per Bot in `AidenBotCache`; show the "Connecting…" hint only when nothing is cached or the stream is down after load.
- Routines, Memory, Bot files and the capability catalog have no cache. Add them to `AidenBotCache` (catalog per installation) so Advanced and the editor stop showing a form skeleton on every open.
- Profile rows (Delete, Memory, Routines) pop in when `serverInfo` arrives; fixed by the persisted capability flags.

### A5. Scheduled, Files, Git

- Scheduled: connecting with no cache shows "No scheduled tasks" (`AidenScheduledTasksScreen.kt:265`); runs show "No runs yet." when `client == null` (`:790`). Gate on settled answers.
- Files: opening a file is network-first with no placeholder (`AidenWorkspaceEnvironmentScreen.kt:291`). Show the cached document first with a document skeleton for a cold open; show child skeletons when expanding a folder; move `cache.load` off the main thread (`:124`, `:166`).
- Git: file rows are unclickable until the fresh read (`AidenGitScreen.kt:398`) and diffs have no placeholder (`:399`). Allow opening a saved diff read-only, cache recent diffs by blob ids, and show a diff skeleton.
- Simulator viewer's "Connecting to device…" spinner (`AidenSimulatorViewerScreen.kt:430`) is a live stream connect and stays.

## Desktop renderer

Paths are under `renderer/`. Reads are local IPC, so most are fast, but several screens still blank or show text-only placeholders, and nothing survives a relaunch.

### D1. Startup and first paint

- `main-window.html` is an empty root and `startApp` (`main/app.tsx:43`) waits for the app chunk, `app:getInfo` and `providers:list` before the first render, so the window is blank (with the right background colour) for that time.
- `workspace-context.tsx:23` keeps `activeId` undefined until `workspaces.list` resolves, so the chats read waits on it (two reads in series), and `ChatIndex` renders a blank div meanwhile (`main/chat-layout.tsx:186`).

Changes:

- Add a main-process `ReadSnapshotStore` (userData, bounded, written after successful reads) holding the workspaces list, the active workspace's chat list, and the bots list. Return it with `app:getInfo` (or one `app:bootstrap` read) and seed React Query with `setQueryData` before the first render, then revalidate, as providers already are.
- Render the shell (sidebar frame and composer skeleton) immediately and fill in, instead of waiting in `startApp`.
- Start the chats read from the localStorage workspace id in parallel with `workspaces.list`.
- Add a `defaultPendingComponent` to the router (`main/router.tsx`) that renders a page-shaped skeleton for lazy routes (Settings, Profile, Scheduled, Bots, Design, Images) instead of a blank pane.

### D2. Sidebar and transcript

- Sidebar "Loading chats… / Reading workspace history." (`components/chat-sidebar.tsx:1526`, `:1795`) becomes skeleton rows; it is rarely seen once seeded.
- "Loading conversation…" (`main/chat-pane.tsx:3435`) becomes a transcript skeleton. Raise `gcTime` for chat transcripts (for example 30 minutes, bounded by count) so revisits after five minutes don't reload, and keep the existing hover prefetch.
- Long threads load in one `chatsApi.get` call and render without windowing; that is covered by the [long-thread payload plan](long-thread-payload-upgrade-plan.md) and only the placeholder changes here.

### D3. Paired hosts

- Remote rows don't appear until a feed arrives and an empty feed looks unloaded (`lib/hosts/use-peer-host-sidebar.ts:70`). Persist the last `PeerHostFeedCache` snapshot per host (`main/services/peer-host-feed-cache.ts`) so the sidebar shows remote chats at once after a relaunch, marked as syncing until the first epoch, and show skeleton rows under a host while its first sync runs.
- `remote-chat-view.tsx` flashes "Loading…" for one render even with a cached window (`:332`, `:756`) because `binding` starts null; seed it synchronously. Replace the text with a transcript skeleton, and "Loading folders…" / "Loading models…" in remote new chat with skeleton rows.

### D4. Settings and pages

- Skills shows "No skills yet" while loading (`settings/skills-settings.tsx:133`) and MCP renders nothing (`settings/mcp-settings.tsx:379`). Gate on settled reads, skeleton rows meanwhile.
- Image Generation, TTS and About load with manual `useState` on every visit (`image-generation-settings.tsx:86`, `tts-settings.tsx:52`, `about-settings.tsx:70`). Move them to React Query so revisits are instant, and use the shared `SettingsSkeleton`.
- Memory, Paired computers, Remote access and Shortcuts text placeholders become skeleton rows.
- Profile shows "Loading profile…" as the name (`main/profile-view.tsx:87`) and the Usage skeleton flashes on every range change (`queries.ts:733`). Seed the profile from the snapshot, and use `placeholderData: keepPreviousData` for usage ranges.
- Images home is blank until workflows load (`images/images-home.tsx:32`); move to React Query with a grid skeleton.
- Browser and Devices panels use `Suspense fallback={null}` (`components/environment-panel.tsx:1459`, `:1471`, `:2083`); use a panel skeleton.

### D5. Pickers, palettes, Quick View, Git

- Command palette shows models as an empty list while loading (`components/command-palette.tsx:297`); show skeleton rows instead of "Loading…" rows with spinners, and the same for the slash palette and model picker details.
- Quick View's Changes card pops in once `gitReview` resolves (`components/environment-overview.tsx:227`). Persist the last review summary per workspace so the card shows at once, marked stale until reread.
- Pull requests, branch picker and draft branches: skeleton rows instead of spinner text.
- Files editor shows `EditorSkeleton` on every document load with a per-mount cache only (`components/files-panel.tsx:217`, `:751`). Move documents to React Query keyed by path and mtime.

## Phasing

Each phase is one PR per platform unless noted, so they can land in parallel.

1. **Foundations.** iOS `AidenReadPresentation`, snapshot cache and shared skeletons; desktop `Skeleton` primitives and `useReadPresentation`; persisted capability flags and model catalog cache on both phones.
2. **iOS home and chat open (I1, I2).** Fixes the screenshot. Highest user value.
3. **Android connection and chat fixes (A1–A3).** Includes the stale-client bug, which is a correctness fix as well as a loading one.
4. **Bots on both phones (I4, A4).** Persisted Bot transcripts, routines, memory and capability catalog.
5. **Remaining phone screens (I3, I5–I8, A5).**
6. **Desktop startup and transcript (D1, D2), then hosts (D3), then settings and panels (D4, D5).**

## Tests

Per `AGENTS.md`, behavioral tests only, extending existing suites:

- **iOS:** presentation decisions as pure functions (cache present while connecting → content; nothing saved while connecting → skeleton; settled empty → empty; failed with rows → content plus error). Home model test that a cold launch with a saved cache and a connecting coordinator projects saved Recents. Snapshot cache size bounds and purge on unpair, alongside the existing `AidenChatCache` tests in `AidenOnTheGoTests`.
- **Android:** extend `AidenReadPresentationTest`, `AidenRemoteCoordinatorClientTest` (persisted capability flags before `/server`), a chat VM test that a client refresh rebinds and rereads, and Compose UI tests for the offline-empty Bots state and FAB availability with saved rows.
- **Desktop:** unit tests for `ReadSnapshotStore` bounds and seeding; Playwright for first paint (sidebar rows visible before the workspaces read resolves, using a delayed IPC fixture), the lazy-route pending skeleton, and Skills/MCP not showing an empty state while loading.
- Native Remote contract tests are unchanged because no protocol revision is involved.

## Docs to update when this lands

- `docs/design-guide.md`: add a "Loading states" section with the product rule above and the skeleton primitives.
- `ios/CONTEXT.md` / `ios/DEVELOPMENT.md` and the Android notes: the new caches and their purge points.
- `.memory/android-optimistic-loading.md`: correct the stale "remaining indicators" note (Pairing and Appearance no longer have read spinners) and add the new caches.
- `docs/plans/README.md`: status row for this plan.

## Decisions (2026-10-17)

The user approved these defaults:

1. **Desktop persists a small read snapshot.** The workspaces list, the active workspace's chat list, the bots list and the last peer-host feeds are saved in main (not localStorage) and seed the renderer before the first read (D1, D3).
2. **Phones prefetch recent transcripts.** After Recents refresh, the top five chats are prefetched into the transcript cache, skipped in Low Data Mode / on metered data saver (I2).
3. **Sends queue while connecting.** Sending from a cold launch, before the connection is up, goes through the existing pending-send stores and is delivered once connected; the message shows its queued state (I1, A2).
