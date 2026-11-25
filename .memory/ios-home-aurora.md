# iOS Home and Aurora (Phase 2 lane)

Branch `claude/ios-home-aurora`. Plan: `docs/plans/ios-new-direction-upgrade-plan.md` (Phase 2 progress is the source of truth).

## Home
- `Features/Shell/AidenHomeView.swift`: `AidenHomeHeader` (greeting, sprites, "From your Bots"), `AidenHomeFeedModel` (shell-owned in `AidenAppShellView.Built`, refreshes every 60 s while Home shows and on pull to refresh), `AidenHomeComposerSlot`.
- Ranking and states live in `Models/AidenHomeDigest.swift`: needs you > failed > working > news; news cutoff `newsWindow` (24 h) via `since:`; `AidenHomeBotsState` (bots, loading, noBots, offline, none) and `AidenHomeFeedState` (rows, loading, failed, quiet). Never show "Nothing new" while any reading machine has no window and no outcome.
- `AidenBotRoutineFeedReader.shared` is shared with `AidenScheduledRunNotifier`; `beginFetch`/`waitForFetch` dedupe a machine's fetch. `forget(instanceId:)` runs from `purgeInstallationDataUnlocked` (unpair) and on narrowed grants.
- Send: `AidenNewWorkChatFlow.startChat(sending:on:)` creates a Just chat on the last-used machine (`homePicker`, separate from New chat's picker) and the shell sends the prompt when it opens. Each Send is its own Task with its own prompt; failure gives the words back via `AidenDraftSendReconciliation.failedDraft`. `.needsChoice` (no Chats home) only restores and shows a notice. The demo host answers `POST /chats/chat_demo_new/turns` by echoing the sent text and holds that stream's events, so `testHomeSendStartsAChat` sees the words in the transcript.
- See all: Catch Up when something waits, else the Bots tab (no Inbox Bots filter on iOS). "Make your first Bot" opens the Bots tab.
- Deferred: onboarding name field, spec composer controls (U-m4), Hi-bit until #925 merges, `setVoice` wiring (Listening from Home).

## Aurora
- `AidenAuroraState` reducer, `AidenAmbientActivityModel`, renderer, Settings → Appearance → Ambient background (Off/Subtle/Vivid, Subtle default). Home root only. Contrast caps per preset: body 4.5, secondary 3.0; Vivid <= 0.6; Subtle = floor(vivid * 0.35 / 0.6).
