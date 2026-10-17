# iOS cache-first Home (cache-first loading plan, I1/I2)

Plan: `docs/plans/cache-first-loading-states-plan.md`, PR #516.

- `AidenChatCache` now also stores the last `GET /workspaces` list per installation (`saveWorkspaces`/`loadWorkspaces`, kind `workspaces`). Writes take a `reserveChatWrite()` token; reservations older than the last write or made before/during a purge are rejected (`ChatWriteClock.retainsInstance`). Purged with the rest of the chat cache on unpair/revocation.
- `AidenRemoteCoordinator.connectActiveInstallation` seeds `workspaces` from that snapshot (`seedSavedWorkspaces`) before the network; every applied snapshot, upsert and optimistic removal re-saves it (`persistWorkspaces`). A live answer always wins.
- `AidenHomeModel.load` hydrates saved summaries before checking the connection; only connected loads reserve summary tokens or hit the network.
- `AidenReadPresentation` + `aidenHomeChatListPresentation` / `aidenHomeWorkspaceListPresentation` decide content/skeleton/empty/failed. Content always wins; a failed refresh over rows shows `chatRefreshErrorRow`.
- Connecting shows `AidenConnectingHint` after 600 ms (no overlay). Usage opens `AidenUsagePendingView` until data arrives. New chat waits up to 30 s via `awaitChatCreationReady`.
- Opening a Recents row uses `cachedWorkspaceChat` first; top five transcripts are prefetched after a refresh unless `AidenNetworkAvailability.isConstrained` (Low Data Mode).
- Prefetch saves with `saveFetchedChat(..., updatesSummary: false)` so the Mac's unread/attention row state survives. A chat opened from cache reloads when `connectionState` becomes `.connected` (`chatLoadEpoch` bump). A failed Usage read with nothing saved sets `usageLoadFailed`, shown with Try Again.
- Tests: `AidenCacheFirstHomeTests` in `AidenChatTests.swift`.
- Not yet: Usage disk cache, cold-cache transcript skeleton, Workspaces directory/chat list (I3) and later phases.
