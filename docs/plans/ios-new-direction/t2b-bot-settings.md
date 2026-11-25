# T2B — Bot settings: Profile (11), Memory (25 + idea "Forget all"), Delete Bot (26)

Repo: `ios-new-direction` worktree = origin/main @ d476bc35d. All paths are repo-relative. Read-only audit; nothing run.
Current Aiden Remote contract revision on main: **65** (`main/services/aiden-remote-protocol.ts:373-374`). Any server change below claims the next revision at merge time and bumps iOS, Android and `protocol/aiden-remote/v1/fixtures` together.

---

## Screen 11 — Bot profile

### 1. Entry points and views
- Main view: `ios/AidenOnTheGo/Features/Bots/AidenBotProfileView.swift:118` `struct AidenBotProfileView`. Its parameters are coordinator, machine, initialSummary, onChanged, onDeleted, showsDismissButton, opensMemory and opensAdvanced.
- The profile is **presented as a sheet** everywhere. The concept shows a pushed page with a back button.
  - Bots home: `ios/AidenOnTheGo/Features/Bots/AidenBotsHomeView.swift:418-440` has sheets for `.profile`, `.memory` (`opensMemory: true`) and `.advanced`. The row context menu that opens them is at `:795-810`.
  - Bot chat: `ios/AidenOnTheGo/Features/Bots/AidenBotSessionChatView.swift:365` `.sheet(isPresented: $isShowingProfile)`. Menu cases are at `:512-517`, `:564` and `:805`. The "Memory updated" line opens Profile → Memory (`:1811`).
  - Chat detail: `ios/AidenOnTheGo/Features/Chat/AidenChatDetailView.swift:1266`.
- Subviews:
  - Skeleton: `AidenBotProfileView.swift:4-20`.
  - Identity saver: `:28-109`.
  - Toolbar: "Done" at `:199`, the ••• `moreMenu` at `:205` and `:329-352`.
  - Body ScrollView: `:354-487`.
  - Avatar and photo menu: `:496-575`.
  - Identity card: `:577-601`.
  - Instructions row: `:603-626`, which opens the editor at `:918-974`.
- Related views:
  - `AidenBotCharacterCard`: `ios/AidenOnTheGo/Features/Bots/AidenBotCharacter.swift:~60-127`.
  - `AidenBotRoutinesSection`: `ios/AidenOnTheGo/Features/Bots/AidenBotRoutinesView.swift:126-320`.
  - `AidenBotAllowedView`/`AidenBotAllowedModel`: `ios/AidenOnTheGo/Features/Bots/AidenBotAllowedView.swift`.
  - `AidenBotMemoryRow`: `ios/AidenOnTheGo/Features/Bots/AidenBotMemoryView.swift:512-540`.
  - `AidenBotAdvancedView`: `ios/AidenOnTheGo/Features/Bots/AidenBotAdvancedView.swift`.

### 2. What's live today
- **Layout, top to bottom** (`AidenBotProfileView.swift:354-487`):
  1. Offline banner "Offline — showing saved details".
  2. A 112pt round character ("pebble") avatar with a ••• photo badge (`:363`, `:496-575`). The photo menu offers Choose Photo, Create with Apple Intelligence and Remove Photo.
  3. Identity card with the TextFields "Name" and "What it helps with" (`:366`, `:577-601`).
  4. "Character" card: a 12-colour grid, 8 shapes and "Reset to default" (`:369-379`).
  5. Instructions row (`:381`).
  6. "Allowed without asking" row with `countSummary` (`:383-388`).
  7. Memory row (`:389-397`).
  8. Open work (`:399`), Bot peers (`:417`), Routine models (`:433`) and Watches (`:452`). Each is a **separate raised card** with a 20pt continuous radius.
  9. `AidenBotRoutinesSection` when `bot-routines-v1` is advertised (`:471-474`).
  10. The body is capped with `.frame(maxWidth: 640)` and has `.refreshable`.
- **••• menu** (`:329-352`):
  - Advanced.
  - Pause/Resume, which needs `supportsBotHandoffs`, rev 37. Gate at `:174-190`; `setPaused` at `:862` uses `pauseBot`/`unpauseBot` with an idempotency key. Server route: `main/services/aiden-remote-router.ts:3509`.
  - Delete Bot.
- **Data:**
  - `load` (`:691`) shows the cached detail from `AidenBotCache` first, then calls `client.bot(id:)` (GET `/bots/{id}`). It then sets up `allowedModel`, `prepareMemory` (`:662`) and `avatarModel`.
  - Identity edits are optimistic through `AidenBotIdentitySaver` (`:28-96`), a serialized lane with an `If-Match` revision. A lost answer is settled by re-reading.
  - Routines: `client.botRoutines(botId:)` and `botRoutineSuggestions`. The toggle is optimistic via `pendingEnabled` (`AidenBotRoutinesView.swift:126-320`) and saved with `updateBotRoutine` plus the revision.
  - Allowed: GET `bots/{id}/allowed` and POST `…/allowed/{entry}/remove` (`ios/AidenOnTheGo/Networking/AidenRemoteClient.swift:~3050-3058`).
- **States:**
  - Loading shows the skeleton (`:4-20`).
  - Load failure with no cache shows `ContentUnavailableView` "Couldn't Load Bot" with Try Again (`:310`).
  - Load failure with a cache shows the offline banner.
  - Save failure shows the "Something Went Wrong" alert (`:296`).
- **Gates** (`:174-190`):
  - `canWrite` needs the context held, a saver, `canWriteBots`, and no delete in progress.
  - `canDelete` needs `AidenBotDeletion.isAvailable` and a loaded detail.
  - `canPause` needs `canWrite`, a `sessionState`, and `supportsBotHandoffs`.

### 3. Concept delta (and the faithful version)
| # | Concept shows | Reality / rule | Faithful version |
|---|---|---|---|
| a | Large Hi-bit sprite | AGENTS: the Hi-bit sprite is the only Bot avatar. Main still draws the pebble character. The sprite is in **open PR #925** (`claude/hibit-sprite-avatars`: `AidenBotSprite.swift`, `AidenBotSpriteView.swift`, changes to `AidenBotSemanticAvatarView`). | Build on #925 and do not fork the sprite. Keep the photo badge, because a user photo still overrides the sprite. |
| b | Pink header gradient tinted from the Bot colour | Tint must come from theme tokens. | Use a soft wash from the Bot's semantic colour token, as a background only and not a border. It depends on the T4B Aurora token set. |
| c | "Runs on Studio Mac · active 4 min ago" | `AidenBotDetail` (`ios/AidenOnTheGo/Models/AidenBot.swift:479`) has **no machine field and no lastActive**. The machine name is available client-side via `coordinator.botInstallation(on:)?.name` (`AidenBotCreateOperations+Machine.swift:130-152`). Activity could come from `AidenBotConversationItem.updatedAt` (`AidenBot.swift:763`). | Show "Runs on {machine}" from the client. Show "active N ago" from the newest conversation `updatedAt` if one is loaded, otherwise leave it out. A dedicated `lastActiveAt` field is optional and needs the server. |
| d | Chat / Voice / Pause tiles | Pause already exists, buried in ••• behind `canPause`. Chat is the Bot session. Voice is owned by T1B/T2A. | Use three squircle action tiles with the shared button treatment (`docs/design-guide.md`). Hide Pause when `supportsBotHandoffs` is false. Hide Voice until T1B's live-voice entry exists. Chat dismisses the sheet or pops to the session. |
| e | Routines card with a calendar or clock icon per row and a toggle | Rows have **no leading icon** today (`AidenBotRoutinesView.swift:126-320`). The schedule text is the host's `routine.label`. | Add a leading SF Symbol (calendar for weekly, clock for daily, chosen from the routine schedule kind) in a soft neutral fill. Keep the host label, the optimistic toggle, the suggestion row and "Add routine". |
| f | Memory chips ("No mushrooms") plus "Manage memory >" with an SD-card label | Today it is a single row: sdcard icon, "Memory", count and chevron (`AidenBotMemoryView.swift:512-540`). Memory is already loaded on the profile (`prepareMemory`, `:662`). | Show the first 2-3 entries as chips (truncated, from the `user` group then the `memory` group), then a "Manage memory" link. Keep the **`sdcard`** symbol (`AidenBotMemoryView.swift:241-243`). Never use a brain. When `readable == false`, show the existing unreadable copy instead. |
| g | "Can use": Reminders "Allowed" (green), Calendar "Asks first" (orange) | **No per-tool Allowed/Asks-first model exists.** `AidenBotCapabilityOption` is `{id, label, available, description}` (`AidenBot.swift:1005`). The catalog is on/off toggles in Advanced (`AidenBotAdvancedView.swift:318-350`, "Everything / Only what I pick"). "Allowed without asking" is a separate grants list (`AidenBotAllowedView.swift`). | **Faithful:** a "Can use" card that lists enabled connections and skills (or "Everything") and links to Advanced. Below it, a row "Allowed without asking: N" linking to AidenBotAllowedView. Status uses soft semantic fills and labels with **no coloured borders**. Real per-tool "Asks first" needs the server (see §4). |
| h | No Character editor, name/subtitle fields or Instructions | All of these are live editing features and must not be lost. | Move editing behind **••• → Edit Bot** (a pushed "Edit" page that holds the identity card, Character card, photo menu and Instructions). Alternatively keep an "Edit" row. This is an owner question. |
| i | Drops Open work, Bot peers, Routine models, Watches and Advanced | These are live, feature-gated rows. | Keep them in a grouped "More" card with inset separators per `docs/settings-design-system.md`. Today each is a separate raised card, which breaks the grouped-card rule. |
| j | Pushed page with a back button | Live uses a sheet with "Done". | Depends on the shell/nav decision (T1A). The profile view already supports `showsDismissButton`, so push vs sheet is a call-site change. |

### 4. Gap class
- a: cross-platform asset dependency (PR #925). Not a server change.
- b, d (layout), e, f, h, i: **UI-only**.
- c (machine name, activity from conversations): **client model/state**. It is new derived state on the profile model.
- c (`lastActiveAt`), optional: **server contract**. Add `lastActiveAt` to the bot detail projection served by GET `/bots/:botId` in `main/services/aiden-remote-router.ts`, built in the bot projection. Then add it to `AidenBotDetail` (`AidenBot.swift:479`), Android's bot model and the contract fixture, bumping the revision 65 → next.
- g faithful version: **UI-only** (it composes the existing catalog and allowed count). Real "Asks first": **server contract**, a per-capability approval mode on `/bot-capabilities` (`AidenBotCapabilityCatalog`, `AidenBot.swift:1087`). That is **cross-platform**: desktop UI, Android and fixtures. Not recommended without an owner decision.
- j: **cross-platform nav** (T1A shell).

### 5. Implementation steps
1. Extract `AidenBotProfileHeader` (sprite, name, subtitle, tint wash) into `ios/AidenOnTheGo/Features/Bots/AidenBotProfileHeader.swift`, using the #925 sprite view.
2. Add `AidenBotActionTiles` (Chat / Voice / Pause) as a shared squircle-tile component, reusing the shared button style. It is wired to the existing `setPaused` (`AidenBotProfileView.swift:862`) and the `canPause` gate.
3. Add a leading schedule icon to the routine rows in `AidenBotRoutinesView.swift`. The icon is derived from the schedule kind, with no new data.
4. Replace `AidenBotMemoryRow` with `AidenBotMemorySummaryCard` (chips plus "Manage memory") in `AidenBotMemoryView.swift`, fed by the profile's `memoryModel`.
5. Add `AidenBotCanUseCard`, composed from the capability catalog and `AidenBotAllowedModel.countSummary`.
6. Move the identity card, Character card, photo menu and Instructions row into a new `AidenBotEditView`, reached from ••• → "Edit Bot". The saver and `canWrite` gates stay as they are.
7. Group Open work, Peers, Routine models, Watches and Advanced into one inset-separator card.
8. Add `runsOn` and `activeAgo` derivation to the profile model (machine name via `botInstallation(on:)`, activity from conversations).
9. Demo: extend `AidenDemoContent` / `AidenDemoBotUX.register` (`ios/AidenOnTheGo/Features/Remote/Demo/AidenDemoHosts.swift:720-724`, `AidenDemoBotUX.swift`) to serve `/bots/{id}/routines`, `/allowed` and `/memory`, so the profile renders fully under `-AidenDemoBotUX`. Add a capture to `AidenOnTheGoUITests/AidenBotUXUITests.swift` (launches at `:25`, `:95`) via `AidenStateMatrix.launch(scenario: .one, …)`.
10. Tests, behavioural only:
    - The `activeAgo` derivation picks the newest conversation, and returns nil with none.
    - The memory summary chip ordering and limit.
    - "Can use" shows "Everything" vs a picked list.
    - Pause tile hidden without `supportsBotHandoffs`.
    - Extend `AidenBotHomeProfileTests.swift` rather than adding one-offs.

### 6. Effort and risk
- Effort: **L**. Most of it is UI-only, but the edit-page split touches the saver flow.
- Risk:
  - Hiding editing could regress discoverability.
  - The sprite dependency on #925.
  - Sheet vs push depends on T1A.
- Dependencies: PR #925 (sprite), T4B tokens (tint), T1B (Voice), T1A (nav), owner answers on h and g.

---

## Screen 25 — Bot memory (and idea-bot-memory "Forget all")

### 1. Entry points and views
- Profile → Memory: `AidenBotProfileView.swift:224-228` pushes `AidenBotMemoryView(model:canWrite:)`.
- Bots-home context menu "Memory": `AidenBotsHomeView.swift:795-810`, opened with `opensMemory: true`.
- The chat "Memory updated" line: `AidenBotSessionChatView.swift:1811`.
- Views, all in `ios/AidenOnTheGo/Features/Bots/AidenBotMemoryView.swift`:
  - `AidenBotMemoryView` at `:254-399`.
  - Skeleton at `:402`.
  - `AidenBotMemoryUsageMeter` at `:424`.
  - `AidenBotMemoryEditSheet` at `:452` (with a 500-char counter).
  - Copy at `:5-69`.
  - Symbol at `:241-243` (`"sdcard"`).
- Models: `ios/AidenOnTheGo/Models/AidenBotMemory.swift`:
  - Wire limits at `:9` (500 chars, 64 entries per group).
  - Targets at `:24` (`user`, `memory`).
  - Group at `:54` (`usedChars`, `limitChars`, `overBudget`, `fraction`).
  - View at `:93` (`botId`, `revision`, `readable`, `memory`, `user`, `updatedAt`).
  - Edits at `~:214` (replace, remove, clear). **There is no add.**
  - Failures at `~:314`.

### 2. What's live today
- **Data:**
  - `AidenBotMemoryTransport` (`AidenBotMemoryView.swift:73`) has two calls:
    - `AidenRemoteClient.botMemory(botId:)` (`AidenRemoteClient.swift:3060`) sends GET `/bots/{id}/memory`.
    - `editBotMemory(botId:request:idempotencyKey:)` (`:3069`) sends POST `/bots/{id}/memory/edits` with an `Idempotency-Key` header.
  - **There is no PUT.** The brief's "GET/PUT" is really GET plus POST `…/memory/edits`.
  - Server side: routes `["/bots/:botId/memory", "/bots/:botId/memory/edits"]` (`main/services/aiden-remote-router.ts:638`). The handlers are at `:3934-3960`: GET needs `bot:read` plus `chat:read`; POST needs `bot:write` plus `bot:read` and `chat:read`, and takes a body of at most 4 KB. The feature token `bot-memory-v1` is advertised at `:1935` (rev 27).
- **Model** (`AidenBotMemoryModel`, `:90`):
  - Optimistic apply (`:177`) through a serialized lane.
  - `send` (`:192`) keeps one idempotency key per edit and re-reads on failure.
  - 12s limit via `aidenBotWithin`.
  - `erase()` (`:168`) applies `.clear`.
  - Error mapping is at `:222`.
- **Layout:**
  - Inline title "Memory".
  - Description section "What {bot} remembers about you and its work. It's stored on your computer…".
  - Two groups, "About you" (USER.md) and "{bot}'s notes" (MEMORY.md). Each row is a `Label` with the sdcard icon (`:361-369`), with swipe Edit/Delete and a context menu. Each group has a footer `AidenBotMemoryUsageMeter` ("174 of 1,375 characters" plus a bar).
  - Then a red "Erase memory" Section button (`:313`) that confirms through `confirmationDialog` (`:271`) "Erase everything {bot} remembers?" / "This can't be undone."
- **States:**
  - Loading shows the skeleton.
  - An empty group shows `aboutYouEmpty` / `notesEmpty`.
  - `readable == false` shows the unreadable section.
  - Over budget shows the `overBudget` copy.
  - Edit failures show `entryChanged`, `notSaved` and `blocked`.
  - An erase failure shows `notErased` ("Memory wasn't erased. Please try again.").
  - Read-only (`canWrite` false) hides the edits.
- **Demo:** `AidenDemoHosts.swift:764` advertises `bot-memory-v1` but **does not serve `/bots/{id}/memory`** (only `/bots`, `/bots/{id}` and `/session` at `:720-724`). In demo mode the memory row and page therefore fail. The live screenshot used scratch data.

### 3. Concept delta (and the faithful version)
| # | Concept | Faithful version |
|---|---|---|
| a | Large title "Memory" with a small sprite and the Bot name under it | Large nav title. A sprite plus name header uses the #925 sprite at a small size. |
| b | Usage "47 of 1,375 characters" trailing in the group header, no meter bars | Move `AidenBotMemoryCopy.usage(used:limit:)` into the section header's trailing slot. Drop the bar. Keep the over-budget state as a soft warning label, with no coloured border. |
| c | Plain rows with no per-row icons | Drop the per-row sdcard icon. **Keep SD-card iconography** (`AidenBotMemorySymbol`) in the header, the empty state and the profile summary card. Never a brain. |
| d | No description text | Keep the privacy line ("stored on your computer") as a short footer under the last group. It is the only on-screen privacy statement and AGENTS asks onboarding and privacy expectations to stay visible. This is an owner question if they want it gone. |
| e | Centered red destructive text at the bottom, "Erase memory" (25) or **"Forget all"** (idea) | A centered plain destructive button in its own section, keeping the confirmation. |
| f | idea: rename to "Forget all" | The copy is **shared across platforms**: iOS `AidenBotMemoryCopy` (`:5-69`, "shared with desktop and Android"), Android `strings.xml:613-633` (`bot_memory_erase`), and desktop `renderer/main/bots/bot-memory-page.tsx:415,446,475`. The rename must land on all three. Suggested set: button "Forget all"; confirm title "Forget everything {bot} remembers?"; failure "Memory wasn't cleared. Please try again." Keep "This can't be undone." |
| g | Pre-existing drift | Android `bot_memory_description` says "stored on this Mac" while iOS says "stored on your computer". Fix both in the same PR. "your computer" is correct, since hosts include Linux and the CLI. |

### 4. Gap class
- a-e: **UI-only**.
- f-g: **cross-platform**, copy only. No server or protocol change.
- Demo memory fixture: **UI-only** (demo).

### 5. Implementation steps
1. **(P0)** Copy: update `AidenBotMemoryCopy.eraseMemory`, `eraseConfirmation` and `notErased` in `AidenBotMemoryView.swift:5-69`. Make the matching edits in Android `strings.xml:613-633` (plus the description drift) and desktop `bot-memory-page.tsx`. Update the existing assertions that pin the old copy:
   - iOS: `AidenBotMemoryTests.swift` (`:138`, `:244`, `:271`, `:325`, `:357`, `:363`).
   - Android: the memory screen tests.
   - Desktop: `bot-memory-page` test.
   - Update `docs/settings-design-system.md:141`, which says "Erase memory", and any onboarding or docs mention.
2. **(P0)** Demo: serve GET `/bots/{botId}/memory` and POST `…/memory/edits` in `AidenDemoContent`/`AidenDemoBotUX`. Use a fixture in the shape of `protocol/aiden-remote/v1/fixtures/contract.json`, with both groups, one entry near the limit and one empty-group variant. Add a capture step in `AidenBotUXUITests.swift`.
3. **(P1)** Restyle `AidenBotMemoryView`: header with sprite and name, usage in the section header, plain rows (keep swipe and context menu), a footer description and a centered destructive section. Delete `AidenBotMemoryUsageMeter` if nothing else uses it.
4. **(P1)** Optimistic "Forget all": `erase()` already applies `.clear` optimistically. Verify that the empty state shows instantly and that it restores on failure. A behavioural test drives `AidenBotMemoryModel` with a failing fake transport and asserts the entries come back plus the `notErased` message. Extend `AidenBotMemoryTests.swift`.
5. Tests: no tests of copy strings beyond those already present. Behavioural tests:
   - Usage header text for given used/limit.
   - The over-budget flag shows a warning.
   - Unreadable shows the unreadable section and no edit actions.

### 6. Effort and risk
- Copy rename: **S**, though it touches three platforms. Restyle: **M**.
- Risk: low. The protocol is unchanged. The main risk is copy drift between platforms, so land the rename in one PR.
- Dependencies: #925 for the header sprite (it can fall back to the current avatar).

---

## Screen 26 — Delete Bot

### 1. Entry points and views
- Shared confirmation: `ios/AidenOnTheGo/Features/Bots/AidenBotCharacter.swift:~230` `AidenBotDeleteConfirmation`:
  - Title: "Delete {name}?"
  - Message: "This permanently erases {name}'s chat, memory, instructions, routines, files, and photo. This can't be undone."
  - Confirm button: "Delete Bot".
- The modifier `aidenBotDeleteConfirmation(isPresented:botName:onConfirm:)` at `:243` is a system `.alert`.
- Entry points:
  - Bots-home row context menu "Delete": `AidenBotsHomeView.swift:806`. Confirm at `:443`, action at `:960-970`.
  - Profile ••• → Delete Bot: `AidenBotProfileView.swift:329-352`. Confirm at `:282`, action at `:895-914`.
  - Bot chat menu: `AidenBotSessionChatView.swift:331` (confirm) and `:528-542` (action), which uses `AidenBotSessionTools.delete` (`:2235-2283`; `canDelete` at `:2277`).
  - Chat detail: `AidenChatDetailView.swift:561` (confirm), `:1172` (`canDelete`) and `:1306-1310` (action).
- Logic: `enum AidenBotDeletion` (`AidenBotCharacter.swift:131`).
  - `hostFeature = "bot-delete-v1"`.
  - `isAvailable` needs `canWriteBots`, a connection, and the feature.
  - `delete` sends DELETE, then calls `forget`.
  - `deleteListed` reads the revision first; a 404 means already gone.
  - `forget` purges the routine and peer control stores, `AidenBotCache.removeBotAndStore`, the avatars and `AidenChatDraftStore`.

### 2. What's live today
- **Client call:** `AidenRemoteClient.deleteBot(id:revision:)` (`AidenRemoteClient.swift:2341`) sends DELETE `/bots/{id}` with `If-Match` and accepts 204 or 404.
- **Server:** `aiden-remote-router.ts:4075-4092` requires `bot:write` plus `bot:read`, requires the `if-match` header, and returns 204. The feature is advertised at `:1927`.
- **UI:** a system alert (iOS 26 glass) over the list or profile, with Cancel and a destructive "Delete Bot". The copy already **matches the concept word for word**.
- **Not optimistic:**
  - The profile awaits the server, then `onChanged`, `onDeleted` and dismiss (`AidenBotProfileView.swift:895-914`). On error it shows "{name} wasn't deleted. Please try again."
  - Home awaits `deleteListed`, then `await load()` (`AidenBotsHomeView.swift:960-970`), so the row stays until the server answers.

### 3. Concept delta (and the faithful version)
| # | Concept | Faithful version |
|---|---|---|
| a | Dialog over the Bot's own page | Already possible from Profile ••• and the Bot chat. Nothing to do beyond the nav decision (screen 11 j). |
| b | Custom centered card with pill buttons: Cancel (neutral fill) and "Delete Bot" (red text on a soft red fill) | Option 1 (recommended): keep the system `.alert`, which gives free accessibility, focus and glass. Option 2: a shared `AidenConfirmCard` (also usable for Forget all) with two squircle buttons, the danger one on a soft semantic danger fill, which AGENTS allows. It needs no border, a visible focus ring, and a reduced-motion-safe present. |
| c | (implicit) instant | Make delete **optimistic**, per the owner's preference: on confirm, remove the row or dismiss the profile immediately, call `forget` after success, and on failure re-insert the row with the existing error message. A 404 counts as success (`isAlreadyGone`). |

### 4. Gap class
- a: cross-platform nav (T1A).
- b: **UI-only**. If the card is chosen, it is a shared component, and desktop already has `renderer/main/bots/bot-delete-dialog.tsx:20` with the same message.
- c: **client model/state**. It needs a pending-deletion set in the home list model and the profile's `onDeleted` contract. No server change.

### 5. Implementation steps
1. **(P3)** Add a `pendingDeletions: Set<String>` to the Bots home list state (`AidenBotsHomeView.swift`). Filter rows by it. On confirm, insert the id and run `AidenBotDeletion.deleteListed` in a Task. On success call `load()`; on failure remove the id and show the error.
2. Profile: call `onDeleted` and dismiss before the network call. Hand the work to the same home-level deleter so a failure surfaces on the list, not in a dismissed sheet. The Bot chat (`AidenBotSessionChatView.swift:528-542`) and chat detail (`AidenChatDetailView.swift:1306`) paths route through it too.
3. Optional: add `AidenConfirmCard` in `ios/AidenOnTheGo/Shared/` and swap `aidenBotDeleteConfirmation` (`AidenBotCharacter.swift:243`) to use it, keeping the same title, message and button API.
4. Demo: serve DELETE `/bots/{id}` (204) in demo mode so the flow can be captured. Add a capture to `AidenBotUXUITests.swift`.
5. Tests (behavioural):
   - With a failing fake client, the row disappears at once and then reappears with the error.
   - A 404 ends with the row gone and no error.
   - A success purges the caches (assert through the store API).
   - Extend `AidenBotHomeProfileTests.swift` (deletion gate at `:199-203`).

### 6. Effort and risk
- Optimistic delete: **M**. Confirm card: **S-M**.
- Risk:
  - A failed optimistic delete after the profile is dismissed needs a visible home-level error.
  - A race with an in-flight `load()`, which must respect `pendingDeletions`.
- Dependencies: none on the server.

---

## Shared components to extract
- `AidenBotProfileHeader`: sprite (#925), name, subtitle and tint wash. Reused by Profile (11) and Memory (25). T2A's Bot chat header could also use it.
- `AidenBotActionTiles`: squircle action tiles (Chat / Voice / Pause).
- `AidenBotMemorySummaryCard`: chips plus "Manage memory", with the `sdcard` symbol.
- `AidenBotCanUseCard`: enabled capabilities plus the "Allowed without asking" count.
- `AidenSettingsGroupCard`: an inset-separator grouped card for row lists, per `docs/settings-design-system.md`. Check with T4A whether one already exists or is planned.
- `AidenConfirmCard`, optional: a destructive confirmation for Delete Bot and Forget all.
- Demo bot fixtures for memory, routines, allowed and delete, in `AidenDemoHosts.swift` / `AidenDemoBotUX.swift`.

## Phase order
1. **P0:** "Forget all" copy rename across iOS, Android and desktop, plus the Android "this Mac" drift fix. Add the demo memory, routines, allowed and delete fixtures with captures. (S, no dependencies)
2. **P1:** Memory page restyle: header usage, plain rows, centered Forget all, footer description, and a test of the optimistic erase rollback. (M)
3. **P2:** Profile glance layout: header, action tiles, routine icons, memory summary, Can use (faithful version), grouped More card, and editing moved to an Edit page. (L; needs #925, T4B tokens and the owner's answer on editing)
4. **P3:** Optimistic delete, plus the optional confirm card. (M)
5. **P4, only if wanted:** server `lastActiveAt` on the bot detail, and/or per-capability "asks first". Each is a protocol bump (65 → next) across iOS, Android and fixtures.

## Open questions for the owner
1. Where do name, subtitle, Character, photo and Instructions editing live once the profile becomes a glance page: ••• → Edit Bot, or an inline "Edit" row?
2. "Can use" with Allowed / Asks first: accept the faithful version (enabled capabilities plus the Allowed-without-asking count), or fund a real per-tool approval mode (a server change)?
3. What does the Voice tile open, and should it ship before T1B's live voice?
4. Should the Profile be a pushed page (as in the concept) or stay a sheet?
5. Should "Forget all" replace "Erase memory" on desktop and Android too? (Recommended, since the copy is shared.)
6. Is a server `lastActiveAt` wanted, or is "active N ago" from loaded conversations (or nothing) enough?
7. Should the Memory page drop its "stored on your computer" description? (Recommended to keep it as a footer.)
8. Should delete keep the system alert, or use a custom confirm card?
