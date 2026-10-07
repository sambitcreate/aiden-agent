# Android optimistic loading (no spinners)

Product rule: the Android client is client/server and must feel optimistic. Reads never show an indeterminate spinner. Saved or last-known data renders at once and revalidates underneath; shaped `AidenSkeleton*` placeholders appear only on a first read with nothing saved.

## Shared pieces
- `features/shared/AidenReadPresentation.kt`: `AidenReadPresentation.of(hasContent, isFetching, hasSettled, failed)` decides CONTENT / SKELETON / EMPTY / FAILED. Content always wins, so a refresh or a failed refresh never replaces saved rows. `AidenRevalidation.isDue` gates foreground rereads (60 s, never over an in-flight read).
- `persistence/AidenReadSnapshotCache.kt`: per-installation, size-bounded (2 MiB per entry, 64 entries, oldest-written evicted) JSON snapshots for screens without a dedicated cache. Keys in `AidenReadSnapshotKeys`: Workspace list, per-Workspace chat listing, Git review, branches, worktrees. Purged by `AidenRemoteCoordinator.removeInstallation`. An oversized write deletes the older snapshot so a stale one is never shown after a newer read could not be kept.
- `ui/theme/AidenActivityIndicator.kt`: `AidenActivityDot`, a breathing dot (still under Reduce Motion) for active work (Working chat rows, pending fork summary, in-flight action segments). Not for reads.

## Surfaces
- Coordinator seeds `workspaces` from the snapshot on activation and stores each successful `/workspaces` read; create/update/remove reconcile the server's answer into the list before the background refresh.
- Workspace home: skeleton only while connecting/first read with nothing saved; inline error above saved rows on refresh failure; "Load more" previews skeleton rows; ON_START revalidation.
- Workspace directory: saved chat listing per Workspace; optimistic rename with rollback + snackbar; remove/delete worktree are destructive, so rows show "Removing…" until the desktop answers.
- Chat: transcript skeleton only when `chat == null && isLoading` (VM publishes `isLoading` before launch). Images: skeleton in the image box; decoded bitmaps are aliased by attachment identity so revisits render on the first frame.
- Bots: profile from `AidenBotCache` (detail written back on refresh), optimistic Favorites with one write at a time; editor/Custom Access wait for the live capability catalog (drafts are built against it) behind a form skeleton.
- Scheduled: optimistic pause/resume with rollback; Run now/Delete hold pending labels.
- Git: saved review renders but its snapshot id may be stale, so commit/diff/checkout/push wait for the fresh read; Git writes hold pending labels and mark the review stale until reread.
- Files: saved tree renders read-only while revalidating, without the offline banner.

## Remaining indicators (other owners)
`features/settings/AidenAppearanceSettingsScreen.kt` (one indeterminate, one determinate download bar) and `features/remote/AidenPairingScreen.kt` (two) belong to the settings/pairing work.

## Tests
JVM: `AidenReadSnapshotCacheTest`, `AidenReadPresentationTest`, `AidenRemoteCoordinatorClientTest` (cold activation shows saved Workspaces), `AidenInstallationRemovalTest` (snapshot purge), `AidenChatRowStatusTest`. Compose (compiled, device run pending): `AidenWorkspaceShellUiTest`, `AidenGitWarmCacheUiTest`, `AidenBotProfileWarmCacheUiTest`, `AidenScheduledTasksUiTest`, `AidenImageCarouselUiTest`, `AidenChatChromeUiTest`.
