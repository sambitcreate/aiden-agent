# Settings reorganization plan

Implementation branch `feature/settings-reorg` (plan and prototype came from `reorganize_settings_ui`). Plan: `docs/plans/settings-reorg-and-info-hints-plan.md`. Prototype: `docs/plans/assets/settings-reorg-prototype.html`. Phases land on the implementation branch; the plan holds status. This answers the deferred UI-55 "needs a prototype first" in `ux-settings-sidebar-devices.md`.

## Decisions (2026-11-05 revision)
- 23 destinations become 17 pages in 5 groups; 19 if `storage` (#731, #773) and `hooks` (#687) land.
- `section` stays the only URL state and selects a tab. New IDs: `appControls`, `peerHosts`. `links` is an anchor on Appearance, not a tab.
- Tab labels keep today's titles. The page stays Connections, so Telegram can go without a rename.
- InfoHint is limited to two short sentences with nothing to click, because focus stays on the trigger. Controls, privacy disclosures and safety notices stay on the page.

## Watch out
- Telegram: `enabled` is the setting and `polling` is the service. After a polling failure `polling` is false with `enabled` true, so Disconnect is gated on `enabled`, and the Enable switch is gone (commit `d26b8edf6`, droppable).
- Compaction must not use `LimitsSettings.save`; its one `saving` flag drops a second change.
- Telegram's future is unresolved: the security remediation plan says it's being removed, but #747 is open and the feature is on main.

## Phase 4 landed (2026-11-05)
- `ProviderInfo` and `RemoteAccessInfo` are gone, replaced by `InfoHint`; `assistant-settings.tsx` is deleted; Text to Speech has three groups; Skills search shares `list-search-field.tsx` with workspace settings at the same 8-row threshold.
- The Aiden Live Operate Aiden row is gone. Its Scheduled tasks and Global shortcut rows stay.
- `routeRecipientSummary` stays beside the current search route, not in Privacy as the prototype shows, because it changes with selection.
- Context & Limits: only the override detail moved to a hint. The "may be sent to your chat model" footer and the model-token footer stay visible.
- `InfoHint` rules now live in `docs/settings-design-system.md`.

## Phase 5 landed (2026-11-05)

- `SettingsDisclosure` in `renderer/components/ui.tsx` is the one shared fold: children stay mounted, and a fold that gains an override reopens through a render-phase latch unless the person closed it.
- `FieldSet` takes an `action` for a group-heading control. The page heading takes no controls, so **Add model by ID…** sits in the Image Generation Models group heading and opens a `Dialog`.
- Web Page Extract shows a short row until `configured` (account ID, a key, or Extract on). **Set up Cloudflare…** opens the form; "What leaves this device" shows with the form, following the prototype note.
- Compaction engine stays radio cards rather than the prototype's Select: the plan table does not require it and `limits-settings.test.tsx` expects a radiogroup.
- Dictation shortcut is a Select or a plain row; Simulator Helper tools fold with a badge while Remove stays outside.
