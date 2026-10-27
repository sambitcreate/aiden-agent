# Instant UI and optimistic updates

Status: Implemented (2026-10-21); the deferred items are listed below. Companion to [Cache-first loading states](cache-first-loading-states-plan.md), which owns the read side (saved data first, shaped skeletons, settled empty states). This plan owns the write side and the navigation side: every user action shows its result on the next frame, and the server action starts whenever it starts.

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
| D5 | Delete Bot | Dialog busy through delete and an awaited refetch | Destructive, so the dialog stays busy until main confirms; then the Bot leaves the list cache and the view navigates at once, with the list reread and the remembered live view dropped in the background |
| D6 | Rename, subtitle, avatar character, instructions (`bot-identity.ts`) | get → update → awaited list refetch; inputs disabled | The cache shows the last confirmed Bot with every unanswered patch layered on top, written before the IPC; the write still rereads the Bot so it patches the latest revision; a failed patch drops out of the stack so overlapping edits settle in any order, building on any newer Bot a reread brought meanwhile; a cleared subtitle leaves the cache as it leaves main; list invalidation not awaited |
| D7 | Resume / Dismiss an interrupted turn (called a paused session before PR #559 added a person-paused Bot) | Card disabled until main finishes | Card hides at once (Resume shows the working status); restored on error |
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
| I-3 | Steer / Queue | Draft stays until the server answers; message appears after a second GET | Clear the draft on screen at once, keep the saved draft until the Mac admits it, restore on failure (queued bubble deferred) |
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
| A-3 | Steer / Queue | Draft consumed only after the server answers | Clear the draft on screen at once, keep the saved draft until the Mac admits it, restore on failure |
| A-4 | Bot chat open while connecting | `serverInfo` null so durable Macs see a spinner or the legacy create | `effectiveFeatures` from the persisted installation features |
| A-5 | Bot routine toggle | Switch disabled and flips on the answer | Flip at once, roll back on error |
| A-6 | Deep link to a chat | Waits for CONNECTED and `client.chat(id)` | Navigate at once; the VM hydrates from the cache |
| A-7 | New chat FAB / section "+" | Hidden until LOADED and connected | Available once workspaces are known |
| A-8 | Connection banner | Shown for CONNECTING too | Banner only for OFFLINE; connecting is the top-bar dot |
| A-9 | Bots home offline with no cache | Skeleton forever | Offline-empty state |

## What landed (2026-10-21)

Desktop: D1–D12 as written. `bot-chat-pane.tsx` keeps one `requestId` per submission (`unsettledSend` after an uncertain failure, one id per failed row on Try again), shows a "Sending…" echo until the projected entry or queued row with the same text arrives (`settleBotPendingSends`, or 4 s after main confirmed the send), hides a paused card the moment Resume or Dismiss is pressed and restores it if main still reports the pause, and shows a stale view with a red "Try again" callout instead of a skeleton when a resubscribe fails. `use-bot-live.ts` remembers the last eight Bots' snapshots (`stale: true` until the fresh one lands; `reload` keeps the view; `forgetBotLiveView` on delete). `bot-identity.ts` keeps one edit stack per Bot (the last confirmed Bot plus the patches still in flight) and writes its result into `bot(id)` and every Bots list before the IPC (still get → update, so another surface's edit to a different field is kept); a failed patch drops out of the stack, keeps any newer Bot a reread brought meanwhile, and the Bot and the lists are reread once no edit is pending. The Instructions editor shows the new text in the cache at once and closes when main confirms, so a failed save keeps the draft. Create, preset start, delete, routines and Advanced write the answer into the TanStack cache and only then invalidate; `bots:createFromPreset` returns before the self-intro is sent. `useBot` seeds from the cached list and `/bots` redirects from a list cached within five minutes.

iOS: I-1, I-3 (draft only), I-4, I-5, I-6, I-7, I-9, I-10, I-11. `AidenInstallation.serverFeatures` keeps the last `/server` tokens (empty for pairings saved before) and `AidenRemoteCoordinator.knownServerFeatures` serves them until this connection answers; `AidenBotHostFeature.isAdvertised(_:coordinator:)` and the Bots home route read it. Steer/Queue clears the draft on screen as the input leaves, keeps the saved draft until the Mac admits the input (`AidenChatDraftStore.consumeDraft` then retires the admitted text under the pairing's ownership, whichever screen is current, only while the saved draft is still the one the input was sent from), and restores it (merged with anything typed since) on rejection or an unconfirmed send; rename shows the new title as a `localTitleOverride` in the list, Recents and the open chat; delete removes the Recents row at once; both roll back on failure.

Android: A-1, A-3, A-4, A-5, A-6, A-9. `AidenChatViewModel.activeClient()` follows the coordinator's current client for the chat's pairing (a Retry used to leave the open chat unable to load or send) and rereads the transcript when the pairing gets a new client; `AidenRemoteCoordinator.knownServerFeatures()` / `supportsBotDurableSession()` read the pairing's saved features; the routine Switch shows the flip until the Mac answers; a deep link to a chat saved on the device opens before the connection is up; `aidenBotsHomeContentState(isOffline:)` settles an offline first open.

Deferred from this pass, with the reason:

- I-2 and A-2 (send while connecting, flushed on connect): the send path owns a durable `PendingSend` with retry semantics on both phones; queuing before a client exists needs its own design so an offline send can never double-deliver.
- I-3 and A-3 pending bubble: Steer/Queue clears the draft at once, but the queued bubble still comes from the Mac's next projection (`submissionId` is a Bot-only tag today).
- I-8 (stub chat + transcript skeleton for a cold Recents open) stays on the cache-first plan.
- A-7 and A-8: the New chat FAB needs the chat list to be loaded (creating a chat needs the Mac anyway), and the connecting banner is already the quiet raised row from PR #374 with no top-bar indicator to replace it.
- Desktop workspace chats were already optimistic (`chat-message-queue`); nothing changed there.

## Follow-up: sends that look sent (2026-10-27)

The owner still felt a delay after pressing Send in a Bot chat. The message did appear at once, but faded with "Sending…" until the Mac accepted it, and on the Mac that waits for `bots:send` to resolve the Bot's model, rebuild its tools and connectors (`registry.refresh()`) and its system prompt before the input is admitted. The fade turning solid read as the moment the message was sent.

- Desktop: the echo is drawn exactly like the entry it becomes (same row, Copy and Reply), and says "Sending…" only once main has taken more than 2 s to accept it. A message sent while the Bot works shows as Queued at once. The Bot's "Getting ready" line shows from the send (as on the phones), and an interrupted card leaves with the send that dismisses it; a failed send drops the echo and the line and brings the card back. A failed send now shows one error toast instead of two (the pane and the composer both used to toast).
- iOS and Android: a message on its way is drawn as sent, with "Sending…" only once it has waited 2 s (offline, or a slow Mac). Queued, Steer and "Couldn't send · Try again" are unchanged; the phones already showed "Getting ready" at once.
- Not changed: how fast the Mac admits a send. Reusing the Bot's tool set and prompt between sends is a possible follow-up.

## Out of scope for this pass

Desktop read snapshots that survive a relaunch (cache-first plan D1, D3), the model catalog disk caches on both phones, Files/Git caches (I7, A5), and the paired-Mac remote Bot open on old hosts. These stay on the cache-first plan.

## Tests

Behavioral only, extending the existing suites. Desktop: `bot-chat-pane.test.tsx` (echo settles, failed send keeps its id, Resume failure replays the same id, Try again hides the card and mints one id), `bot-panel.test.tsx` (remembered view stale→fresh, reload keeps the view), `bot-create-flow.test.tsx` (navigates before the intro and list reread), `bot-routines.test.tsx`, `bot-profile.test.tsx` (optimistic rename and rollback, overlapping failed edits, subtitle clearing, Profile from the list without a skeleton), `bots-home.test.tsx`, `bot-delete-dialog.test.tsx`, `bot-starter.test.ts` (deferred intro). iOS: `AidenRemoteClientTests.testInstallationKeepsTheLastServerFeaturesForGatesWhileConnecting`, `AidenBotCacheTests.testDraftStoreConsumesAdmittedRunInputFromAnOlderSession`. Android: `AidenChatTest.chatKeepsLoadingWithThePairingsRefreshedClient`, `AidenChatTest.testDraftStoreConsumesAdmittedRunInputFromAnOlderSession`, `AidenRemoteCoordinatorClientTest.botDurableSessionGateReadsThePairingsSavedFeaturesUntilServerAnswers`, `AidenProductShellTest.testBotsHomeContentStates`. The toggle and draft flows on the phones are view-state changes exercised by hand on the next TestFlight and Android build.
