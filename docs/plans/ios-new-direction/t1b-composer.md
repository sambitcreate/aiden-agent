# Track 1B (t1b-composer): composer, New chat, Agent Slider, Live voice

Repo read: `ios-new-direction` worktree at `d476bc35d` (== origin/main). All paths are relative to the repo root. `ios/AidenOnTheGo/` is shortened to `iOS/`.

Headline findings:

1. **Phones have no Agent Slider at all.**
   - There are zero `agentSlider` references in `ios/` or `android/`.
   - `GET /models` does not project the slider.
   - The plan's PR 5 (phones) was never built. `docs/plans/README.md:91` and `docs/plans/agent-slider-plan.md:3` say "the owner is building the phone slider by hand".
   - The idea sheet's claim "phones read agentSlider from GET /models" is false today.
2. **Both native decoders tolerate unknown keys.**
   - iOS validates against `AidenUnknownJSONValue` and then decodes synthesized Codable (`iOS/Networking/AidenRemoteContract.swift:3407-3424`).
   - Android sets `ignoreUnknownKeys = true` (`android/.../networking/AidenRemoteClient.kt:109,129`).
   - So adding `agentSlider` to `/models` is additive: older apps ignore it. This contradicts `agent-slider-plan.md:137` ("mobile decoders are strict"). Still claim a revision, because the phone needs to know the host persists the level.
3. **Phone model choices never reach the host's chat record.**
   - Effort (`thinkingLevel`) is per turn only (`main/services/aiden-remote-chats.ts:1271-1303`).
   - The phone's pick lives only in device-local UserDefaults (`iOS/Persistence/AidenModelPreferenceStore.swift`).
   - The chat projection has no `thinkingLevel` (`aiden-remote-chats.ts:723-735`).
   - Result: a phone cannot show the active stop of a chat whose level was set on the desktop.
4. **Aiden Live voice is desktop-only by design.**
   - The main process owns the Google credential and streams the microphone straight to Gemini (`docs/plans/gemini-live-assistant-plan.md:170-186`).
   - There is no phone or remote route.
   - What phones have:
     - composer dictation: on-device `SFSpeechRecognizer`, or the Mac's model via `POST /speech/transcriptions`;
     - Read Aloud: `/chats/:id/read-aloud*`.
   - Concept 9 can be delivered faithfully as a turn-based **voice mode** on existing routes. A true full-duplex Live session on the phone is an XL server project.
5. **The desktop composer already does what the concept shows.**
   - An empty draft's last button starts Live; typing turns it into Send (`.memory/aiden-live-send-button.md`).
   - The concept's "dark voice button" is therefore faithful to the product. It just needs a phone-side voice mode behind it.

---

## A. Composer contract (Home, Inbox, chat, Bot chat). I own it; t1a embeds it.

### 1. Entry points and views

**Shared surface:** `AidenComposerSurface`.

| Part | Location |
|---|---|
| Struct | `iOS/Features/Conversation/AidenComposerSurface.swift:99` |
| Config | `:6-34` |
| Controls | `:37-48` |
| Layout | `:50-83` |
| Trailing actions (mic, then Send or Stop) | `:279-336` |
| Send button | `:339` |
| Stop button | `:359` |
| Attach (+) button | `:383-427` |
| Listening bar | `:431` |
| Waveform | `:465` |
| Glass | `:491-524` |
| Field reach (UIKit focus workaround) | `:602-678` |

**Where it is used:**

- **Workspace chat:** `AidenComposerView`, `iOS/Features/Chat/AidenChatComposer.swift:27-349`. It is instantiated at `iOS/Features/Chat/AidenChatDetailView.swift:983`, and the chat dock at `iOS/Features/Conversation/AidenChatDock.swift:255`.
- **Bot chat:** `AidenComposerConfig.bot()` with the Bot's placeholder (`iOS/Features/Bots/AidenBotSessionChatView.swift:1031-1035`), on the surface at `:1326`.
- **Session state:** `AidenComposerSession` (`iOS/Features/Conversation/AidenComposerSession.swift:100-192`) holds text, attachments, keyboard requests, and voice (`toggleVoice` at `:166`).
- **Dictation engine:** `ComposerVoiceInputController` (`iOS/Features/Chat/ComposerVoiceInputController.swift:11`).
  - On-device `SFSpeechRecognizer` (`:23-44`, `:257-299`).
  - Or Mac transcription: PCM goes to `aidenTranscribeSpeech` (`AidenComposerSession.swift:34-62`), then to `POST /speech/transcriptions` (`iOS/Networking/AidenRemoteClient.swift:3460-3472`).
- **Voice-start deep entry:** `AidenAppNavigation.open(_:startsVoice:)` (`iOS/Features/Shell/AidenAppNavigation.swift:519-531`), used by shortcuts and widgets. It reaches the composer as `autoStartVoice` (`AidenAppShellView.swift:594`).

### 2. What's live today

**Workspace chat composer:**

- **Layout.** It is stacked whenever the model chip shows (`AidenComposerSurface.swift:150`): field on top, then a control row with +, the model chip, mic and Send.
- **Model chip.** A SwiftUI `Menu` grouped by provider, with a nested Menu of effort levels (`AidenChatComposer.swift:197-274`, label at `:358-432`).
- **Placeholder.** "Message Aiden".
- **Send.** Always present, disabled while the field is empty (`AidenComposerSurface.swift:296-303`).
- **Mic.** Shown only when `offersMic` (`:285-291`). While streaming it is replaced by the Steer/Queue pill (`AidenChatComposer.swift:85-98`, `:436-483`).

**Bot composer:**

- A single row: +, field ("Message <Bot>"), mic, Send. There is no chip, because the model is set on the Bot.
- Live shot 04 shows "Message", mic and send with "Connecting…" above.

**+ menu.** `AidenAttachmentPickerOverlay` offers Files, Camera and Photos tiles plus a recent-photo grid (`iOS/Features/Chat/AidenAttachmentPicker.swift:570-700`). The + rotates 45° while the picker is open.

**Home and Inbox.** Neither has a composer. Live shot 01 is the Inbox: a machine pill, •••, and a compose button that opens the New chat popover (section B).

**States today:**

- **Recording:** waveform in the mic slot. When the dock hides the composer, the listening bar takes its place (`AidenChatDock.swift:268-276`).
- **Voice busy:** field disabled (`AidenComposerSurface.swift:271`).
- **Upload progress and attachment cards:** accessory slot.
- **Notices:** `AidenDockNoticeRow`.

### 3. Concept delta (concepts 01 Home and 04 Bot chat)

| # | Concept | Today | Faithful proposal |
|---|---|---|---|
| A1 | One glass capsule: `+` · "Ask anything or hold to talk" · mic · **dark circular voice button** (waveform glyph). No Send visible. | Send is always visible. There is no voice-mode button. | **Primary-button swap**, matching the desktop (`.memory/aiden-live-send-button.md`): an empty draft shows the Voice button (filled, `waveform` glyph); any text, attachment or skill turns it into Send. Port the desktop's settle delay: Send turns into Voice only after the field has been empty for 400 ms, and presses within 350 ms of the swap are ignored. Return never starts voice. |
| A2 | Placeholder "Ask anything or hold to talk" (Home). | "Message Aiden" / "Message <Bot>". | Use the concept copy only on the Home composer, where the hold gesture exists. Keep "Message <Bot>" in Bot chats, as concept 04 does ("Message Meal Planner"). |
| A3 | "Hold to talk". | The mic is tap-to-toggle only. | Add press-and-hold on the **mic**: hold starts dictation, release stops it and keeps the words in the field. Keep tap-to-toggle, because a hold-only control fails VoiceOver and Switch Control. Make the accessibility action the tap. Open question: does release auto-send? |
| A4 | In-chat composer is single-row in the concept, with no model chip in the row. | Stacked with a model chip. | The chip becomes the **Agent Slider chip**: a stop glyph plus the stop label ("Balanced"). See section C. Keep the stacked layout while a chip shows, and at accessibility sizes. The concept's single row is the Bot and Home variant. |
| A5 | Home has a composer. | None. | t1a places it. The contract is: the first send creates a **Just chat** (no-workspace) chat on the selected machine, then sends the turn (section B flow). When the host lacks the Chats home (revision 51, `docs/aiden-remote-api-v1.md:1090`), the send opens the New chat sheet instead. |
| A6 | Concept Inbox has no composer. | No composer. | No change. Inbox keeps its compose button. |

AGENTS.md checks:

- The text field must not gain a focus border or ring, which the glass already satisfies.
- The Voice button keeps the shared solid squircle/circle treatment (`AidenSolidFillButtonStyle`), with no new geometry.
- Before restyling, review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`.

### 4. Gap class

| Item | Gap class |
|---|---|
| A1 swap and settle | UI-only |
| A2 copy | UI-only |
| A3 hold gesture | UI-only, plus client state in `AidenComposerSession` (a hold-start/hold-end API on `AidenComposerVoiceCapture`) |
| A4 chip | Depends on section C: server contract |
| A5 Home send | Client model/state. It reuses `POST /chats` with `noWorkspace` (`iOS/Networking/AidenRemoteClient.swift:1907-1925`) and `POST /chats/{id}/turns`. |
| Android parity for A1–A3 | Cross-platform. Android has its own `features/chat/AidenComposerView.kt` (984 lines) and `ComposerVoiceInputController.kt`. |

### 5. Implementation steps

1. Extend `AidenComposerConfig` (`AidenComposerSurface.swift:6`):
   - `primaryWhenEmpty: Primary` (`.send` | `.voiceMode`)
   - `holdToTalk: Bool`
   - an optional `leadingSummary` slot for the slider chip on the single-row variant
   - a static `.home()` preset (placeholder "Ask anything or hold to talk", `holdToTalk: true`, `primaryWhenEmpty: .voiceMode`)

   Keep `.chat(model:)` and `.bot()`, adding voice mode to them behind capability checks.
2. Add `AidenComposerVoiceModeButton` next to `AidenComposerSendButton` (`:339`), plus a pure `AidenComposerPrimaryAction.resolve(hasContent:isRunning:isRecording:emptySince:now:)` that returns `.send`, `.voice` or `.stop`. A unit test drives it with injected time, so the settle rule is testable without UI.
3. Add the hold gesture on `micButton` (`:307-330`): `LongPressGesture(minimumDuration: 0.25)` followed by a drag-end. This calls new `AidenComposerSession.beginHoldToTalk()` and `endHoldToTalk()`, which wrap the existing `toggleVoice` and `stopVoice` with a fence so a tap during a hold is ignored.
4. Add `onVoiceMode: (() -> Void)?` to the surface's init (next to `onToggleVoice`). Chat, Bot and Home hosts pass the voice-mode presenter (section E).
5. Home host (t1a): build the surface with `.home()`. On send, call a new `AidenNewWorkChatFlow.startJustChat(text:attachments:)` (section B), which composes `createChat(in: home)` and then the turn.
6. **Demo data.** The `AidenDemoHosts` busy scenario already has chats. Add a Home composer capture to `AidenStateMatrix` (`ios/AidenOnTheGoUITests/AidenStateMatrix.swift`) for the empty state (Voice button) and the typed state (Send).
7. **Tests.** All behavioral.
   - Extend `ios/AidenOnTheGoTests/AidenComposerSurfaceTests.swift` with the primary-action resolver:
     - an empty field shows Voice only after the settle delay;
     - an attachment alone shows Send;
     - a running turn shows Stop.
   - Add hold-to-talk session tests with a fake `AidenComposerVoiceCapture`:
     - hold, then release, keeps the text and does not send;
     - a tap during a hold is ignored.
   - XCUITest in `AidenShellUITests`: type into the Home composer, Send, and the chat opens with the message.

### 6. Effort and risk

- **Effort:** M.
- **Risk:** keyboard and focus regressions in the `safeAreaBar`, because `AidenComposerFieldReach` is fragile (`:602-678`). Keep one branch for every state, as the dock comment demands (`AidenChatDock.swift:233-235`).
- **Dependencies:** t1a owns where the Home and Inbox composer sits. The chip depends on section C and the Voice button on section E. Until E lands, `primaryWhenEmpty` stays `.send`.

---

## B. Concept 13: New chat

### 1. Entry points and views

- **Compose button:** `AidenNewWorkComposeButton` (`iOS/Features/Shell/AidenNewWorkChatFlow.swift:281-315`). It is a `.popover`, 320 pt wide, `presentationCompactAdaptation(.popover)`.
- **Popover:** `AidenNewAgentPopover` (`iOS/Features/Workspace/AidenNewAgentPopover.swift:44-132`). The choices enum is at `:3-42`. No Workspace appears only when the Mac lists a Chats home (`:11-14`).
- **Flow:** `AidenNewWorkChatFlow.select` (`AidenNewWorkChatFlow.swift:163-178`):
  - No Workspace calls `create(in: home)`.
  - Existing Workspace opens the "Choose workspace" sheet (`:338-356`).
  - New Workspace opens the name alert (`:357-367`).
  - Scratch calls `create(workspace: .scratch)` (`:175-176`).
- **Machine picker:** `AidenNewWorkMachinePicker` (`iOS/Features/Shell/AidenNewWorkMachinePicker.swift`), embedded in the popover header (`AidenNewAgentPopover.swift:70-74`).

### 2. What's live today

- **Layout.** Title "New Chat", subtitle "Choose where this chat runs.", then four navigation rows with tinted circle icons, subtitles and chevrons. "Managed Scratch Wo…" truncates (live shot 13).
- **Data:**
  - `POST /chats` with `{workspaceId, providerId?, modelId?, noWorkspace?}` (`iOS/Networking/AidenRemoteClient.swift:1907-1925`). The host parser is `parseCreate` (`main/services/aiden-remote-chats.ts:1056-1075`), with no `thinkingLevel`.
  - `POST /workspaces` (`AidenRemoteClient.swift:1698`).
  - The default permission is applied afterwards with `PATCH /workspaces/{id}` and `If-Match` (`AidenNewWorkChatFlow.swift:65-78`). It reads the phone-local `AidenWorkspaceDefaultApplication.permissionKey` (Settings → "New workspace permission").
- **States:**
  - **Loading:** a glass capsule "Opening chat…", "Creating workspace…" or "Preparing scratch workspace…" (`:323-337`).
  - **Disabled:** when `!canStart`, or Existing Workspace with no workspaces, the row dims to 0.45 with the detail "Add a workspace before using this option." (`AidenNewAgentPopover.swift:110-111,126-131`).
  - **Errors:** shown through `coordinator.presentedError` (`AidenNewWorkChatFlow.swift:13-22,241-250`).

### 3. Concept delta

| # | Concept | Today | Proposal |
|---|---|---|---|
| B1 | A **bottom sheet**: "New chat", radio-style list, "Start chat" CTA. | A popover of navigation rows that commits on tap. | A `.sheet` with detents `[.medium, .large]`, a radio list and a primary **Start chat** button. Two steps lets the stop and permission be set before anything is created. |
| B2 | Rows: **Just chat** (speech bubble, checkmark), **aiden-agent** (folder, an existing workspace inline), **+ New folder**, **Scratch** (stack icon). | No Workspace / Existing Workspace (opens a sub-sheet) / New Workspace / Managed Scratch Workspace (hammer). | Copy: "Just chat" (`bubble.left.and.bubble.right`); recent workspaces inline, 3 most recent by `updatedAt`, plus "All workspaces…" opening today's chooser; "New workspace" (not "New folder"); "Scratch" (`square.stack`). |
| B3 | Footer chips "•••●• Balanced" and "🛡 Ask first". | No model or permission choice at creation. | **Stop chip** opens the slider sheet (section C) and stores a pending selection. **Permission chip** is a Menu (Ask first / Full / Chat only) that maps to `AidenWorkspacePermission` `.ask`, `.full`, `.none` (`AidenRemoteClient.swift:547-551`). |
| B4 | No machine picker shown. | A machine picker sits in the header. | Keep it, as a compact "on Studio Mac ⌄" line under the title when more than one machine can take work. Multi-machine is a real product state the concept omits. |
| B5 | Selection shown with a checkmark. | — | AGENTS.md: no decorative borders on radio cards. Use a trailing checkmark plus the existing selected-background token, and keep `focus-visible`. |

Why "New workspace" and not "New folder":

- The live row creates `AidenWorkspaceCreate.folderless(name:)` (`AidenNewWorkChatFlow.swift:188-191`), so "New folder" would describe something that does not happen.
- If the owner wants a real folder, a picker-backed `createWorkspaceSelection(location:)` already exists (`AidenRemoteClient.swift:1820`). That is a separate decision.

The permission chip on each target:

- **New workspace or Scratch:** replaces the phone default for this creation only. This is client state passed into `applyDefaultPermission`.
- **Existing workspace:** shows `workspace.permission`. Changing it calls the existing `PATCH /workspaces/{id}`.
- **Just chat:** shows the Chats-home workspace's permission. Open question: is that per-chat, or should it be read-only?

The stop chip at creation:

- `POST /chats` already takes `providerId` and `modelId`.
- The level can ride the first turn, which already accepts `thinkingLevel` (`aiden-remote-chats.ts:1271-1303`). Remember it via `AidenModelPreferenceStore.rememberChat` (the path in `AidenChatViewModel.rememberExplicitModelSelection`, `iOS/Features/Chat/AidenChatViewModel.swift:1703-1720`).
- So no server change is needed for B. Durable cross-device persistence comes with section C.

### 4. Gap class

| Item | Gap class |
|---|---|
| B1, B2, B4, B5 | UI-only |
| B3 permission chip | Client state, existing routes |
| B3 stop chip | Client state now. Section C supplies the stops. |
| Android parity | Cross-platform (Android's new-chat chooser). |

### 5. Implementation steps

1. Replace `AidenNewAgentPopover` with `AidenNewChatSheet` in `iOS/Features/Workspace/`. Keep `AidenNewAgentChoice` but change it to `.justChat`, `.workspace(AidenWorkspace)`, `.newWorkspace` and `.scratch`, with the new titles and symbols. Keep the `available(noWorkspace:)` gating.
2. In `AidenNewWorkChatFlow`:
   - Add `pendingChoice`, `pendingPermission` and `pendingSelection: AidenChatModelSelection?` (`iOS/Features/Chat/AidenChatPolicies.swift:302`).
   - Add `start()`, which runs today's `select` and `create` paths.
   - Thread `pendingPermission` into `applyDefaultPermission` (`:65`).
   - After `createChat`, call `modelPreferenceStore.rememberChat(pendingSelection, …)`.
   - Add `startJustChat(text:)` for the Home composer (section A5).
3. Change `AidenNewWorkComposeButton` (`:281`) to present a `.sheet`.
4. **Shared components:**
   - `AidenRadioListRow`: icon, title, optional subtitle, trailing checkmark, selected-background token.
   - `AidenSummaryChip`: glyph and label used by the stop and permission chips.
   - `AidenAgentSliderStopGlyph` (dots), shared with sections C and D.
5. **Demo:** `AidenDemoHosts.workspacesJSON` already has "Aiden Agent", "Notes" and the `noWorkspace` home. Add a matrix capture of the sheet with the busy scenario, plus `old-host` (no Chats home, so no "Just chat").
6. **Tests:**
   - Unit, in a new `AidenNewChatSheetModelTests`, against a fake coordinator:
     - Start with Just chat creates in the home with `noWorkspace: true`;
     - a permission override reaches the PATCH;
     - Start is disabled while `!canStart`.
   - Extend `AidenNewWorkTargetTests` for the recent-workspaces ordering.
   - XCUITest: compose → pick "Notes" → Start chat → chat detail opens.

### 6. Effort and risk

- **Effort:** M.
- **Risk:** the popover → sheet change loses the "tap = go" speed. Mitigation: double-tap a row to start; keep Start as the default action.
- **Dependencies:** t1a for the Inbox compose placement; section C for real stop labels. Until then, the chip shows the model name.

---

## C. Concept 5 + idea-agent-slider: Agent Slider in chat (live closest: 05-model-picker)

### 1. Entry points and views

- **Today's chip:** the `Menu` in `AidenChatComposer.swift:197-274`. Selection goes to `AidenChatViewModel.selectModel(providerId:modelId:thinkingLevel:)` (`AidenChatViewModel.swift:1741-1749`).
  - In a new chat it is remembered device-locally (`:1703-1720`).
  - It is sent per turn via `AidenTurnRequestBuilder` (`:1796-1803`).
  - It is resolved via `AidenChatModelAuthority.resolvedSelection` (`:2924-2950`).
- **Catalog:** `AidenModelCatalog {providers, defaults}` (`iOS/Models/AidenChat.swift:3073`) from `GET /models` (`AidenRemoteClient.swift:2290`).
- **Host side:**
  - Router: `models: ["/models"]` (`main/services/aiden-remote-router.ts:699`), handled at `:4559-4566` with scope `chat:read`.
  - Projection: `AidenRemoteModelsProjection {providers, defaults}` (`main/services/aiden-remote-models.ts:44-47`, `list()` at `:61`). No `agentSlider`.
- **Desktop source of truth:**
  - Types and helpers: `renderer/shared/agent-slider.ts` (stop types `:19-30`, `normalizeAgentSlider :137`, `resolveAgentSliderStop :255`, `activeStopIndex :285`, `seedAgentSlider :316`).
  - Config read: `main/services/config-store-core.ts:799-829`; patch: `:1233-1311`.
  - Desktop ↺ is "Reset to <home>" (`renderer/components/agent-slider.tsx:195`).

### 2. What's live today

- A system Menu: Provider section → model → effort submenu (live shot 05).
- No stops, no active-stop derivation, no ↺ and no haptics.
- A hidden selected model shows "· Hidden".
- Empty state: the chip is hidden when there is no model (`AidenComposerConfig.chat(model:)`).

### 3. Concept delta

| # | Concept 5 | Proposal |
|---|---|---|
| C1 | A bottom sheet: big stop label "Balanced", subtitle "Sonnet 5.5 · Medium", a track of stop dots with a draggable thumb. | `AidenAgentSliderSheet` (`.presentationDetents([.height(~260)])`) with a native track. Each stop snaps with a selection haptic tick through `coordinator.haptics`. VoiceOver: an adjustable element (`accessibilityAdjustableAction`) whose value reads "Balanced, Sonnet 5.5, Medium, 3 of 5". |
| C2 | Links "Other models" and "Customize". | "Other models" opens today's provider and model list (the old Menu content, moved into a list). "Customize" opens the section D page. |
| C3 | No ↺ visible. | **Add ↺ "Reset to <home stop>"**, matching desktop (`agent-slider.tsx:195`), visible when the active stop ≠ home. This is the faithful "Reset on phone" in a chat. It needs no new write route. |
| C4 | — | A **Custom** state when no stop matches (desktop rule): label "Custom", the subtitle shows the real model and level, and the thumb is hidden. An **unavailable stop** (provider gone or model hidden) is skipped, never substituted: dimmed and not snappable. |
| C5 | — | The composer chip shows the stop glyph plus the stop label (section A4). With no `agentSlider` from the host (old host), fall back to today's Menu chip. |

### 4. Gap class: mostly server contract and cross-platform

Server contract, one PR. Claim the next Remote revision at merge (`main/services/aiden-remote-protocol.ts:373-374`; revision 65 today, so 66 or later) and bump iOS, Android and the fixtures together.

1. **`GET /models`** gains `agentSlider?: { stops: [{id, label, providerId?, modelId?, thinkingLevel?}], homeStopId }`.
   - File: `main/services/aiden-remote-models.ts`.
   - Source: the normalized config snapshot (`config-store-core.ts:820-829`).
   - Rename `model` to `modelId` to match the Remote naming.
   - Omit the field when the slider is unreadable or unset.
   - Check the 900 KiB budget.
   - The CLI server bundles `main/services`. Confirm that `packages/cli`'s model service also supplies the slider, or omits it, and keep `tests/bundle.test.mjs` green.
2. **Chat projection** gains `thinkingLevel` (with `providerId` and `model`) in `chatRevision` / visible metadata (`main/services/aiden-remote-chats.ts:723-735`) and in the summaries/messages-window metadata. This is how the phone derives the active stop of a desktop-set chat.
3. **Durable phone selection.** Persist a phone's accepted provider, model and level through `setChatModelSelection` (`main/services/chat-application-service.ts:367`, `chat-store-core.ts:2105`). Two options:
   - **Option a (plan's choice, `agent-slider-plan.md:104`):** on turn accept in `POST /chats/{id}/turns` (`aiden-remote-chats.ts:1255-1303`).
   - **Option b:** extend `PATCH /chats/{id}` (today rename-only, `aiden-remote-router.ts:4716-4729`) to accept `{providerId, modelId, thinkingLevel}` with `If-Match`, so a slider move persists without sending.

   Recommend **a + b**: the slider moves before the user types, and desktop shows the change at once.
4. **Fixtures and docs:**
   - `protocol/aiden-remote/v1/fixtures/contract.json` (add `agentSlider` and a chat with `thinkingLevel`);
   - `docs/aiden-remote-api-v1.md` (new revision section);
   - `docs/plans/agent-slider-plan.md` and the `docs/plans/README.md:91` status row.

The rest:

| Item | Gap class |
|---|---|
| iOS: the `AidenAgentSlider` model and a port of `activeStopIndex` / `resolveAgentSliderStop` | Client model |
| iOS: the sheet and chip | UI-only |
| Android parity (`features/chat/AidenComposerModelSheet.kt` is already a sheet with radio cards; it becomes the slider sheet) | Cross-platform |

### 5. Implementation steps

1. Server PR (above), with tests extending `main/services/aiden-remote-models.test.ts` and `aiden-remote-chats.test.ts` (call `list()` and the turn parser with fixtures).
2. iOS model:
   - Add `AidenAgentSlider: Codable` and `AidenAgentSliderStop` in `iOS/Models/AidenChat.swift` near `AidenModelCatalog` (`:3073`), with `agentSlider: AidenAgentSlider?` on the catalog.
   - Add `AidenChat.thinkingLevel?`.
   - Port `activeStopIndex` and `resolveAgentSliderStop` into a pure `AidenAgentSliderResolver` in `iOS/Features/Chat/AidenChatPolicies.swift`, next to `AidenChatModelAuthority` (`:390-504`).
3. `AidenChatViewModel`: add `sliderState` (stops, active index or Custom, home index, unavailable set) derived from `catalog` plus the resolved selection. Add `selectStop(_:)` and `resetToHome()`, which call the existing `selectModel(providerId:modelId:thinkingLevel:)` and then the new `PATCH` (gated on the host revision).
4. UI:
   - `AidenAgentSliderSheet` and `AidenAgentSliderTrack` in `iOS/Features/Conversation/`, so the Home and Bot surfaces can reuse them.
   - Replace `modelChip` in `AidenChatComposer.swift:197` with an `AidenAgentSliderChip` that opens the sheet.
   - Move the Menu content into `AidenOtherModelsList` for "Other models".
5. **Demo:**
   - Extend `AidenDemoHosts.modelsJSON` (`iOS/Features/Remote/Demo/AidenDemoHosts.swift:820-833`) with Haiku, Sonnet and Opus models with level ladders, and an `agentSlider` of 5 stops: Instant, Fast, Balanced (home), High, Max.
   - Give one demo chat a `thinkingLevel` matching "Balanced" and one that is Custom.
   - Matrix captures: the slider sheet (busy), Custom, and `old-host` (Menu fallback).
6. **Tests:**
   - Decoding with and without `agentSlider` against the shared contract fixture.
   - Resolver cases from the **shared fixture**, so desktop and iOS check against the same oracle rather than restating the logic:
     - exact match;
     - no match → Custom;
     - unavailable stop skipped;
     - home index.
   - View-model test: `resetToHome` sends the home stop's selection on the next turn.
   - XCUITest: open the chip → adjust the slider → the chip label reads "High".

### 6. Effort and risk

- **Effort:** L, counting server, iOS and Android.
- **Risk:**
  - Revision claim conflicts with other open Remote PRs.
  - Concurrency on `setChatModelSelection` (reuse its compare-and-set).
  - The owner is building the phone slider by hand. **Confirm before scheduling (open question 1).**
- **Dependencies:** section A chip slot; t2 (Bot chat) is unaffected, because a Bot's model is set on the Bot.

---

## D. Concept 20 + idea-agent-slider: Agent Slider in Settings

### 1. Entry point

- `iOS/Features/Workspace/AidenAppSettingsView.swift`. Its sections:
  - Aiden Agent (`:81`)
  - Global defaults (`:92-108`)
  - Providers (`:110-114`)
  - Policies (`:117-123`)
  - Chat (`:127-133`)
  - Memory (`:137-153`)
  - Read Aloud (`:156-160`)
  - Voice input (`:164-179`)
  - Feedback (`:188-196`)
  - About (`:203`)
- There is no Agent Slider row (live shot 19).

### 2. What's live today

Nothing. The slider is editable only in desktop Settings (`renderer/components/settings/agent-slider-settings.tsx`).

### 3. Concept delta

| # | Concept | Proposal |
|---|---|---|
| D1 | A page "Agent Slider": a grouped card of 5 rows, each a dot glyph plus label plus model · level, with a checkmark on "Balanced". | Add a row "Agent Slider" under **Providers** in Global defaults that pushes `AidenAgentSliderSettingsView`. Follow `docs/settings-design-system.md`: grouped card, inset separators. |
| D2 | A checkmark on the active stop. | **Contradiction:** the active stop is per chat and derived, so a Settings page has no "active" stop. The checkmark must mark the **home stop** (the ↺ target), with the footer "Chats start on Balanced. ↺ in a chat returns here." |
| D3 | Idea: a "Reset" text button. | The desktop has **no** general reset. The only rewrite is "Replace" when `config.json` is unreadable (`agent-slider-settings.tsx:261-268`, seeding via `seedAgentSlider`). Faithful v1: the page is **read-only**, with a footer "Edit stops on your computer in Settings → Agent Slider." Choosing a home stop or reseeding from the phone needs a write route (D4). |
| D4 | — | Optional write: `PUT /agent-slider` with `If-Match` (revision from a hash of the normalized slider), body validated by `parseAgentSliderPatch` (`renderer/shared/agent-slider.ts:157`), saved through the same config path (`config-store-core.ts:1233-1311`). A new scope, or the existing `workspace:manage` (scopes used in `aiden-remote-router.ts`). Desktop-hosted only; the CLI must 404. |

### 4. Gap class

| Item | Gap class |
|---|---|
| D1, D2 | UI-only on top of C's server field |
| D3 read-only | UI-only |
| D4 | Server contract (new route, revision bump, iOS, Android, fixtures) plus cross-platform |

### 5. Steps

1. `AidenAgentSliderSettingsView` reads `catalog.agentSlider`. Rows reuse `AidenAgentSliderStopGlyph` and mark unavailable stops "Unavailable on this Mac". The empty state "Set up the Agent Slider on your computer" covers both an absent slider and an unreadable config.
2. Add the row to `AidenAppSettingsView`. Hide it when the host lacks the revision.
3. **Demo and matrix:** the page in busy and dark modes.
4. **Tests:**
   - Unit: the home stop is marked, not the stop of the most recent chat.
   - XCUITest: Settings → Agent Slider shows 5 rows and the home checkmark.

### 6. Effort

- S for read-only; M with D4.
- Dependency: section C's server PR.

---

## E. Concept 9: Live voice

### 1. Entry point

- There is no iOS screen. The nearest pieces:
  - composer dictation (section A);
  - Read Aloud: `AidenReadAloudPlayback` (`iOS/Features/Chat/AidenReadAloud.swift:8-60`), with routes `GET /read-aloud`, `POST /chats/{id}/read-aloud`, `/stop` and `/audio/...` (`aiden-remote-router.ts:672`; client `AidenRemoteClient.swift:4552-4562`);
  - the "By voice" label: `AidenChatMessage.inputSource` (`iOS/Models/AidenChat.swift:50-58`), protocol revision 60.
- Read Aloud is host-gated by `REMOTE_TTS_FEATURE` (`aiden-remote-router.ts:1896`). Live shot 19 shows "Read Aloud unavailable".

### 2. What's live (desktop and Android)

- **Desktop Aiden Live:** Gemini Live, full-duplex.
  - The main process owns the Google API key, mic capture and provider socket (`docs/plans/gemini-live-assistant-plan.md:170-186`).
  - Ribbon pill above the composer; the send-button launcher (`.memory/aiden-live-send-button.md`).
  - Chat tools (send, stop, open chat) mark sends `inputSource: "voice"` (`gemini-live-assistant-plan.md:108-116`).
- **Android:** no Live voice; its hits are streaming "live transcript" only.
- **Phones:** no Live route of any kind.

### 3. Concept delta

| # | Concept 9 | Proposal |
|---|---|---|
| E1 | A full-screen dark view: chevron-down, pill "● Voice · Studio Mac", (i). | `AidenVoiceModeView` as a `.fullScreenCover`. The pill names the machine, matching the "on Studio Mac" pattern from B4. (i) opens a sheet explaining that speech is transcribed on this iPhone or on the Mac and that replies are read aloud by the Mac. |
| E2 | A large Hi-bit sprite (Repo Watcher) in concentric rings, the name, a waveform, "Listening". | For a Bot chat, use that Bot's **Hi-bit sprite** (the only avatar, per AGENTS.md). For a plain chat, use the Aiden mark, **never a brain**. Rings pulse with mic level. Respect Reduce Motion with a static ring and a status label. States: Listening → Thinking → Speaking → Listening, plus Paused. |
| E3 | A transcript card: "You: …" / "<Bot>: …". | The last user turn and the streaming reply, from the chat view model's existing stream. |
| E4 | Bottom row: camera, mic (mute), screen, red ✕. | Camera reuses the attachment camera (`AidenAttachmentPicker.swift:680`) and sends with the next turn. Mic is mute or pause. **Drop "screen"**: phone screen sharing to the agent does not exist, and desktop screen share is Mac capture to Gemini; flag it to the owner. ✕ ends. |
| E5 | Implied: real-time duplex voice. | **v1 is a turn-based voice mode on existing routes:** dictation (`SFSpeech` or `/speech/transcriptions`) → silence end-pointing on the phone → `POST /chats/{id}/turns` → Read Aloud of the reply → listen again. Barge-in: tapping or speaking stops read-aloud (the existing `stopReadAloud`) and listens. |

### 4. Gap class

| Item | Gap class |
|---|---|
| E1–E4 | UI-only plus client state: a `AidenVoiceModeController` that owns mic, end-pointing and the read-aloud loop |
| "By voice" on phone sends | Server contract. Add `inputSource: "voice"` to the turn parser's allowed keys (`aiden-remote-chats.ts:1271`, `exactKeys`), store it like Live does, and claim a revision. Small. iOS and Android already render the label. |
| Bot chats | Confirm `/chats/{id}/read-aloud` serves Bot chats (`botId` set); otherwise extend it (server contract). |
| True Live (v2) | Server contract plus cross-platform, **XL**. A new bidirectional audio channel (Remote is HTTP+SSE: an upstream PCM POST stream and a downstream audio SSE, or a WebSocket), host-side Gemini Live sessions bound to a paired device, credential and quota rules, kill switches (`AIDEN_EXPERIMENTAL_GEMINI_LIVE`), a privacy doc update. A separate plan, not this track. |
| Android parity | Cross-platform (the same voice mode). |

### 5. Steps for v1

1. `AidenVoiceModeController` in `iOS/Features/Conversation/`:
   - Composes `AidenComposerVoiceCapture` and `AidenReadAloudPlayback`.
   - Uses AVAudioSession `.playAndRecord` with `.voiceChat` mode. It must not fight `ComposerVoiceAudioSessionConfiguration` (`ComposerVoiceInputController.swift:524`).
   - Uses an end-pointing timer.
   - Generation fences, like `ComposerVoiceSessionFence` (`:460`).
2. `AidenVoiceModeView`, plus `AidenBotAvatar`-based rings, which come from t2's shared sprite component.
3. Wire the composer's Voice button (A1) and `AidenAppNavigation.open(startsVoice:)` (`:519-531`) to present voice mode where the host supports Read Aloud. Otherwise the button falls back to dictation.
4. **Demo:** `AidenDemoHosts` already serves read-aloud status (`readAloudStatusJSON`, around `:845`). Add a `-AidenDemoVoiceMode` launch flag to open the cover with a scripted transcript for screenshots.
5. **Tests:**
   - Controller unit tests with fake capture and playback:
     - silence → send;
     - speech during playback → stop playback and listen;
     - ✕ cancels an in-flight transcription with no late send.
   - XCUITest: the cover opens from the empty-composer Voice button and ✕ returns.

### 6. Effort and risk

- **Effort:** M for v1; XL for true Live.
- **Risk:**
  - Audio-session conflicts with dictation and Read Aloud.
  - End-pointing quality.
  - Copy honesty: label it **"Voice"**, not "Aiden Live", unless v2 ships.
- **Dependencies:** t2 for the sprite component; section A for the Voice button.

---

## Shared components to extract (design layer)

- `AidenComposerPrimaryAction` (resolver) and `AidenComposerVoiceModeButton`
- `AidenComposerConfig.home()`
- The hold-to-talk API on `AidenComposerSession`
- `AidenAgentSliderStopGlyph` (dots), `AidenAgentSliderTrack`, `AidenAgentSliderSheet`, `AidenAgentSliderChip`
- `AidenAgentSliderResolver`, a pure port of `renderer/shared/agent-slider.ts:255,285`
- `AidenRadioListRow`: no border; checkmark and background token
- `AidenSummaryChip`: the stop and permission chips
- `AidenMachineLine`: "on Studio Mac ⌄", used by the New chat and Voice pills
- `AidenVoiceModeController` and `AidenVoiceRings`

## Suggested phase order

1. **Composer contract (A1–A3, A5)** and the **New chat sheet (B)**. Client-only, ships alone, and unblocks t1a's Home.
2. **Slider server contract (C4 items 1–4).** One PR across host, iOS decoders, Android decoders and fixtures. Claim the revision at merge.
3. **Slider UI (C)** and the **read-only Settings page (D1–D3)**, on iOS and Android.
4. **Voice mode v1 (E)**, with the small `inputSource` turn contract (same or next revision).
5. Optional: **slider write route (D4)**; **true Live on phones (E v2)** as its own plan.

## Open questions for the owner

1. The plan says you are building the phone slider by hand (`docs/plans/README.md:91`). Should this track schedule section C and D, or only reserve the chip slot?
2. Phone slider persistence: on send only (plan PR 5), or also on move with an extended `PATCH /chats/{id}`?
3. "Reset" on the phone Settings page: (a) none, read-only; (b) choose the home stop; or (c) reseed like desktop's "Replace"? In a chat, ↺ "Reset to home" needs no new route.
4. Concept 9: is a turn-based "Voice" mode (dictation → send → Read Aloud) acceptable for v1, or do you want true Gemini Live relayed through the Mac (XL)? Can the screen-share button be dropped?
5. Hold to talk: on release, keep the words in the field, or send immediately?
6. New chat: should "New workspace" stay folderless, or should the concept's "New folder" create a real folder via the location picker?
7. Just chat permission chip: per-chat, or read-only showing the Chats home's setting?
