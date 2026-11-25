# Track 2A: Bots (concepts 4 Bot chat, 6 Meet your Bot, 10 Bots gallery)

Agent: t2a-bots. This review was read-only. The repo is `ios-new-direction` at d476bc35d, which equals origin/main.

Path conventions:
- iOS paths are relative to `ios/AidenOnTheGo/` unless they start with `ios/`, `main/`, `renderer/`, `android/`, `docs/` or `protocol/`.
- Android paths are relative to `android/app/src/main/java/sbtbiswas/AidenOnTheGo/`.

Images used:
- Live: live shot `04-bot-chat.png`, `06-new-bot.png`, `10-bots.png`.
- Concepts: concept `04-bot-chat.png`, `06-meet-your-bot.png`, `10-bots-gallery.png`.

## 0. Cross-cutting prerequisite: Hi-bit sprite avatars (PR #925 is not merged)

Every concept screen draws Bots as Hi-bit pixel sprites. **That system is not on `main`.** It lives in open PR #925 ("Draw Bot avatars as Hi-bit pixel sprites with live activity states", `gh pr view 925` → OPEN, branch `claude/hibit-sprite-avatars`).

What `main` does today:
- `Features/Bots/AidenBotSemanticAvatarView.swift:120` draws the old smooth avatar. All three live screenshots show it: a pink circle with two eyes.
- Callers reach it through `AidenBotCanonicalAvatarView` (`Features/Bots/AidenBotGeneratedAvatarLifecycle.swift:1020`).
- The first-Bot carousel calls `AidenBotSemanticAvatarView` directly (`Features/Bots/AidenBotPresetsView.swift:76`).

What PR #925 adds:
- On iOS:
  - `Features/Bots/AidenBotSprite.swift` (geometry, tones, nine states).
  - `Features/Bots/AidenBotSpriteView.swift`, with `AidenBotSpritePose` at :10, `AidenBotSpriteSchedule` at :181 and `AidenBotSpriteCanvas` at :197.
  - `ios/AidenOnTheGoTests/AidenBotSpriteTests.swift`.
- `AidenBotSprite.kt` on Android.
- A `botAvatarSprite` section in `protocol/aiden-remote/v1/fixtures/contract.json`.
- The plan `docs/plans/hibit-sprite-avatars-plan.md`.
- It needs **no protocol revision**. The avatar stays `{version:1, shape, color}`, with 8 shapes and 12 colors (`Models/AidenBot.swift:197-215`).

Rules in the PR #925 plan that these concepts must follow:
- The canonical photo still wins over the sprite (plan :13).
- **Phone home rows never show done.** Phones get only session state, `needsYou` and `lastReplyAt`, so done shows only in the phone chat header (plan :89).
- Idle avatars on phones are static (plan :90).
- Pickers and onboarding art are static idle (plan :97). Home rows and the chat header animate (plan :96).
- Reduce Motion shows the still pose (plan :92).

**Dependency.** Merge #925 before any work in this track. Every step below assumes that `AidenBotCanonicalAvatarView` renders the sprite and takes a state.

---

## Concept 4: Bot chat

### 1. Screen and entry point
- **Entry:** Bots tab → tap a Bot row (`Features/Bots/AidenBotsHomeView.swift:741` `botRow`). The Bot can also be opened from the Inbox, from search, or from a profile.
- **View:** `AidenBotSessionChatView` (`Features/Bots/AidenBotSessionChatView.swift:84`, 2283 lines).
- **Model:** `AidenBotSessionModel` (`Features/Bots/AidenBotSessionModel.swift`, 3415 lines).

### 2. What's live today

**Header** (`AidenBotSessionChatView.swift:324-328`, `header` at :562-587):
- `.navigationTitle` plus a `.principal` toolbar item. That item is a button with a 26 pt `AidenBotCanonicalAvatarView` and the name in `.headline`, and it opens Profile.
- A `moreMenu` in the trailing slot.
- A system back chevron.

**Transcript** (`transcript` at :592): a ScrollView over `AidenTranscriptRowStack`. In order, it shows:
1. The skeleton.
2. `AidenBotTranscriptRow.rows`.
3. The partial (streaming) row.
4. Queued messages, then outgoing messages.
5. Open issues → `AidenBotIssueCardView` (:619-630, revision 42 `bot:issues`, cited from `.memory/bot-proactivity.md`).
6. The approval card, or `AidenApprovalAnsweredLine` once answered (:631-635).
7. `AidenBotStatusLineView` (:1750).

**Entries** (`entryView` at :812-910):

| Entry | How it renders |
|---|---|
| User message | Bubble in `palette.raised`, corner radius 20, `.padding(.leading,48)` |
| Assistant message | `assistantBubble` (:1013-1019) is **unfilled** full-width `AidenMarkdownView` |
| `connectCard` | `AidenBotConnectCardView` (:2111) |
| `failedTurn` | `AidenBotFailedTurnCard` (:1995) |
| `routineProposal` | `AidenBotRoutineProposalCardView` (:1832-1899) |
| `settingsChange` | `AidenBotSettingsChangeCardView` (`Features/Bots/AidenBotSuggestionCards.swift:11`) |
| `skillProposal` | `AidenBotSkillProposalCardView` (:175) |
| `lesson` | `AidenBotLessonCardView` (:240-298) |
| `memoryTidy` | `AidenBotMemoryTidyLine` (:301) |
| `memoryUpdated` | `AidenBotMemoryUpdatedCaption` (:1812). The `rowView` at :798 maps the row to it. |

**Routine suggestion card** (`AidenBotRoutineProposalCardView`, :1832-1899):
- A `calendar.badge.clock` icon in a 40×40 square.
- Title "Add a routine?" and body "{name} · {label}", from `AidenBotSessionCopy` (`AidenBotSessionModel.swift` ≈:338-345).
- The prompt, at most 2 lines.
- Buttons "Add routine" (prominent) and "Not now".
- After an answer it shows "Added ✓" or "Not added". If the person can't answer here, it shows `finishOnMacReadOnly`.
- Data: `AidenBotRoutineProposalCard` (`Models/AidenBotSession.swift:211`) has `proposalId`, `name`, `prompt`, `label`, `status` (pending, accepted or dismissed), `routineId` and `createdAt`.
- Answering calls `POST /bots/{id}/routine-proposals/{proposalId}/respond` (`Networking/AidenRemoteClient.swift:3096`). The host route is `main/services/aiden-remote-router.ts:639`, at revision 27 `bot:cards`.
- The label comes from `botRoutineProposalWhen` (`main/services/aiden-remote-bot-session.ts:645-660`).

**Lesson card** (`AidenBotLessonCardView`, `Features/Bots/AidenBotSuggestionCards.swift:240-298`):
- A proposal is a card with a lightbulb, "I learned something about {routine}", the lesson text, "Based on N recent runs", and Not now / Add.
- A learned lesson is an `AidenBotReceiptLine` (:317) that reads "Learned: … Undo".
- Answering uses `POST /bots/{id}/lessons/{lessonId}/respond` and `/remove` (`Networking/AidenRemoteClient.swift:2612,2623`). The host route is `aiden-remote-router.ts:621-623`, at revision 61 `bot:suggestions`.

**Memory receipts:**
- `AidenBotMemoryUpdatedCaption` (:1812) shows "Memory updated" with the `AidenBotMemorySymbol.name` icon. That symbol is `"sdcard"` (`Features/Bots/AidenBotMemoryView.swift:241-242`), so it is AGENTS-compliant.
- `AidenBotMemoryTidyLine` (`AidenBotSuggestionCards.swift:301-308`) uses **`memorychip`**. That is inconsistent with the SD-card rule for Memory.
- The wire `memory_update` entry carries only `{id, createdAt}`:
  - iOS model: `Models/AidenBotSession.swift:259` (`knownTypes`).
  - Host projection: `main/services/aiden-remote-bot-session.ts:640-643`.
  - Protocol type: `main/services/aiden-remote-protocol.ts:1673`.
  - Host source data: `renderer/shared/bot-live.ts:184` (`targets` and `source` only, **no text**).

**Approvals** (`approvalCard` at :1096):
- With `approval.card` (revision 61 `approval:cards`), it shows `AidenTypedApprovalCard` (`Features/Chat/AidenTypedApprovalCard.swift:9`). That card has a title, a Before section, detail rows, Deny, and a split "Allow once ▾" control built from a Menu (:197-230). Once answered, it becomes `AidenApprovalAnsweredLine` (:242).
- Otherwise it falls back to `legacyApprovalCard` (:1109). That shows "You've allowed this N times in the last 2 weeks." and an "Always allow for {name}" button around `AidenApprovalCard` (`Features/Chat/AidenChatCards.swift:8`).
- Data: `AidenRemoteBotApproval` (`Models/AidenBotSession.swift:589`).
- Answering uses `POST /approvals/{id}/respond` (`Networking/AidenRemoteClient.swift:3745`) through `answerApproval(button:)` (`AidenBotSessionModel.swift:2410`).

**Dock:**
- `dockNotices` (:1137) holds the connection hint, question card, plan card and access request.
- `footerCards` (:1180) holds handoff, spending, NeedsModel, Paused and Interrupted.
- The composer is `AidenComposerConfig.bot()` (:1031). `composerPlaceholder` (:1359) gives state-specific placeholders, and the live screenshot shows plain "Message".

**States:**
- Skeleton on a cache miss.
- "Connecting…" hint in the dock.
- `AidenBotFailedTurnCard` for a failed turn.
- Paused, interrupted and needs-model footers.
- The live screenshot (`-AidenDemoBotUX`) shows lesson, receipt and typed approval cards. The demo data comes from `Features/Remote/Demo/AidenDemoBotUX.swift:38-81`. It has settings_change, skill_proposal, lesson ×2 and memory_tidy, but **no `routine_proposal` and no `memory_update`**.

### 3. Concept delta

| # | Item | Concept | Live | Faithful version and notes |
|---|---|---|---|---|
| 4.1 | Header | Large centered sprite (~64 pt), name pill, subtitle "Runs on Studio Mac · Remembers what you tell it", timestamp "Today 9:41 AM", drawer button on the left (no back chevron), ••• on the right | 26 pt inline avatar and name, back chevron | A large "speaks-first" header at the **top of the transcript**, so it scrolls away. The nav bar keeps a compact avatar and name that appear after scrolling (the iMessage pattern). Machine name comes from `installation`. Show the "Remembers…" clause only when memory is on for the Bot. The drawer versus back button belongs to the shell track. The sprite animates in the header and can show the done moment (plan :89, :96). |
| 4.2 | Assistant bubble | Gray filled bubble | Unfilled markdown, full width | This is a **cross-screen chat style decision** (the main chat uses the same unfilled style). Defer to the T1B composer and chat track. A Bot-only fill would split the transcript language. |
| 4.3 | Routine card | Calendar-clock icon, "Sunday routine", "Every Sunday at 5 PM", one full-width "Turn on" | Icon, "Add a routine?", body, prompt, Add routine and Not now | Use the routine **name** as the title and `label` as the subtitle. "Turn on" is fine as the primary copy. **The concept has no dismiss path, which contradicts the pending/accepted/dismissed model** (`AidenBotRoutineProposalCard.status`). Keep "Not now" as a secondary button, or put it in a trailing ••• menu. Keep the answered and read-only states. Do not show the prompt (or show it collapsed), to match the concept's density. Note that `label` ends in "· Zone" (`.memory/bot-proactivity.md`). Keep it, or shorten it only when the zone equals the device zone (open question). |
| 4.4 | Memory receipt | "Saved to memory: no mushrooms" with an SD-card icon | "Memory updated" with `sdcard` | The icon already matches. **The text needs new data**: neither the wire entry nor the host's live entry (`bot-live.ts:184`) records what was saved. See gap 4.4. In the meantime, keep "Saved to memory" as the copy and open Memory on tap (already wired). |
| 4.5 | Memory tidy icon | — | `memorychip` (`AidenBotSuggestionCards.swift:308`) | Swap to `AidenBotMemorySymbol.name` (`sdcard`). This is a small AGENTS fix. |
| 4.6 | Lesson card | (not in the concept frame; in scope per brief) | Proposal card and receipt | Restyle only. Put the lightbulb in a soft-fill circle like the routine card, and keep "Not now" / "Add". The receipt keeps Undo. |
| 4.7 | Approval card | (not drawn; in scope) | Typed card with a split Allow | Restyle only. Use the shared card surface, the shield in a soft fill, and status colors as soft fills (no colored borders, per AGENTS). Keep the Menu split control, because it carries the allow scopes. |
| 4.8 | Inline permission rows | — | `AidenBotAccessRequestCard`, `AidenBotConnectCardView`, answered lines | Unify them into one **inline action row** pattern: icon, one-line text, trailing action. Reuse `AidenBotReceiptLine` (:317), which already does this at a 44 pt minimum height. |
| 4.9 | Composer | "+", "Message Meal Planner", mic, dark waveform button | "Message" | The placeholder becomes "Message {name}", which `composerPlaceholder` can do in its default branch. The waveform and mic belong to the T1B composer track. |
| 4.10 | Tab bar | Chats, Bots, Workspaces, Inbox with a dot | Shell tabs | Belongs to the shell and nav track. Nothing to do here. |
| 4.11 | Timestamp | "Today 9:41 AM" under the header | none | Use the first entry's `createdAt` or `lastReplyAt`, formatted the same way as `AidenRelativeTimestampView` (`Features/Workspace/AidenRelativeTimestamp.swift:19`). |

### 4. Gap class

| Item | Class |
|---|---|
| 4.1 | UI-only. The machine name is client state (`installation`) and needs no wire change. |
| 4.2 | UI-only, but cross-track (T1B). |
| 4.3 | UI-only. |
| 4.4 | **Server contract plus host data. Cross-platform.** See below. |
| 4.5 | UI-only. |
| 4.6 | UI-only. |
| 4.7 | UI-only. |
| 4.8 | UI-only. Extract a shared component. |
| 4.9 | UI-only (placeholder). The waveform goes to T1B. |
| 4.10 | Shell track. |
| 4.11 | UI-only. |

What 4.4 needs:
- The host's memory tool writes must keep a short bounded summary of what was saved (for example `saved?: string[]` of at most ~80 characters per item, or a `summary` string) on the live `memory_update` entry (`renderer/shared/bot-live.ts:184`). That comes from the memory-tool code path that emits it.
- The projection (`main/services/aiden-remote-bot-session.ts:640`) and the protocol type and parser (`aiden-remote-protocol.ts:1673`, :6249) gain an optional `text` field.
- The iOS `AidenBotSessionEntry.memoryUpdate` (`Models/AidenBotSession.swift:259`) and Android (`AidenBotSessionController.kt` / `AidenBotUxEntryCards.kt`) must decode it.
- Add a fixture to `protocol/aiden-remote/v1/fixtures/contract.json`.
- **The Aiden Remote protocol revision bumps.** Claim the revision after main's current one (65, `aiden-remote-protocol.ts:373`) at merge, and update iOS, Android and the fixtures together.
- Privacy: memory text already crosses the wire through `GET /bots/{id}/memory`, so this adds no new class of data. It does put memory text into the transcript cache, which is an open question for the owner.
- The desktop transcript should show the same text for parity, which is a renderer change.

### 5. Implementation steps
1. After #925 merges, extract **`AidenBotIntroHeader`**, a new file `Features/Bots/AidenBotIntroHeader.swift`. It shows a sprite at about 64 pt bound to the session state, the name pill, a subtitle builder, and the timestamp. Insert it as the first row of `transcript` (:592). Keep the `.principal` toolbar item, but fade it in once the intro header scrolls off. Use a scroll-geometry check behind `aidenReduceMotion`.
2. Add the copy `AidenBotSessionCopy.introSubtitle(machine:remembers:)` and `composerPlaceholder(name:)` in `AidenBotSessionModel.swift` ≈:338. The default branch of `composerPlaceholder` (:1359) returns "Message {name}".
3. Extract **`AidenSuggestionCard`**, a new file `Features/Bots/AidenSuggestionCard.swift`. It has an icon in a soft-fill circle, a title, a subtitle, an optional body, primary and secondary actions, and resolved and read-only footers. Rebuild `AidenBotRoutineProposalCardView` (:1832) and `AidenBotLessonCardView` (`AidenBotSuggestionCards.swift:240`) on it, and later the settings-change and skill cards. Routine card copy: title = `card.name`, subtitle = `card.label`, primary "Turn on", secondary "Not now".
4. Extract **`AidenInlineActionRow`**, generalized from `AidenBotReceiptLine` (`AidenBotSuggestionCards.swift:317`). Use it for the memory receipt, the tidy line (switch to `AidenBotMemorySymbol.name`), the learned receipt, `AidenApprovalAnsweredLine` (`AidenTypedApprovalCard.swift:242`) and the answered routine line.
5. Restyle `AidenTypedApprovalCard` to the shared card surface. Keep its behavior.
6. Memory text (4.4): the host and protocol change, then iOS and Android decode, then `AidenBotMemoryUpdatedCaption` shows "Saved to memory: {text}" when the text is present.
7. Demo: add `routine_proposal` (pending) and `memory_update` entries to `AidenDemoBotUX.entries` (`Features/Remote/Demo/AidenDemoBotUX.swift:38`). Add a `text` field after step 6.
8. Tests (behavioral):
   - Extend `ios/AidenOnTheGoUITests/AidenBotUXUITests.swift`. Tap "Turn on" on the routine card and assert the answered line. Tap "Not now" on a second card and assert "Not added". Assert the intro header shows the Bot name and that the composer placeholder reads "Message Scout".
   - Unit test: `AidenBotSessionEntry` decodes `memory_update` with and without `text`, using the fixture from the contract file.
   - Host test: the projection test for `memory_update.text` sits next to the existing `aiden-remote-bot-session` tests.
   - Android: a decode test plus a Compose UI test for the receipt.
   - Register any new test file in `scripts/ci-test-registry.json` and `package.json`.

### 6. Effort, risk and dependencies
- **Effort:** M for the UI parts (steps 1-5 and 7-8). M for the memory text, which is cross-platform.
- **Risk:** low for the UI. Medium for the memory text, because it touches the host memory-tool data path and the transcript cache.
- **Dependencies:**
  - #925 (sprite).
  - T1B (composer, bubble style).
  - Shell (drawer versus back, tab bar).
  - Design tokens (soft-fill circle and card surface tokens).
  - Server (protocol revision for 4.4).
  - T2B (Memory screen is the tap target).

---

## Concept 6: Meet your Bot (live: New Bot form)

### 1. Screen and entry point
There are two entry points today:
- **(a) Bots tab + → New Bot.** This opens `AidenBotCreateView` (`Features/Bots/AidenBotCreateView.swift:552`). It is presented from the `AidenBotsHomeView` sheets at :387-442, and the toolbar Menu sits at :510ff.
- **(b) An empty Bots tab on a host with presets.** This shows `AidenBotMeetFirstBotView` (`Features/Bots/AidenBotPresetsView.swift:5`), branched from `content` at `AidenBotsHomeView.swift:604`.

Also relevant:
- Templates: `AidenBotTemplatesView` (`AidenBotPresetsView.swift:118`).
- The look editor: `AidenBotCharacterCard` (`Features/Bots/AidenBotCharacter.swift:49`). Profile uses it, which is T2B's scope.

### 2. What's live today

**`AidenBotCreateView`:**
- A NavigationStack form titled "New Bot", with Cancel and Create (:656-670).
- On revision 61 (`isOneField`, :617), it is **one field**: "Name your Bot", with the footer "It asks what you want help with in its first message." (:694-706).
- On older hosts it shows Name, "What should it help with?" and an AI model section (:708-726, :727-794).
- A machine picker `AidenNewWorkMachinePicker` (`Features/Shell/AidenNewWorkMachinePicker.swift:287`) appears when there are several Macs (:690-692).
- **There is no look picker.** Create always sends `AidenBotEditorDraft.defaultAvatar`, which is wisp/lilac (`AidenBotCreateView.swift:512,639`; `Features/Bots/AidenBotSettingsDraft.swift:227`; `AidenBotCharacter.swift:7`).
- `AidenBotCreateInput` (`AidenBotCreateView.swift:5-13`) has no avatar field.

**Data path:**
- `AidenBotCreateOperations` (:54) runs `resolve`/`resolveSeeded` (:487-527).
- That produces `AidenBotCreateRequest` (`Models/AidenBot.swift:623`): `name`, `purpose`, `instructions?`, **`avatar`**, `access?`.
- `createBot` (`Networking/AidenRemoteClient.swift:2310`) sends **`POST /bots`** (`main/services/aiden-remote-router.ts:603`).
- Creation is optimistic, with a durable outbox, `AidenBotPendingCreateRow` (:852) and "Creating on {machine}…" (:886).

**`AidenBotMeetFirstBotView`:**
- A Title Case "Meet Your First Bot" heading.
- A paged preset carousel. Each card has an 84 pt semantic avatar, name, subtitle, connection chips, a routine label and a version.
- Buttons "Start Chat" / "Open" and "Create My Own".
- It uses `POST /bots/from-preset` (`AidenRemoteClient.swift:3139`) and `GET /bot-presets` (:3134).
- `.memory/bots-rework-ui.md` notes this Title Case copy is stale against the desktop.

**Desktop reference:**
- `docs/plans/bot-ux-simplification.md:216` says: "New bot is one field: a large avatar preview, the input 'Name your Bot', a colour and shape picker with a random default … **There is no model picker, help field or connections step.**"
- The desktop has `BotLookPicker` (`.memory/bot-creation-and-settings.md:7,14`).
- The desktop also creates a silent first Bot "Chief" during onboarding (`bot-ux-simplification.md:210,435`).

**States:**
- The model catalog has loading and error states with Try Again (:770-775).
- Create is disabled while invalid or offline.
- A failure turns into a pending row with retry (`AidenBotCreateOperations.Failure`).

### 3. Concept delta

| # | Item | Concept | Live | Faithful version and notes |
|---|---|---|---|---|
| 6.1 | Container | A full-screen tinted gradient in the Bot's tint, ✕ close | Form sheet with Cancel / Create | Keep a sheet (`.presentationDetents([.large])`) with a soft tint wash made from the sprite's `light` tone, not a new color. ✕ is fine. Aurora and tokens: confirm the tint wash is a token (tint at low alpha over `palette.canvas`). |
| 6.2 | Hero | A large Hi-bit sprite with the thought bubble "What can I take off your plate?" | none | The sprite is **static idle** in pickers and onboarding (#925 plan :97). The thought bubble is decorative copy and acceptable. It echoes the real first message, which asks what to help with (`AidenBotCreateView.swift:705`). Reduce Motion: no bubble animation. |
| 6.3 | Title and body | "Meet Meal Planner" / "Bots are always-on helpers that run on your Mac. They remember what matters, follow routines, and **ask before they act**." | none | **"Ask before they act" contradicts the product.** New Bots default to Full Access (`AidenBotCreateRequest.access` omitted means Full Access, `Models/AidenBot.swift:630-631`), and the desktop's first-Bot card says it gets Full access (`bot-ux-simplification.md:435`). Faithful copy: "…They remember what matters, follow routines, and **check with you before anything risky**", but only if approvals mode makes that true. Otherwise say "…and work with Full Access. You can change that in Settings." Also, "Meet {name}" can only use a name once one exists, so the first page reads "Meet your Bot". |
| 6.4 | Look picker | A row of 5 tinted sprites, the selected one with a soft fill (no border) | none on create | Add a look picker to create, as on the desktop: a horizontal row of sprites over all 12 colors, plus shapes. Selection uses a soft fill and the radio trait, with **no decorative border** (AGENTS). Keep the focus ring. Use a random default, as the desktop does. **This is client-only: `POST /bots` already accepts `avatar`** (`AidenBotCreateRequest.avatar`). |
| 6.5 | Steps and page dots | Look → name → computer → connect, one card per step, page dots, Continue | one form | **"Connect what it needs" contradicts the shipped decision**: there is no connections step and nothing connects automatically (`bot-ux-simplification.md:216,220`). Connections happen in chat through `connect_card` and `POST /bots/{id}/connection-requests` (`AidenRemoteClient.swift:3028`). Faithful flow: **step 1** shows the hero, a one-line intro, and the look picker with Continue. **Step 2** shows "Name your Bot" (Return creates) and the computer picker only when more than one Mac (`picker.showsPicker`). Two dots at most. Create then opens the chat, where the Bot speaks first. |
| 6.6 | Templates | not drawn in 6 (they appear in 10) | carousel on empty, Templates sheet | Unify with concept 10's "Start from a template" list. Retire the "Meet Your First Bot" carousel in favor of the gallery's empty state plus templates. Fix the Title Case copy. |
| 6.7 | Older hosts (pre-61) | — | name + purpose + model | Keep the legacy form as-is when `!isOneField`. The hatch flow is gated on `installation?.hasNegotiatedAccess(to: .botTemplates)`. |
| 6.8 | Motion | implied page transitions | none | Use a horizontal step transition with the shared spring, or a crossfade under Reduce Motion. When the person picks a look, the hero sprite swaps instantly with no hop, because pickers stay static. |

### 4. Gap class

| Item | Class |
|---|---|
| 6.1 | UI-only (needs a tint-wash token from design tokens). |
| 6.2 | UI-only. |
| 6.3 | UI-only (copy). Product decision on wording. |
| 6.4 | **Client model/state.** Add `avatar: AidenBotAvatarRecipe?` to `AidenBotCreateInput`. It is persisted in the outbox (`AidenBotPendingCreate`, :17). `resolveSeeded` (:496) uses it in place of `defaultAvatar`, and `isSameAsk` (:528) must compare it so that a retry is still the same ask. No server change. |
| 6.5 | UI-only plus client state (a step enum). No server change. |
| 6.6 | UI-only. Cross-platform for consistency: Android `AidenBotPresetCarousel.kt` and `res/values/strings.xml:534-536` still say "Meet Your First Bot" / "Create My Own". |
| 6.7 | None. |
| 6.8 | UI-only. |

Android parity for 6.4 and 6.5: Android's create flow (`AidenBotEditorScreen.kt`, `AidenBotsViewModel.kt`) should get the same look picker and two steps. That is a cross-platform task, but it needs no wire change.

### 5. Implementation steps
1. **Model:**
   - Add `avatar: AidenBotAvatarRecipe?` to `AidenBotCreateInput` (`AidenBotCreateView.swift:5`), Codable and optional so outbox records already on disk still decode.
   - Thread it through `resolveSeeded` (:496-523) and `draft.createRequest` (set `draft.avatar`).
   - Include it in `isSameAsk` (:528).
   - Add a random default helper `AidenBotCharacter.randomRecipe()` (`AidenBotCharacter.swift:5`).
2. **Extract `AidenBotLookPicker`** from the swatch and shape grids in `AidenBotCharacterCard` (`AidenBotCharacter.swift:49ff`). Make it a horizontal scrolling row of static sprites, selected one with a soft fill, `.accessibilityAddTraits(.isSelected)`, and a focus ring. Profile (T2B) then reuses it.
3. **New `AidenBotHatchView`** (new file `Features/Bots/AidenBotHatchView.swift`). Two pages driven by `enum Step { look, name }`. Page 1: hero sprite, thought bubble, "Meet your Bot", intro copy, `AidenBotLookPicker`, Continue. Page 2: hero, "Name your Bot" field (Return submits), `AidenNewWorkMachinePicker` when `showsPicker`, Create. It calls the existing `onCreate(input, target)`.
4. In `AidenBotCreateView.body` (:653), route to `AidenBotHatchView` when `isOneField`. Keep the `form` (:688) for older hosts.
5. Retire `AidenBotMeetFirstBotView` from the empty home (`AidenBotsHomeView.swift:604`). The empty state becomes the gallery empty state from concept 10 (New Bot tile plus templates).
6. **Demo:** the `empty` scenario already serves an empty `/bots` (`AidenDemoHosts.swift:737`). Make sure `/bot-presets` and `POST /bots` respond in demo so that create completes (check the demo responder routes for `POST /bots`).
7. **Tests:**
   - XCUITest in `AidenBotUXUITests.swift`. Open New Bot, pick the third look, Continue, type a name, press Return. Assert that the Bot's chat opens with that name, and that the home row's avatar has the picked look (via an accessibility value such as "{shape} {color}" on `AidenBotCanonicalAvatarView`).
   - Unit tests:
     - An `AidenBotCreateInput` with an avatar round-trips through `AidenBotPendingCreate` encode and decode.
     - An older outbox record with no avatar still decodes and uses the default.
     - `resolve` puts the picked avatar in the request body.
     - Two inputs that differ only by avatar are not `isSameAsk`.
   - Android: matching unit and Compose tests if 6.4 and 6.5 ship there.

### 6. Effort, risk and dependencies
- **Effort:** M.
- **Risk:** low to medium. The outbox Codable change must stay backward-compatible.
- **Dependencies:**
  - #925.
  - Design tokens (tint wash).
  - T2B (shared `AidenBotLookPicker` with Profile).
  - Shell (sheet versus full-screen presentation).
  - Onboarding rules: phones don't run desktop onboarding, so nothing changes in `onboarding-feature-gallery.tsx`.

---

## Concept 10: Bots gallery

### 1. Screen and entry point
- **Entry:** the Bots tab.
- **Views:**
  - `AidenBotsHomeView` (`Features/Bots/AidenBotsHomeView.swift:254`).
  - `home` (:510): navigationTitle "Bots", `.searchable("Search Bots")`, and a toolbar + Menu with New Bot / Templates.
  - `content` (:604).
  - `botRow` (:741).
  - `messagingControl` (:572).
  - `machinesContent` (:683).
- Row model: `AidenBotHomeRow` (:152-184), sorted by `aidenBotHomeRows` (:185).

### 2. What's live today
- **Layout:** a large title, the "Bots can message each other" toggle (:572), then a list. Each row (`AidenListRowLayout`, `Features/Remote/AidenInboxViews.swift:145`) has an avatar with a working dot, the name, a preview and `AidenRelativeTimestampView`. Several Macs give per-machine sections (:683, `AidenMachineSection` at `Models/AidenUnifiedInbox.swift:336`).
- **Row text** (`AidenBotHomeRow.preview`, :161-171): interrupted, paused or needs-model copy, otherwise `conversation.preview`, otherwise "Say hello". `isWorking` (:173-178) comes from `sessionState == .running` or `conversation.activityState != .idle`.
- **Data:**
  - `bots()` (`Networking/AidenRemoteClient.swift:2300`) → **`GET /bots`** → `AidenBotList{bots, maxBots, messaging}`.
  - `AidenBotSummary` (`Models/AidenBot.swift:323`) has `id`, `name`, `purpose`, `avatar`, `health`, `createdAt`, `updatedAt`, `revision`, `sessionState`, `paused` and `issueCount`.
  - Conversations come from `AidenBotConversationItem` (`Models/AidenBot.swift:763`), with `preview`, `activityState` (idle, queued, running, waiting_for_approval or reconciling, :757-761) and `canRespondToApproval`.
- **States:**
  - Loading → `AidenBotHomeSkeletonView` (:231).
  - Empty with presets → `AidenBotMeetFirstBotView`.
  - Empty without presets → `ContentUnavailableView` "Make your first Bot".
  - Search, context menu (:794), pending creates.

### 3. Concept delta

| # | Item | Concept | Live | Faithful version and notes |
|---|---|---|---|---|
| 10.1 | Layout | Two-column grid of tinted tiles | List rows | A `LazyVGrid` with two flexible columns on compact width (three or four on iPad or regular width; the old plan forbade a *fixed* four-column phone grid, `bot-first-aiden-on-the-go-plan.md:233`). Tile background: the Bot's sprite `light` tone as a soft fill, with no border. Keep search and the context menu on tiles. |
| 10.2 | Header | "Bots" plus "3 Bots running on Studio Mac", drawer and + | Large title, + Menu, search | The subtitle is computed on the client: count of `bots`, plus the machine name from `installation`. With several Macs, use "on 2 Macs" or per-machine sections (keep `machinesContent`). "running" is misleading for idle Bots, so say "3 Bots on Studio Mac". |
| 10.3 | Status chip "Working" | Spinner chip | Working dot on the avatar | Map `isWorking` to a "Working" chip with a soft fill. The sprite also animates its working pose on home rows (#925 plan :96). Reduce Motion: a static chip. |
| 10.4 | Status chip "Waiting on you" | (design notes) | `needsYou` via `canRespondToApproval` / `waiting_for_approval`, `issueCount` | A "Needs you" chip in a soft warning fill. All the data already exists. |
| 10.5 | Status chip "Done" (green) | Done chip | none | **This contradicts #925 plan :89**: phones can't tell a normal end from Stop or failure, so home rows never show done. Faithful version: no Done chip until the wire carries a turn-end signal. Optionally, add `lastTurnEnd: {at, outcome: done, stopped or failed}` to the `GET /bots` summary. Desktop sidebar rows use `lastTurnEnd` in #925. Then show "Done" for about 1 h after a normal end. |
| 10.6 | Tile summary "Planned 5 dinners for next week" | Two-line outcome | `conversation.preview` (last message) | `preview` already gives the last message text, so use two lines of it. A true outcome summary would be a new field (`lastResultSummary`) on the summary, generated by the host. Recommend **preview only** (no new LLM work). |
| 10.7 | "New Bot" tile | Gray tile, +, "Describe what it should do" | + menu | A tile at the end of the grid that opens the hatch flow (concept 6). **Copy fix:** New Bot is one field, a name, and the Bot then asks (`AidenBotCreateView.swift:705`), so "Describe what it should do" misdescribes it. Use "Name it, then tell it what you need". |
| 10.8 | "Start from a template" | Grouped list: "Daily brief…", "Inbox triage…" | Templates sheet and empty carousel | Show it inline below the grid when presets exist and the host has `bot:templates` (`AidenBotHostFeature.presets`, `AidenBotSessionModel.swift:10`). **Use the real presets** (`renderer/shared/bot-presets.ts`): Chief of Staff "Keeps your week on track", Meal Planner "Plans meals and shopping lists", Inbox Helper "Sorts email and drafts replies", Researcher "Digs into topics and sums them up". Do not invent "Daily brief" or "Inbox triage". Tapping one opens `AidenBotTemplatesView` detail or `POST /bots/from-preset`. A template whose Bot exists shows Open. Hide the section once every template has been used, or collapse it after the first Bot (open question). |
| 10.9 | Messaging toggle | absent | top of list | Move it to the ••• menu or the bottom of the gallery. It is a setting, not content (open question). |
| 10.10 | Timestamps | absent on tiles | trailing relative time | Drop them from tiles, or show them only under accessibility sizes (they stay in VoiceOver labels). |
| 10.11 | Pending create | — | `AidenBotPendingCreateRow` | A pending tile: skeleton tint, static sprite, "Creating on {machine}…". |
| 10.12 | Accessibility | — | rows | Each tile is one button with a combined label "{name}, {status}, {preview}" and a focus ring. With Dynamic Type at AX sizes, drop to one column. |

### 4. Gap class

| Item | Class |
|---|---|
| 10.1, 10.2, 10.3, 10.4, 10.7, 10.9, 10.10, 10.11, 10.12 | UI-only. |
| 10.5 | **Server contract.** The route is `GET /bots`. Add `lastTurnEnd` to the Bot summary in `main/services/aiden-remote-protocol.ts` (Bot summary parser ≈:3389-3420) and to the router projection. **The protocol revision bumps, together with iOS (`AidenBotSummary`), Android and the fixtures.** Desktop already derives `lastTurnEnd` in #925. Optional, and deferred by default. |
| 10.6 | UI-only with preview. A server contract if an outcome summary is wanted (not recommended). |
| 10.8 | UI-only. Cross-platform copy consistency with Android `AidenBotPresetCarousel.kt`. |

### 5. Implementation steps
1. Extract **`AidenBotTile`** (new file `Features/Bots/AidenBotTile.swift`). It takes an `AidenBotHomeRow` and shows a tint-fill background, the sprite (animated working and waiting poses per #925), an `AidenStatusChip`, the name, and two lines of preview. Add `var status: AidenBotTileStatus` (working, needsYou, paused, interrupted, needsModel, or none) to `AidenBotHomeRow` (:152) as a pure derived property.
2. Extract **`AidenStatusChip`**, shared with Inbox, Workspaces and Scheduled. It has a soft semantic fill, a label, an optional small spinner or symbol, and no border.
3. Replace the list in `content` (:604) with `LazyVGrid`, adaptive to columns by size class and Dynamic Type. Keep `botContextMenu` (:794), search filtering (`aidenBotHomeRows` :185) and `machinesContent` (:683) as grid sections.
4. Add a header subtitle view under the large title: a computed `count` and machine string.
5. Add **`AidenNewBotTile`** and an inline **`AidenTemplateList`** section built from `presets` (already loaded by `loadPresets`, :951). Reuse the actions from `AidenBotTemplatesView` (`AidenBotPresetsView.swift:146-176`).
6. Make the empty state the same grid: just the New Bot tile plus templates. Delete the `AidenBotMeetFirstBotView` branch.
7. Move `messagingControl` (:572) to the + / ••• menu as a toggle, pending the owner's answer.
8. **Demo and state matrix:**
   - `AidenDemoContent.botListJSON()` (`AidenDemoHosts.swift:721`) should include at least one running Bot, one waiting on approval, one paused and one idle, so all chips can be screenshotted.
   - The `four` and `busy` scenarios in `ios/AidenOnTheGoUITests/AidenStateMatrix.swift:13` cover counts.
   - Add a capture of the Bots tab in `empty` (templates and New Bot tile) and in `busy` at `accessibilityExtraExtraExtraLarge` (one column).
9. **Tests:**
   - Unit: `AidenBotHomeRow.status` precedence. Needs-you beats working, and paused or interrupted beat both. Use fixture summaries and conversations. The current `preview` precedence tests stay.
   - XCUITest:
     - In `busy`, the tile labeled "Scout" exposes the "Working" status in its accessibility label. Tapping it opens the chat.
     - In `empty`, tapping "Meal Planner" under "Start from a template" creates the Bot and opens its chat. A second visit shows "Open".
     - At AX XXXL the grid is one column (tile frames share an x).
   - Android: a Compose test for the matching home grid if it ships there.

### 6. Effort, risk and dependencies
- **Effort:** M without 10.5. M+ with 10.5, which crosses platforms.
- **Risk:** low to medium. Search, context menus, multi-machine sections and pending creates must survive the switch from a list to a grid.
- **Dependencies:**
  - #925.
  - Design tokens (tint fill, status-chip fills).
  - Shell (drawer, header, tab bar).
  - T1A (Inbox may reuse `AidenStatusChip`).
  - Server (optional `lastTurnEnd`).
  - Aurora (check tile tints against the Aurora backdrop for contrast).

---

## Shared components to extract
1. **`AidenBotIntroHeader`**: large sprite, name pill, subtitle and timestamp. Used by Bot chat. Could be reused by the Profile hero (T2B).
2. **`AidenSuggestionCard`**: icon in a soft-fill circle, title, subtitle, optional body, primary and secondary actions, answered and read-only footers. Used by the routine, lesson, settings-change, skill and issue cards.
3. **`AidenInlineActionRow`**: generalizes `AidenBotReceiptLine` with an icon, one-line text, a trailing action and a 44 pt minimum. Used by memory receipts, the tidy line, learned receipts, answered approval and routine lines, and access and connect rows.
4. **`AidenBotLookPicker`**: a static sprite row over color and shape, with a soft-fill selection, no border and a focus ring. Used by hatch (6) and Profile (T2B).
5. **`AidenBotTile`** and **`AidenNewBotTile`**: the gallery tiles.
6. **`AidenStatusChip`**: soft semantic fill, label, optional spinner or symbol, no border. Shared app-wide (Inbox, Workspaces, Scheduled).
7. **`AidenTemplateList`**: inline preset rows, reusing the `AidenBotTemplatesView` actions.
8. A **tint-wash token**: sprite `light` tone at low alpha over `palette.canvas`. It belongs in `Config/AidenAppearance.swift`, next to `aidenSolidFillTint` (:502), and goes to the design-tokens track.

## Suggested phase order
0. **Merge #925 (Hi-bit sprite).** It blocks every concept surface here.
1. **Shared primitives** (`AidenStatusChip`, `AidenSuggestionCard`, `AidenInlineActionRow`, tint-wash token). Also do the memorychip → sdcard fix (4.5), the "Message {name}" placeholder (4.9) and the Title Case copy fixes on iOS and Android.
2. **Bot chat UI** (4.1, 4.3, 4.6-4.8, 4.11), plus `routine_proposal` and `memory_update` demo entries and XCUITests.
3. **Bots gallery** (10.1-10.4, 10.7-10.12), plus demo list variety and AidenStateMatrix captures.
4. **Meet your Bot hatch** (6.1-6.8): look picker on create, two steps, retire the first-Bot carousel. It depends on phase 3's empty state, and it shares `AidenBotLookPicker` with T2B.
5. **Server contract batch** (one protocol revision, iOS, Android and fixtures together): `memory_update.text` (4.4), and `lastTurnEnd` on the Bot summary (10.5) if the owner wants a Done chip.
6. Android parity for 6 and 10 (look picker on create, gallery grid), if the owner wants both phones to match.

## Open questions for the owner
1. **Done chip (10.5):** the #925 plan says phone home rows never show done. Do you want a protocol bump (`lastTurnEnd` on `GET /bots`) so tiles can show "Done", or should tiles show only Working and Needs you?
2. **Saved-to-memory text (4.4):** may the transcript carry a short copy of what was saved (it is cached on the phone), or should the receipt stay "Saved to memory" and open Memory on tap?
3. **Meet your Bot copy (6.3):** new Bots default to Full Access, so "ask before they act" is untrue. Should the intro say "work with Full Access", or should the hatch include an access choice?
4. **Connect step (6.5):** the shipped decision is no connections step at create. Confirm the hatch stays look → name (→ computer), with connections coming later as cards in the chat.
5. **Assistant bubbles (4.2):** the concept fills assistant replies in gray. Should Bot chats differ from main chats, or should both switch (T1B's decision)?
6. **Header (4.1):** should the large intro header stay pinned, or scroll away so a compact nav title takes over? Also, is it a drawer button or a back chevron (shell track)?
7. **Templates section (10.8):** should it always show under the grid, or only while there are fewer than N Bots or until each template is used? Is the "Bots can message each other" toggle OK to move into a menu (10.9)?
8. **Routine label time zone (4.3):** should " · Zone" be dropped when it matches the phone's zone?
9. **Android:** should Android get the hatch and grid in the same release, or should iOS lead?
