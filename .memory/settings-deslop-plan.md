# Settings deslop plan

Plan: `docs/plans/settings-deslop-plan.md` (Proposed 2026-11-18, revised the same day after two adversarial reviews). Prototype: `docs/plans/assets/settings-deslop-prototype.html`, published as the artifact https://claude.ai/artifact/XrR9Gnj9T3CRYBbvNnxG55 (republish from the same file path). Branch `feature/aiden-settings-ui-cleanup-798e81`. Follows `settings-reorg-plan.md` (sidebar and InfoHint work, complete 2026-11-05).

## What the research found
- A static AST scan of 77 settings components: 240 `Field` rows, 206 with a description (median 15 words, p90 31), 59 `Callout`s, 28 `InfoHint`s, about 19 local row and card helpers. The scan adds up every conditional branch, so word counts are upper bounds. Row counts are `Field` elements in source, so alternative branches of one row count separately and pages without `Field` (Model Pad, Keyboard shortcuts) look lean. It skipped `usage-data.tsx` and the Bot pages. The script lived in the session scratchpad and was not committed; rerun an equivalent scan to measure progress.
- Voice & Speech: 51 of 52 `Field` elements have a description. Storage is the reference page; Model Pad and Keyboard shortcuts are not (802 static words; own heading, rows and search).
- The Settings sidebar doesn't use `SidebarListItem` or `ListSearchField`. `Field`'s Tailwind geometry is overridden by `.settings-page` CSS (two sources of truth), and `Field` also renders in portaled dialogs and eleven Bot pages, so a geometry fix must live in the component.

## Review outcomes (2026-11-18)
- The plan review kept the diagnosis but found disclosures the first draft would have hidden: Supervised apps, connector exposure help, catalog credentials, cloud voice under Automatic, scheduled-task authority, analytics. The Must stay table grew to 30 rows and each gets a behavioral test in phase 1.
- `settingsStatus()` now keeps saved-but-unchecked states gray ("Key saved", "Signed in"); green only for checked states; no location badges.
- Not bugs, by design: the second **Add device** on Control this device (a test asserts both); `settingsDescriptions.bots` copying Approvals (it's an anchor on that page); Read aloud's "latest response" (only the latest reply has a speaker).
- The bug hunt's 13 fixes are listed in the plan's Findings §8, each with a behavioral test (Limits/Approvals/Bot "Mac" copy on Linux, Telegram reset confirmation, per-page scroll keys, Settings links replacing history, Aiden Live flag gating, Live readiness rows, focus kept during Theme mode and shortcut saves, `aria-label`s inside `Field`, Workspace memory switch when global memory is off, Download and Use race, silent failures, the dictation toast, the Browser dialog's single Done). `APPROVAL_MODE_HELP` became `approvalModeHelp(mode, computer)`. Android's Never ask helper now says "computer", as iOS did.
- Not verified: the new scroll E2E in `tests/e2e/settings-unification.spec.ts` and the `guided-setup.spec.ts` regex change. The Cua Space refused to start ("This Mac is almost out of space").
- In a worktree with no `node_modules`, `composer-attachments-mounted.test.tsx` fails on its own environment (it makes a temp folder in `node_modules`, then hits a markdown-plugin preset error). It isn't a code failure.

## Open owner decisions
Page descriptions (remove vs a six-word subtitle), row density (52px), sheets for item details, status words, Telegram setup steps, lint strictness, and sign-off on the must-stay wordings. See the plan's last section.

## Watch out
- 361 `getByText`-style queries across 52 settings test files. Move them to role queries as each page changes, but keep text queries where the text is the claim (must-stay disclosures).
- `docs/settings-design-system.md` quotes row copy in detail. Update it in the same PR as the copy.
- Settings search does every-term substring matching, so descriptions must become keyword phrases, not sentences, when they move to `SETTINGS_DESTINATIONS`.
- Main's Live guards match control names; renaming labels on unguarded pages can change what Aiden Live may press.
