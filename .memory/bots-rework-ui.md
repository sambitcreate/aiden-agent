# Bots rework: UI, copy, feature tokens and follow-ups (2026-10-07)

Status: implemented on PR #377 (`feature/bot-ui-durable-sessions-2f4474`). Physical-device acceptance is pending. Spec: `docs/superpowers/specs/2026-10-07-bots-rework-design.md`. Plan: `docs/superpowers/plans/2026-10-07-bots-rework.md`. Runtime: `.memory/bot-durable-runtime.md`.

## Screen map (desktop, iOS, Android)
- **List:** one list of Bots, with search and +. Row: avatar with an activity dot, name, subtitle pill, last-message preview, relative time. A paused Bot shows "Paused — tap to resume". Tapping a row opens its chat. Long-press or context menu: Profile, Delete. Bots from a paired Mac show a small Mac badge.
- **First run ("Meet Your First Bot"):** a carousel of starter presets. Start Chat creates the preset (idempotent, keyed `preset:<id>`) and opens its chat. Create My Own opens the create flow.
- **Create (two steps):** name and "What should it help with?", then optional connection chips (Skip creates). The self-intro runs only on genuine creation, with a model configured.
- **Chat:** header with back, a name pill that opens Profile, and ••• (Profile, Files, Delete). Plain bubbles, file chips, A–E quick replies (up to 5 options), connect cards, and one collapsible "Working…" / "Updates" line. Long-press gives Copy and Reply. Desktop chat mode hides workspace, git, permission, model and thinking pickers.
- **Profile:** photo (Choose photo, Generate on iOS only, Remove photo), inline name and subtitle, Character (colour and shape, Reset to default), Instructions full-screen editor, Routines, and ••• (Advanced, Delete Bot).
- **Advanced:** model and image model (auto by default), Full or Custom access, opening greeting, and the Telegram binding (desktop only).
- **Delete:** a confirmation dialog with a destructive button.

## Key files
- Desktop: `renderer/main/bots-view.tsx` (route shell), `renderer/main/bots/*` (`bot-list.tsx`, `bot-starter-carousel.tsx`, `bot-create-flow.tsx`, `bot-chat-pane.tsx`, `bot-chat-header.tsx`, `bot-profile.tsx`, `bot-advanced.tsx`, `bot-delete-dialog.tsx`, `bot-routines.tsx`, `bot-routine-editor.tsx`, `bot-character-card.tsx`, `bot-updates.tsx`, `bot-session-state.ts`, `use-connection-setup.tsx`), `renderer/components/bots/connect-card.tsx` and `connection-chips.tsx`, shared helpers `renderer/shared/bot-presets.ts`, `bot-routine-label.ts`, `bot-routine-schedule.ts`, `bot-connections.ts`, live hook `renderer/lib/use-bot-live.ts`.
- iOS: `ios/AidenOnTheGo/Features/Bots/*` (`AidenBotsHomeView`, `AidenBotPresetsView`, `AidenBotCreateView`, `AidenBotSessionChatView`, `AidenBotSessionModel`, `AidenBotProfileView`, `AidenBotAdvancedView`, `AidenBotRoutinesView`, `AidenBotCharacter`, `AidenBotImagePlaygroundView`), models `Models/AidenBotSession.swift` and `Models/AidenBotRoutine.swift`.
- Android: `android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/*` (`AidenBotsHomeScreen`, `AidenBotPresetCarousel`, `AidenBotSessionScreen`, `AidenBotSessionController`, `AidenBotProfileScreen`, `AidenBotAdvancedScreen`, `AidenBotRoutines`, `AidenBotDeleteDialog`, `AidenBotCharacterCard`, `AidenBotChatHeader`, `AidenBotCanonicalAvatarView`).
- Remote host: `main/services/aiden-remote-protocol.ts` (revision and feature tokens), `main/services/aiden-remote-router.ts` (routes), `main/services/aiden-remote-bot-session.ts`.
- Main: `main/services/bot-runtime/*`, `main/services/bot-connection-setup.ts`, `main/services/bot-connection-dismissals.ts`, `main/services/scheduled-bot-routines.ts`.

## Deleted
- Desktop: the Conversations section and `startConversation`, the `BotEditor` wizard, `BotAccessSummary`, `BotFaceStudio`, the LLM avatar generator (`bot-avatar-generator-core.ts`, `bots:suggestAvatar`, `cancelAvatarSuggestion`), archive UI, `bots:openChat`.
- iOS: `Prototype/BotFirstPrototype.swift` and its snapshot test, `AidenBotEditorView`, `AidenBotCustomAccessFlowView`, Favorites, the compose chooser, the Full Access notice wall, the "Set Up Image Understanding" alert.
- Android: `prototype/BotFirstPrototype.kt`, `AidenBotCustomAccessFlowScreen.kt`, `features/remote/AidenBotChatToolsView.kt`, `AidenBotImagePlaygroundView.kt`, Favorites, FAB chooser, Recent Chats, eye and accessory pickers.
- Remote: `/bot-favorites`, `/chats/:chatId/capabilities` for Bots, `/bots/:id/archive|restore` (now refused). Delete is `DELETE /bots/{botId}`.
- Archive is replaced by a permanent Delete. Pre-1.0, no migration: legacy Bot transcripts are wiped and extra Bot conversations are removed.

## Copy (exact)
- Delete body: `Delete {name}? This permanently erases {name}'s chat, memory, instructions, routines, files, and photo. This can't be undone.` Button: `Delete Bot` (destructive).
- Interrupted: `I got interrupted while working on this.` with **Resume** and **Dismiss**. Access drift: "This Bot's access changed. Review it in Advanced."
- Row and state labels: `Paused — tap to resume`, `Needs an AI model` (with Set up).
- Lock: "Bots are open in another Aiden window." (no writes happen).
- Connection card: "Connect {name}" with **Connect** and **Not now**; after setup, "Connected ✓". Mobile button: **Finish on your Mac**.
- Routine silence token: `[SILENT]`. Routine rows use the host label, e.g. "Every Sunday at 8:41 AM".

## Feature tokens and revision
- Aiden Remote contract revision **25** (`main` is at 24). Tokens in `aiden-remote-protocol.ts`: `bot-delete-v1`, `bot-durable-session-v1`, `bot-routines-v1`, `bot-connection-requests-v1`, `bot-presets-v1`. iOS (`AidenBotSessionModel.swift`) and Android consume the same tokens, and fixtures are shared across TS, Swift and Kotlin.
- Routes added in revision 25: `POST /bots/{id}/resume` and `/dismiss` (idempotent per request UUID), `DELETE /bots/{id}`, `GET/POST/PATCH/DELETE /bots/{id}/routines`, `POST /bots/{id}/connection-requests`, `GET /bot-presets`, `POST /bots/from-preset`.

## Known follow-ups
- **iOS simulator flake:** on Xcode-beta iOS 27, `AidenRemoteClientTests` failed to launch the host in parallel mode and passed serially. Record the run link on the PR.
- Monthly routines are limited to days 1–28.
- The Updates fold shows narration only.
- Telegram turns and routine turns that hit an approval-gated tool wait for an answer on desktop or phone.
- Android has no Generate (Image Playground) option.
- "Meet Your First Bot" exists as a native carousel on iOS and Android and as the desktop empty state. The desktop onboarding step is not added yet.
- Subagents on durable Bots are read-only children. Write, shell, web, MCP and delegation lanes are not ported, and Form Fill is not offered.
- Playwright e2e for preset, then Start Chat, then quick reply is not written yet.
- Dead but present: `BotDefinition.archivedAt` in `renderer/shared/bots.ts`, the `includeArchived` query, `bot-archived-file-read-authority.ts`, and the capability `authorityStatus` field.
