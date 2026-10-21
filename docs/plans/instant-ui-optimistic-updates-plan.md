# Instant UI and optimistic updates

Status: In progress (2026-10-21). Companion to [Cache-first loading states](cache-first-loading-states-plan.md), which owns the read side (saved data first, shaped skeletons, settled empty states). This plan owns the write side and the navigation side: every user action shows its result on the next frame, and the server action starts whenever it starts.

## Product rule

1. **A tap changes the screen before the round trip.** Rename, toggle, delete, send, resume, dismiss, routine edits and profile edits apply to the local cache first. The host's answer settles the row; a failure rolls the row back and shows one toast or inline error.
2. **Navigation never waits for the network.** Opening a Bot, a chat, a deep link or a freshly created Bot or chat navigates at once from the cache or from the create receipt. Extra reads (reload the list, refresh summaries, the Bot's self-intro) run after navigation.
3. **Sends are idempotent and visible at once.** A send mints one request key per submission, shows a pending echo immediately, keeps the key across a retry after an uncertain failure, and never double-sends. Queued sends while connecting are delivered once the connection is up.
4. **Feature gates read saved capabilities.** Phones persist the last `/server` features per installation and use them until `/server` answers, so a durable-session Mac never lands on the legacy Bot path while connecting.
5. **Destructive actions keep a pending label** (Delete Bot, Remove workspace) rather than vanishing before the host confirms, unless the row can be restored on failure, in which case it is removed at once and restored on error.

## Audit summary (main @ 45c22132)

Each item names the file as of the audit; the implementation sections below record what changed.

### Desktop Bots (`renderer/main/bots/`)

| # | Action | Before | Change |
| --- | --- | --- | --- |
| D1 | Send to a Bot (`bot-chat-pane.tsx`) | Composer clears, no bubble until main's live event; a new UUID per call so a retry after an uncertain failure is a new send | Stable request key per submission, pending user echo in the live view keyed by request id, reconciled when the projected entry arrives; key kept on failure |
| D2 | Open or switch Bots (`use-bot-live.ts`) | Live store resets to empty and shows the chat skeleton on every revisit | Bounded LRU of the last live snapshot per Bot; render it at once as stale, swap in the fresh one |
| D3 | Connection setup saved | `live.reload()` replaces the transcript with a skeleton | Reload keeps the current view |
| D4 | Create Bot / Start from preset | Dialog busy through create, awaited list refetch, awaited catalog invalidation and the awaited self-intro send | `setQueryData` the created Bot into the list, close and navigate at once; intro and invalidations fire-and-forget |
| D5 | Delete Bot | Dialog busy through delete and an awaited refetch | Remove from the list cache, close and navigate at once; restore and toast on error |
| D6 | Rename, subtitle, avatar character, instructions (`bot-identity.ts`) | get → update → awaited list refetch; inputs disabled | Optimistic `setQueryData` into `bot(id)` and the list before the IPC, rollback on error, list invalidation not awaited, cached revision used when present |
| D7 | Resume / Dismiss a paused session | Card disabled until main finishes | Card hides at once (Resume shows the working status); restored on error |
| D8 | Try again on a failed turn | New UUID per click, no echo | Key derived from the failed row; pending echo; failed card hidden optimistically |
| D9 | Routine add / edit / delete | Dialog busy, then a second `routines:list` read before the list updates | `setQueryData` from the returned routine (or filter out on delete) before closing |
| D10 | `useBot` not seeded from the list | Full page skeleton even though the list holds the Bot | `initialData` from the bots list |
| D11 | `/bots` index waits for a refetch | "Opening your Bot" until a stale refetch finishes | Redirect from cached data when the last viewed Bot is cached |
| D12 | Advanced Save | Form disabled through access read, update, awaited access and catalog invalidation | `setQueryData(botAccess)` from the returned view; catalog invalidation not awaited |

### iOS (`ios/AidenOnTheGo/`)

| # | Action | Before | Change |
| --- | --- | --- | --- |
| I-1 | Workspace New chat | Awaits `createChat` then a full Home reload before opening | Open right after `createChat`, accept the chat into Home, reload in the background |
| I-2 | Send while connecting | Send disabled until connected | Save the `PendingSend` and local echo while connecting; flush on connect |
| I-3 | Steer / Queue | Draft stays until the server answers; message appears after a second GET | Local queued bubble at once with the idempotency key; roll back on failure |
| I-4 | Rename a chat | Title changes after the PATCH | Optimistic title in list, Recents and open chat; roll back on failure |
| I-5 | Delete a chat | Recents keeps the row until DELETE finishes | Row removed from Recents at once; restored on failure |
| I-6 | Bot route while connecting | `server?.features` is nil so durable Macs fall to the legacy path | Persist `/server` features per installation and resolve from them |
| I-7 | After creating a Bot / starting a preset | Awaits a full `load()` before opening | Navigate from the create receipt, refresh in the background |
| I-8 | Opening a Recents row on a cold cache | Awaits `GET /chats/:id` with no feedback | Navigate at once with a stub chat and a transcript skeleton (remaining half of I2) |
| I-9 | Bot routine toggle | Snaps back until PATCH returns | Flip locally, block re-taps, roll back on failure |
| I-10 | Scheduled Pause / Resume | Label changes after the network | Flip `enabled` locally, scope the lock to the task, roll back on failure |
| I-11 | Bots home while connecting | `isLoading = connectionState == .connected` shows "No saved Bots" | Connecting is unsettled |

### Android (`android/app/src/main/java/sbtbiswas/AidenOnTheGo/`)

| # | Action | Before | Change |
| --- | --- | --- | --- |
| A-1 | Chat after a client refresh | VM captures `boundClient` once; chat stops loading and sending after Retry | Bind to the coordinator's current client, reread on CONNECTED and ON_START |
| A-2 | Send while connecting | `canSend` requires connected | Accept the send, persist the `PendingSend` with its key, show the echo, flush on CONNECTED |
| A-3 | Steer / Queue | Draft consumed only after the server answers | Clear the draft at once, show the pending input, restore on failure |
| A-4 | Bot chat open while connecting | `serverInfo` null so durable Macs see a spinner or the legacy create | `effectiveFeatures` from the persisted installation features |
| A-5 | Bot routine toggle | Switch disabled and flips on the answer | Flip at once, roll back on error |
| A-6 | Deep link to a chat | Waits for CONNECTED and `client.chat(id)` | Navigate at once; the VM hydrates from the cache |
| A-7 | New chat FAB / section "+" | Hidden until LOADED and connected | Available once workspaces are known |
| A-8 | Connection banner | Shown for CONNECTING too | Banner only for OFFLINE; connecting is the top-bar dot |
| A-9 | Bots home offline with no cache | Skeleton forever | Offline-empty state |

## Out of scope for this pass

Desktop read snapshots that survive a relaunch (cache-first plan D1, D3), the model catalog disk caches on both phones, Files/Git caches (I7, A5), and the paired-Mac remote Bot open on old hosts. These stay on the cache-first plan.

## Tests

Behavioral only, extending the existing suites: desktop `bot-panel.test.tsx`, `bot-sidebar.test.tsx`, `bot-profile.test.tsx`, `bot-routines.test.tsx`, `use-bot-live` tests; iOS `AidenChatTests`, `AidenBotSessionTests`, `AidenBotHomeProfileTests`, `AidenScheduledTaskTests`, `AidenRemoteClientTests`; Android `AidenChatTest`, `AidenRemoteCoordinatorClientTest`, `AidenInstallationStoreTest`, `AidenBotHomeBehaviorTest`.
