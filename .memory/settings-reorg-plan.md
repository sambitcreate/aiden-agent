# Settings reorganization plan

Branch `reorganize_settings_ui`. Plan: `docs/plans/settings-reorg-and-info-hints-plan.md`. Prototype: `docs/plans/assets/settings-reorg-prototype.html`. Docs and prototype only; no app code changed yet. This answers the deferred UI-55 "needs a prototype first" in `ux-settings-sidebar-devices.md`.

## Decisions (2026-11-05 revision)
- 23 destinations become 17 pages in 5 groups; 19 if `storage` (#731, #773) and `hooks` (#687) land.
- `section` stays the only URL state and selects a tab. New IDs: `appControls`, `peerHosts`. `links` is an anchor on Appearance, not a tab.
- Tab labels keep today's titles. The page stays Connections, so Telegram can go without a rename.
- InfoHint is limited to two short sentences with nothing to click, because focus stays on the trigger. Controls, privacy disclosures and safety notices stay on the page.

## Watch out
- Telegram: `enabled` is the setting and `polling` is the service. After a polling failure `polling` is false with `enabled` true, so re-gate Disconnect before removing the Enable switch.
- Compaction must not use `LimitsSettings.save`; its one `saving` flag drops a second change.
- Telegram's future is unresolved: the security remediation plan says it's being removed, but #747 is open and the feature is on main.
