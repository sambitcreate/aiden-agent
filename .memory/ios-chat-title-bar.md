# iOS Telegram-style chat top bar — 2026-11-24

Owner asked for Telegram iOS's chat header in the iPhone app's Workspace and Bot chats (iOS only; desktop is unchanged, see `.memory/chat-top-bar.md` for the desktop bar).

## Shape
- `ios/AidenOnTheGo/Features/Conversation/AidenChatTitleBar.swift`:
  - `AidenChatTitleStatus`: the line under the title. Tone `.secondary` (at rest), `.accent` with typing dots (working), `.warning` with no dots (waiting on the person or unable to answer). A trailing "…" is stripped because the dots already say it. `kind` (tone and active flag) drives the drop-in transition, so a change of tool text within one kind doesn't animate.
  - `.workspace(...)`: live activity label while streaming or waiting for approval; otherwise "workspace · machine" when several Macs are paired (`aidenConversationMachine`), else "workspace · branch".
  - `.bot(...)`: Waiting for you, then the run state (Paused, Unavailable, Needs a model, Interrupted), then the status word, otherwise "machine · purpose" (or the purpose, or "Bot").
  - `AidenTypingDots`: 0.7s wave, scale 1→1.5; still under Reduce Motion.
  - `AidenChatTitleCapsule`: 44pt glass capsule in the toolbar's principal slot, solid `palette.raised` under Reduce Transparency, Dynamic Type capped at xxLarge with the large content viewer. ID `chat-title-capsule`; label is the title, value is the status.
  - `AidenWorkspaceInitialsAvatar`: up to two initials on the accent fill.
  - `AidenChatHeaderAvatar` + `AidenChatStackedTitle`: Bot chats stack the face over the name (owner's Telegram reference, 2026-11-24). The 52pt face is the toolbar's principal item, reaching a little past the 44pt bar; the capsule rides a top `safeAreaBar` just under the bar, pulled up 10pt so the face overlaps it. The capsule stays out of the bar so all of it takes taps; UIKit only hit-tests a bar item inside the bar's bounds (not tried, reasoned from hit-testing). The face is hidden from VoiceOver since the capsule opens the same profile. `aidenComposerSoftScrollEdge` now softens the top edge too; without it the top bar ended in a hard line.
- `AidenTranscriptScaffold(showsMachineSubtitle:)` hides the old nav subtitle when the capsule carries the machine name.

## What each button does
- Workspace chat (`AidenChatDetailView`): the capsule and the initials avatar on the right (ID `chat-avatar`, VoiceOver "More") both open the chat session sheet (Rename, Fork, Read response aloud, Files). No ••• button: a chat with no workspace has an empty right side and its title opens the sheet.
- Bot chat (durable `AidenBotSessionChatView` and legacy Bot chats in `AidenChatDetailView`): the stacked face and name open the Bot profile; ••• on the right opens the Bot session sheet (Profile, Files, Memory, Advanced, Delete). Owner found two separate buttons doing the same thing odd; stacking makes face and name read as one header.
- The avatar view is the Button's label directly. Wrapping it in a `Label` made the bar draw the title "More" instead of the avatar, and `.labelStyle(.iconOnly)` did not fix that.

## Tests
- `ios/AidenOnTheGoTests/AidenChatTitleBarTests.swift`: status lines, machine naming, the dot wave, initials.
- `AidenShellUITests.testAChatNamesItsMachineWithSeveralMachines` now reads the machine name from the capsule's value.
