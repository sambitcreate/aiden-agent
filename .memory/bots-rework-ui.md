# Bots rework: UI, copy, feature tokens and follow-ups (2026-10-07)

Status: implemented on PR #377 (`feature/bot-ui-durable-sessions-2f4474`). Physical-device acceptance is pending. Spec: `docs/superpowers/specs/2026-10-07-bots-rework-design.md`. Plan: `docs/superpowers/plans/2026-10-07-bots-rework.md`. Runtime: `.memory/bot-durable-runtime.md`.

## Screen map (desktop, iOS, Android)
- **List:** one list of Bots, with search and +. Row: avatar with an activity dot, name, subtitle pill, last-message preview, relative time. A paused Bot shows "Paused — tap to resume". Tapping a row opens its chat. Long-press or context menu: Profile, Delete. Bots from a paired Mac show a small Mac badge.
- **First run ("Meet your first Bot"):** a carousel of starter presets. Start chat creates the preset (idempotent, keyed `preset:<id>`) and opens its chat. Create my own opens the create flow.
- **Create (two steps):** name and "What should it help with?", then optional connect-now chips (Back + Create). The self-intro runs only on genuine creation, with a model configured.
- **Chat:** header with back, a name pill that opens Profile, and ••• (Profile, Files, Delete Bot). Plain bubbles, file chips, A–E quick replies (up to 5 options), connect cards, and one collapsible "Working…" / "Updates" line. Long-press gives Copy and Reply. Desktop chat mode hides workspace, git, permission, model and thinking pickers.
- **Profile:** photo (Choose photo, Generate on iOS only, Remove photo), inline name and subtitle, Character (colour and shape, Reset to default), Instructions full-screen editor, Routines, and ••• (Advanced, Delete Bot).
- **Advanced:** model and image model (auto by default), Full or Custom access, opening greeting, and the Telegram binding (desktop only).
- **Delete:** a confirmation dialog with a destructive button.

## Desktop layout and save model (2026-10-09 redo)
- Every Bots screen uses the shared `ScrollArea` (drag-region toolbar, sidebar-collapsed inset, scroll-edge fade). Home: toolbar "Bots" + **New Bot**, content `mx-auto max-w-3xl px-5`, always-visible search field (icon + Clear) once Bots exist, skeleton rows while loading, red `Callout` + Try again on failure. Rows keep the context menu and add a hover/focus-revealed ••• (Profile, Delete Bot). "Delete Bot" is the label in every menu.
- First run copy is sentence case: "Meet your first Bot", "Start chat" (quiet filled), "Create my own" (the one accent action; omitted in onboarding).
- Profile, Instructions and Advanced share `bots/bot-page-shell.tsx` (`BotPageShell` = ScrollArea + `settings-responsive` column + `SettingsPage`; toolbar title is the Bot's name, back on the left). Groups/rows are `FieldSet`/`Field`. `/bots/$botId?page=advanced|instructions` opens a sub-page directly (route `validateSearch` = `parseBotPageSearch`); moving between Profile and sub-pages afterwards is local state (a search-only navigation stalls in the test router).
- Scrollports carry `scrollRestorationId` (`ScrollArea` prop → `data-scroll-restoration-id`); without it TanStack scroll restoration copied the chat's offset onto the Profile's same-position scrollport.
- Save model: **Profile auto-saves each control** (name/subtitle on blur or Return, character on click, photo at once). **Instructions and Advanced are drafts saved by one toolbar Save**; Back with unsaved edits opens a "Discard changes?" AlertDialog (`useDiscardChangesGuard`). Advanced's Save covers model, access and opening greeting together; Telegram Connect/Disconnect stay immediate actions (account links, like Settings connection rows). Instructions can't be saved empty (main requires them); the editor shows a count against `BOT_LIMITS.instructionsChars`.
- Create flow: Back on step 2 uses the new shared `Dialog` prop `cancelKeepsOpen` (no `DialogPrimitive.Close`), keeping the draft. No inline Skip: footer is Back + Create. A new Bot gets Full access, which already covers every connected app, so chips are "connect now" shortcuts (`ConnectionChips` `connected`/`onConnect`; already-set-up mcp presets show a check), not a per-Bot selection. Composio chip reads "More apps (Composio)".
- Chat: `ScrollArea` with `autoScrollToBottom` (follows only while at the bottom) + scroll-to-bottom button; transcript/footer use `aiden-dock-inset chat-content-column`, so Appearance → Chat width applies. Interrupted, failed, model error, approval and connect cards share `components/bots/bot-notice-card.tsx` (status icon fill, title, quiet text, trailing actions; approvals are elevated in the footer like the workspace approval card). `model_error` offers **Choose a model** (Advanced) and **Open Providers**; "Open Advanced" on an access-changed interruption now really opens Advanced. Loading is bubble skeletons.
- Routines group: inset-separated rows with chevrons, an "Add routine" row, skeleton/empty/error rows. Routine editor uses `FieldLabel`/`Input` (date, time)/`Select` (month day) and a red `Callout` for errors. Files dialog has a single Close, a friendly title (Bot's files / file name with its path as description), skeletons, Try again, and an empty state.

## Key files
- Desktop: `renderer/main/bots-view.tsx` (route shell), `renderer/main/bots/*` (`bot-page-shell.tsx`, `bot-page-search.ts`, `bot-list.tsx`, `bot-starter-carousel.tsx`, `bot-create-flow.tsx`, `bot-chat-pane.tsx`, `bot-chat-header.tsx`, `bot-profile.tsx`, `bot-advanced.tsx`, `bot-delete-dialog.tsx`, `bot-routines.tsx`, `bot-routine-editor.tsx`, `bot-character-card.tsx`, `bot-updates.tsx`, `bot-session-state.ts`, `use-connection-setup.tsx`), `renderer/components/bots/connect-card.tsx`, `connection-chips.tsx` and `bot-notice-card.tsx`, shared helpers `renderer/shared/bot-presets.ts`, `bot-routine-label.ts`, `bot-routine-schedule.ts`, `bot-connections.ts`, live hook `renderer/lib/use-bot-live.ts`.
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
- Revision **27** (2026-10-09, Bot memory/soul/proactivity, re-claim at merge; `main` was 26): tokens `bot-memory-v1` and `bot-proactive-v1`, negotiable `bot:cards` gating `memory_update`/`routine_proposal` session entries, routes for memory, proposal answers, routine suggestions and `GET /bots/routine-notifications`, and `openingGreeting` retired (never emitted, accepted and ignored). Details: `.memory/bot-proactivity.md`.
- Aiden Remote contract revision **25** (`main` is at 24). Tokens in `aiden-remote-protocol.ts`: `bot-delete-v1`, `bot-durable-session-v1`, `bot-routines-v1`, `bot-connection-requests-v1`, `bot-presets-v1`. iOS (`AidenBotSessionModel.swift`) and Android consume the same tokens, and fixtures are shared across TS, Swift and Kotlin.
- Routes added in revision 25: `POST /bots/{id}/resume` and `/dismiss` (idempotent per request UUID), `DELETE /bots/{id}`, `GET/POST/PATCH/DELETE /bots/{id}/routines`, `POST /bots/{id}/connection-requests`, `GET /bot-presets`, `POST /bots/from-preset`.
- Remote audit (2026-10-07): `/server.features` announces each token only while its route is wired (router test "revision 25 Bot feature tokens…"; before this the tokens were never sent). `GET /bots/{id}/session` and `/session/events` need `chat:read` as well as `bot:read`; the stream crosses the revocation fence and `revokeDevice` closes it; a rebuilt Remote API closes the old session service.
- The Remote session projection is derived from the desktop `projectBotTranscript`, so phones hide the self-intro prompt and whole `[SILENT]` turns, show a failed turn as "I couldn't finish that reply. Try sending it again.", and resolve connect cards with the desktop `connectCardStatus`. The stream sends a mid-stream `snapshot` when shown history is rewritten, always sends `partial` with `""` when it clears, and re-sends an `entry` id when it changes (clients upsert by id). Every frame is exactly one seq after the last (projection is serialized per Bot).
- `POST /bots/from-preset` uses the process-wide `botStarter()` (shared with desktop Start Chat; the creating call alone sends the self-intro), with the device as the access audience. Routine `lastError` is redacted of local paths and key-shaped strings for phones.
- A revision-24 phone cannot read a revision-25 Bot list (its parsers require `favorites` and avatar `eyes`/`detail`); accepted pre-1.0. New clients show a plain "update Aiden" error against a revision-24 Mac.

## Android after merging main (PR #374)
- Bot screens follow main's localization and shape conventions: composable copy is in `strings.xml` (`bots_*`, `bot_menu_*`, `bot_profile_*`, `bot_editor_*`, `bot_character_*`, `bot_color_*`, `bot_shape_*`, `bot_routine*`, `bot_advanced_*`, `bot_session_*`, `bot_files_*`, `bot_presets_*`), radii come from `MaterialTheme.shapes`, and enums carry `@StringRes` (`AidenBotAccessChoice`, `AidenBotRoutineFrequency`, colour/shape labels). Still English by convention: JVM-tested helpers (`AidenBotHomeRow.preview`, `aidenBotChatPlaceholder`, `aidenBotDeleteCopy`, `aidenBotRoutineWriteFailure`, `AidenBotSessionCopy.PAUSED_ROW/NEEDS_MODEL`).
- Profile, Instructions editor, Files sheet and the legacy Bot chat route fence reads with `coordinator.holdsReadAuthority`; Profile, Advanced, Files and the session use skeletons, not spinners; Bots home revalidates on `ON_START`; screens use `aidenReadableWidth()`.
- Main's Custom Access, Image Studio, Bot chat tools and prototype snapshot test stay deleted, with their strings.
- Desktop launch starts Bots through `startBotApplication` (`main/services/bot-startup-core.ts`), which never throws.

## Known follow-ups
- Android Advanced still lists models as radio rows; main's shared `AidenModelPickerField` is not used there yet.
- **iOS simulator flake:** on Xcode-beta iOS 27, `AidenRemoteClientTests` failed to launch the host in parallel mode and passed serially. Record the run link on the PR.
- Monthly routines are limited to days 1–28.
- The Updates fold shows narration only (one line per reply on desktop).
- Telegram turns and routine turns that hit an approval-gated tool wait for an answer on desktop or phone.
- Android has no Generate (Image Playground) option.
- Phones show no inline file chips: Remote session entries carry no file metadata.
- Subagents on durable Bots are read-only children. Write, shell, web, MCP and delegation lanes are not ported, and Form Fill is not offered.
- iOS and Android still use the Title Case first-run copy ("Meet Your First Bot", "Start Chat", "Create My Own"); desktop moved to sentence case.
- Dead but present: `BotDefinition.archivedAt` in `renderer/shared/bots.ts`, the `includeArchived` query, `bot-archived-file-read-authority.ts`, and the capability `authorityStatus` field.
