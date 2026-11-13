# Bot creation and settings (bot UX Phase 5) — 2026-11-12

Branch `claude/aiden-bot-ux-simplify-cdd73d`, Phase 5 of `docs/plans/bot-ux-simplification.md` (see its "Phase 5 notes" for the field checklist, deviations and phone follow-ups). Desktop only; no Remote protocol revision, phone wire unchanged.

## Create
- First Bot: `onboarding-bots-step.tsx` calls `bots:createFirst` (main `botStarter().startFirst`, idempotent under the first-Bot creation key) on the last onboarding step when Bots are on and the store is empty. "Chief", random look, `BOT_STARTER_INSTRUCTIONS`, no description; the intro asks what it should help with. Finish waits while it is made, then opens its chat. Gallery tile art: `BotsArt` in `onboarding-art/control-art.tsx` draws that chat.
- New bot: `bot-create-flow.tsx` (one field "Name your Bot", look picker, Return submits; no model → Set up… and creates nothing). Create menu: `bot-create-menu.tsx` (`BotCreateMenu`, `useBotCreateDialogs`), in the Bots sidebar header and the empty Bots page.
- Templates: `bot-templates-dialog.tsx`; presets are versioned in `renderer/shared/bot-presets.ts`; `bots:createFromPreset {presetId, version}` refuses a stale version (`BOT_TEMPLATE_STALE_MESSAGE`); `bots:presetBots` maps preset → existing Bot for Open. Template routines are added paused.
- `update_bot`: `main/services/bot-settings-changes/` (tool, service, service-main). Allowed: name, description, look, instructions, selfWakeUps, interruptions, model. Applied in an owner-started turn (receipt + CAS Undo → Restored), held otherwise (Needs-you card Apply/Edit/Dismiss). Phones drop the `settings_change` entry (remote projection default branch).

## Settings in the side panel
- Five fixed tabs outgrow the 440px panel: the Bot panel shows the "Open tabs" list past four tabs, and `WorkbenchTabStrip` scrolls the selected tab into view (shared with the workspace panel).
- `bot-advanced.tsx` `BotAdvancedTab` is the workbench's last tab (`BOT_PANEL_TABS` in `bot-panel-context.tsx` ends with "advanced"). `panel.show("advanced", { botId, section })` with section `instructions | quiet-hours | model` → `sectionRequest`, dropped when the routed Bot changes.
- Header: look popover ("{name}’s look": `BotLookPicker`, Default look, Choose/Remove photo) and the name button "Rename {name}" → Input "Name".
- Groups: Notifications (dailyLimit 0 ⇔ off; `lastDailyLimit` restores), Open work, Memory, Model (+ Routine models row → Routines tab, Health), Computer, Permissions (selfWakeUps; messaging via `botMessagingSwitchOn/Patch` in `bot-messaging-fields.tsx`; Approved Bot pairs → `BotPeerManagerDialog`; Approvals row), Replies (Telegram), Instructions dialog, How other Bots see it, Tools, Spending, Clear.
- Batched: name, description, access draft (model + tools) behind region "Unsaved changes" (Revert/Save, toast "Saved"). Drafts live in the module map `unsavedDrafts` per Bot; `forgetUnsavedBotSettings()` clears it (tests call it in beforeEach).
- Old links: `botPageTarget` in `bot-page-search.ts`; `BotPage` in `bots-view.tsx` redirects panel targets with replace. Open work and learning stay pages; their Back → chat + Advanced.
- ••• menu (`bot-menu.tsx`): pin, pause/unpause, delete only. Chat header pill is "{name} settings" (aria-controls the panel).

## Settings → Approvals
- Page id `approvals` (was `botsApprovals`), tabs approvals + appControls, anchor `bots`. `isSettingsAnchor` / `settingsTabFor` in `renderer/shared/settings-section.ts`; `settingsLocation` adds `aidenSettingsAnchor` state for any anchor; `SettingsPageTabs` selects the anchor's host tab.
- Bot messaging switch lives in `approval-mode-settings.tsx` Advanced and scrolls into view for the `bots` anchor. `bots-settings.tsx` is deleted.

## Tests
- `renderer/main/bots/bot-advanced.test.tsx` (test:bots). Harness note: going to /settings in `mountWithBotRouter` re-renders BotsView, which redirects to a chat; tests use a `BotsPagesOnly` wrapper. A dialog opened from a link hides the tabs from the a11y tree (`{ hidden: true }`).
- E2E updated: bots-starter (New bot → chat, onboarding → first message), bots-persistence (real runtime, macOS), guided-setup, connector watches, routine models, open work, peers, bot-plans tour, settings-unification. Cua Space failed to create (unpigz I/O) for Phases 4 and 5; not run locally.
