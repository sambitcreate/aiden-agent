# Settings deslop: less text, one row system

Status: Proposed (2026-11-18), revised the same day after two adversarial reviews (one of this plan, one bug hunt in the settings code). The proposals are not built. The bugs in [Findings §8](#8-bugs-found-along-the-way) are fixed on this branch. Branch `feature/aiden-settings-ui-cleanup-798e81`.

Prototype: [`assets/settings-deslop-prototype.html`](assets/settings-deslop-prototype.html), a static before/after mock of three pages and the proposed row kit, also published as a private [artifact](https://claude.ai/artifact/XrR9Gnj9T3CRYBbvNnxG55). Sample data only.

Builds on the [settings reorganization and InfoHint plan](completed/settings-reorg-and-info-hints-plan.md), which fixed the sidebar (17 pages in 5 groups) and moved some explanations behind `InfoHint`. This plan goes after what that one left alone: the description line under almost every row, state written as sentences, and the pages that still build their own rows and cards.

## Summary

Settings explains itself too much. Of the 240 `Field` rows in the settings components, 206 (86%) carry a description line, and on Voice & Speech 51 of 52 do. A description is the default rather than the exception, so the few lines that matter (data leaving the device, money, unattended authority) read the same as the many that repeat the label.

The second problem is structural. `FieldSet` and `Field` are shared, but the things people manage in lists (providers, connectors, Web Search providers, hooks, rules, paired devices, apps, worktrees, shortcuts, models) each have a hand-built row or card with its own padding, icon tile, separator and hover. The Settings sidebar builds its own nav rows and search field instead of `SidebarListItem` and the shared search field.

This plan proposes:

1. **A copy budget** written into `docs/settings-design-system.md`: labels carry the meaning, a description is allowed only for a consequence the label can't say, in one line of at most 12 words, and state goes into badges and values instead of sentences.
2. **Title-only page headings, and search that finds rows.** The 28 page descriptions become search keywords, and a row index lets search open the exact row, as OpenCode's desktop app does.
3. **One settings kit** in `renderer/components/settings/kit/`: `SettingsRow` (a `Field` with `status`, `value` and drill-in), `SettingsListRow` for items, `SettingsSheet` for item details, `SecretField` for keys and tokens, `SettingsNote` for the disclosures that must stay visible, and one status vocabulary.
4. **A page-by-page copy pass** that applies the budget, with the must-stay list from the reorg plan kept intact.
5. **Guardrails** so the text doesn't grow back: a lint rule on description length in settings files and a review checklist.

Targets once all phases land: at most a third of rows with a description, no description longer than 12 words, no hand-built list rows or cards in settings, and no settings `Callout` that explains rather than warns.

## How this was measured

A TypeScript AST scan of the 77 non-test settings components (`renderer/components/settings/**`, `browser-settings.tsx`, `workspace-settings-dialog.tsx`, `settings-view.tsx`) counted primitives and collected every literal string in a `Field` description, dialog description, `InfoHint`, `Callout` and secondary-text paragraph. The scan adds up every branch of a conditional description, so per-row word counts are an upper bound on what renders at one time. Row counts are `Field` elements in source, so a row rendered in a loop counts once, and alternative branches of one row (Accessibility access, the dictation hotkey, the compaction engine) count as separate elements. A page that doesn't use `Field` (Model Pad, Keyboard shortcuts) shows few rows however much text it has, so read the Rows column beside Static visible words. The scan left out `usage-data.tsx` (About's Usage data row) and the Bot pages under `renderer/main/bots/`, which also use `Field`. Three page audits read the source by hand against the same rubric, and a separate pass read OpenCode's desktop app source (see [How OpenCode does it](#how-opencode-does-it)).

### Totals

| Measure | Count |
|---|---:|
| `Field` rows | 240 |
| Rows with a description | 206 (86%) |
| Description length, median / p75 / p90 / max (the 189 with literal text) | 15 / 22 / 31 / 76 words |
| Rows with a description of 20+ words | 64 |
| Words in `Field` descriptions | 3,280 |
| Words in `Dialog` and `AlertDialog` descriptions | 1,130 (34 alert dialogs, 26 dialogs) |
| Words in other secondary-text blocks of 6+ words (captions, footnotes, card text) | about 2,460 |
| `Callout`s | 59 (about 830 words) |
| `InfoHint`s | 28 |
| Hand-built card surfaces (`rounded-card bg-well`, `settings-card` outside the shared fold) | 32 |
| Local row helpers (`HookRow`, `ProviderCard`, `RuleRow`, `SettingsDeviceRow`, `ItemRow`, `ShortcutRow`, …) | 19 |
| "on this device" | 35 times |
| "encrypted" storage reassurance | 16 times |
| "Optional" | 29 times |

### By page

Static visible words include every branch, dialog and empty state on the page, so compare pages with each other rather than with what one screen shows.

| Page | Rows | With description | Description words | Paragraph words | Callouts | InfoHints | Hand-built cards | Static visible words |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Connections | 31 | 26 | 763 | 422 | 8 | 1 | 4 | 2,371 |
| Voice & Speech | 52 | 51 | 775 | 113 | 6 | 0 | 2 | 1,723 |
| Connectors | 31 | 23 | 501 | 210 | 7 | 3 | 1 | 1,702 |
| Providers | 21 | 14 | 379 | 403 | 0 | 5 | 13 | 1,655 |
| Web Search | 14 | 14 | 385 | 301 | 9 | 0 | 6 | 1,499 |
| Hooks | 6 | 4 | 133 | 200 | 11 | 0 | 2 | 836 |
| Approvals | 13 | 10 | 303 | 64 | 5 | 2 | 1 | 827 |
| Model Pad | 0 | 0 | 55 | 73 | 0 | 4 | 0 | 802 |
| Computers & VMs | 15 | 14 | 307 | 130 | 2 | 2 | 0 | 763 |
| Simulator | 12 | 8 | 191 | 8 | 2 | 0 | 0 | 667 |
| About | 6 | 6 | 208 | 23 | 0 | 1 | 0 | 607 |
| Context & Limits | 10 | 9 | 146 | 130 | 1 | 3 | 0 | 556 |
| Appearance | 7 | 7 | 118 | 52 | 0 | 0 | 0 | 553 |
| Image Generation | 2 | 2 | 106 | 63 | 0 | 1 | 0 | 436 |
| Storage | 2 | 1 | 11 | 36 | 0 | 3 | 1 | 363 |
| Workspace settings (dialog) | 6 | 5 | 17 | 74 | 5 | 0 | 0 | 256 |
| Memory | 4 | 4 | 50 | 51 | 0 | 2 | 0 | 208 |
| Skills | 4 | 3 | 65 | 43 | 0 | 1 | 2 | 199 |
| Scheduled tasks | 7 | 7 | 74 | 24 | 1 | 0 | 0 | 182 |
| Keyboard shortcuts | 0 | 0 | 0 | 41 | 2 | 0 | 0 | 129 |

Voice & Speech counts all twelve voice, dictation, speech and Aiden Live files. Storage is the closest to the target: each row is a label, a value and an action, and each safety rule sits in an `InfoHint`. Model Pad and Keyboard shortcuts only look lean because they don't use `Field`. Model Pad carries 802 static words in its hints, tray and data rows, and Keyboard shortcuts builds its own heading, rows and search field (see [drift](#7-design-system-drift)).

## Findings

### 1. The description is the default

Almost every row has a second line, and most of those lines repeat the label, describe the control's own behavior, or state the default.

| Row | Today | Problem |
|---|---|---|
| Voice → Play sounds | "Short start, stop, and done cues from the dictation pill. Off by default." | The switch shows the default |
| Voice → Shortcut behavior | "Press the global dictation shortcut once to start and again to stop." | Restates the selected option |
| Voice → Models | "Download, remove, and choose your on-device transcription model." | Restates the button |
| Scheduled tasks → Default task mode, Default permission, Default connector access, Default timezone | each row repeats "Default", and one adds "Used when Aiden creates a new task" | The group title should say it once ("New task defaults") |
| Scheduled tasks → Timezone | "An IANA timezone such as America/New_York." | Duplicates the placeholder |
| Memory → each workspace row | "Use memory in this workspace's chats." | Same line on every row |
| Appearance → Theme | "Current theme: Moss" | The selected tile shows it |
| Connectors → Status switch | "Tools from this server are available to the assistant." | Restates the switch |
| TTS → Voice | "Prebuilt Gemini voices. Selecting a voice does not speak." | Neither half helps a choice |
| Provider connector key sharing | "Off by default." | The switch shows it |

Group titles repeat too. "Memory controls" sits under the Memory heading, Image Generation has a "Default model" group whose only row is "Default image model", and Aiden Live has three one-row groups (Chats, Approvals, In Aiden) in a row.

Voice & Speech is the clearest case: 51 of its 52 `Field` elements carry a description. Storage shows the alternative. Its rows are a label, a value and an action, and anything more sits in an `InfoHint`.

### 2. State is written as sentences

Many descriptions swap between long sentences as state changes, which is the job of a badge or a value.

- ChatGPT / Codex (`codex-provider-settings.tsx:366-378`) shows a "Configured" badge and also one of six sentences, such as "A ChatGPT credential is stored. Aiden verifies and refreshes it when a Codex request starts."
- Telegram's status is a text glyph, "● Connected" or "○ Disconnected" (`telegram-settings.tsx:407`), not a `Badge`.
- Control this device describes nine Tailscale route states, each with a badge and a sentence (`remote-access-settings.tsx:89-143`). Some of those sentences carry the only fix the person has (`sudo tailscale set --operator`, Disable Funnel, `:107-118`), and those survive as the row's action line.
- Simulator's status value is a sentence ("Set up. Starts when you open the Simulator tab.", `simulator-settings.tsx:110`).
- Web pages' Extract row has four description branches (`web-page-settings.tsx:110`).
- Memory swaps every workspace row to "Global memory is off; this preference will apply when it is turned back on." (`memory-settings.tsx:91`). That line is status, so it needs a replacement (a Paused badge), not only a cut.
- Scheduled tasks draws its own status dots, and Computer Use shows its state as a coloured icon and a label instead of a `Badge` (`computer-use-settings.tsx:274`). The `color` that its `statusPresentation()` returns is never used.

The badges that do exist disagree. A built-in provider with a saved key shows a gray "Configured" while Codex shows a green one, and "Needs attention" means a missing key (warning) on one and a failed check (red) on the other (`providers-settings.tsx:58`, `codex-provider-settings.tsx:46-47`). Neither "Configured" has been checked: a built-in's means only that a key is saved, and Codex verifies its credential when a request starts (`codex-provider-settings.tsx:376`). The global shortcut's "Active" is green on Voice and gray on Aiden Live.

### 3. Mechanism instead of consequence

Copy often explains how Aiden works internally instead of what changes for the person:

- "Stream structurally complete Telegram-native Rich Drafts while Aiden answers; the persisted final reply completes the preview lifecycle." (`telegram-settings.tsx:522`)
- "After an eligible failure, the same derived query may be sent sequentially to …; Aiden never fans out." (`web-search-settings.tsx:1286`)
- "Pi owns this provider's endpoint, models, credentials, and request transport." (`builtin-provider-editor.tsx:225`)
- Engine names such as "pi-vcc Compaction — Experimental" (`context-settings.tsx:17`), transport names "(stdio)" and "(Streamable HTTP)" (`mcp-settings.tsx:992`), and "runs your system ssh with BatchMode" (`simulator-ssh-hosts.tsx:335`).

Not every long sentence is mechanism. The Tailscale takeover confirmation (`remote-access-settings.tsx:1002`) says Aiden replaces only its own route, preserves every other Serve handler and leaves Funnel unchanged. That is what the person consents to, so it stays, shortened.

The vocabulary drifts as well: "the assistant", "Aiden", "the agent" and "the model" all name the same things on different pages.

### 4. The same reassurance, many times

The scan counts "on this device" 35 times, encrypted-storage reassurance 16 times and "Optional" 29 times. Web Search alone says some form of "never sends a request", "stored encrypted" or "changes nothing" 18 times, including a "Setup is request-free" `Callout` (`web-search-settings.tsx:1503`). The secret-field note exists in at least seven wordings. About's diagnostics say crash dumps are never uploaded three times (a row, its hint and its dialog), Approvals says passwords and money always come to the person three times, Computer Use says Aiden asks in each chat three times, and Text to Speech shows its Google notice twice.

Repetition makes the important version of a sentence invisible. The person stops reading the line that says data leaves the device because the line above it said the same kind of thing about a key that never leaves it.

### 5. Explanations in callouts, footnotes and notices

There are 59 `Callout`s in settings components. Many explain rather than warn: the Aiden Live intro ("Speak naturally and let Aiden act on your screen…"), "Setup is request-free", Callouts used as the body of a row on Voice (`local-voice-settings.tsx:249`, `dictation-shortcut-settings.tsx:132`), and the stacked Callouts in a hook's detail sheet. Footnote paragraphs sit under groups, some positioned with a `-mt-4` margin hack (`aiden-mcp-settings.tsx`, `peer-hosts-settings.tsx:338`). Success notices restate a change the control already shows. Two Voice Callouts stay: the red download error (`local-voice-settings.tsx:142`), and the clipboard note shown where Aiden can't paste for you (Linux has no `accessibilityPaste`, `dictation-shortcut-settings.tsx:277-283`), which becomes a `SettingsNote`.

### 6. Dialog copy

Dialog and alert descriptions add up to about 1,130 words. Confirmations run long: Reset (`about-settings.tsx:300`, 36 words), Remove every Bot computer (`bot-computers-settings.tsx:418`, 40 words), the Controls in chat dialog (`app-control-settings.tsx:126`, 42 words). A destructive confirmation needs the question in the title and at most two short sentences: what is lost, and what stays. Grants and changes to outside configuration need a different shape: what it allows, what it never allows, and what it leaves unchanged. The Controls in chat dialog ends with "This does not allow credentials, terminal access or arbitrary app administration." (`app-control-settings.tsx:130`), and the Tailscale takeover lists what it leaves alone. Both keep those facts.

### 7. Design-system drift

| Pattern | Copies | Where | Shared replacement |
|---|---|---|---|
| Page heading built by the page | 7 | Providers, Skills, Connectors, Hooks, Web Search, Appearance, Keyboard shortcuts | One `SettingsPageHeading` |
| Item rows and cards built by the page | about 19 local helpers, 4 separator recipes (full-width `border-b`, inset `after:`, `Separator`, `border-t`) | providers, Codex card, connectors, Web Search providers and routes, key pool, hooks, rules, devices, peers, apps, SSH hosts, skills, shortcuts, dictionary, memory facts, tasks, worktrees, model manager | `SettingsListRow` |
| Radio cards | 6+ copies, two selected fills (`bg-accent/5` and `bg-control`) | Web Search (5), key pool, Context & Limits, Approvals, Control this device, Add app dialog | `RadioCardGroup` |
| Folds | 9 raw `<details>`, the primitives `Disclosure` in Telegram, a custom expander in Web Search, 6 `SettingsDisclosure` | Providers, provider editor, custom models, connectors, Control this device, Web Search | `SettingsDisclosure`, plus an inset variant for dialogs and sheets |
| Search fields | 5 hand-built | Settings sidebar, Connectors, Web Search, Image Generation, Keyboard shortcuts | `ListSearchField` |
| Filter chips | 3 | Connectors, Web Search, Image Generation | One `FilterChips` (or `Segmented`) |
| Status display | Badge, custom dots, text glyphs, green text, Callouts | Connectors rows, Scheduled tasks, Telegram, sign-in controls, Computer Use | `Badge` through `settingsStatus()` |
| Loading, error and empty states | raw text, raw divs, Callouts, `BotPageSkeleton`, `EmptyState` | most pages | `SettingsLoadState` and inline `EmptyState` |
| Group titles | Title Case ("On-Device Engine", "Dictation Shortcut", "Custom Dictionary") beside sentence case; numbered titles on Telegram; question labels ("Where should your voice be processed?") | Voice, Telegram | Sentence-case nouns |
| Buttons | `medium` and `muted` beside `small` and `filled`; destructive actions in three variants | Voice, TTS, Telegram, Hooks, Simulator, Bot computers | Row actions `small`; secondary `filled`; primary `accent`; one destructive variant |
| Raw form controls | 9 raw `<select>`, raw checkboxes, a font size from `calc(var(--ui-font-size) - 1px)` | Browser settings dialog (`browser-settings.tsx`) | `Select`, `Switch`, `FieldSet` |

Two shared surfaces drift from their own primitives:

- **The Settings sidebar** (`renderer/main/settings-view.tsx:262-340`) doesn't use `SidebarList`, `SidebarListGroup` or `SidebarListItem`. It sets `text-[15px]`, `text-[16px]` and `text-[13px]` inline, uses `rounded-[13px]` rows, hand-builds its search field with a border, shadow and hover border, and shows a non-interactive "All settings" header.
- **`Field` itself has two sources of truth.** Its Tailwind classes set `p-4`, a `minmax(120px,0.8fr) minmax(160px,1.2fr)` grid and `mb-3 px-4` group headers, and `.settings-page` rules in `renderer/styles.css:1642-1700` override them with 12px/16px padding, a `1fr 1fr` grid and a 4px header inset. The 64px minimum height and the even split give long descriptions room to wrap to three lines.

### 8. Bugs found along the way

The bug hunt found these, and this branch fixes each one with a behavioral test:

- **Wrong computer.** Context & Limits told Linux users "Sign-ins and models on this Mac are $0". It now uses `localComputerNoun`, and so do the other places that said "Mac" on Linux: the approval-mode help (Approvals, Workspace settings and the composer chip), the "Allowed on this Mac" group and a Bot's Full access line. Android's Never ask help said "your Mac" too; it now says "your computer", as iOS does.
- **Telegram reset without a warning.** **Reset pairing** cleared the owner at once, so the next person to message the bot became its owner and could run tasks without approval. It now asks first, says that, and keeps focus on the page. The main-process rule that the first message claims the bot is unchanged; the security remediation plan tracks it.
- **Scroll offset carried over.** Opening a page or tab kept the last page's scroll position, because every page shared one scroll-restoration key. Each page and tab now has its own key and opens at the top. The Playwright check for this is written but not yet run (the Cua Space had no disk space).
- **History entries.** Settings links from the keyboard shortcuts dialog, the assistant dock and Aiden Live pushed a new history entry while Settings was open, so **Back to app** stepped through Settings pages. They now replace the entry, and ⌘, does nothing while Settings is open.
- **Aiden Live without the flag.** The Aiden Live page and the assistant's list of Settings pages appeared with `AIDEN_EXPERIMENTAL_GEMINI_LIVE` off.
- **Aiden Live readiness.** An unchecked microphone showed as Ready; Screen and Accessibility showed on Linux, where Computer Use doesn't exist; Scheduled tasks always said On.
- **Focus lost while saving.** The Theme mode radios and each keyboard shortcut's switch, recorder and Reset were disabled during a save, which dropped keyboard focus to the page. They stay enabled now: Theme mode shows the newest choice at once (the latest one wins), and a shortcut ignores a second change until the first is saved.
- **Unnamed controls.** Controls inside `Field` had no name of their own (`Field` names only its group), so screen readers read them as "switch" or "pop-up button": Read aloud and its code switches, the connector editor's fields, three dictation switches, the voice Model picker and the provider editor's fields. Skills' delete buttons now name their skill.
- **Workspace memory.** The Workspace settings dialog offered a memory switch while memory was off for the whole app.
- **Local voice race.** After **Download and Use**, the page could clear the new choice, because settings named the faster model before the model list had refreshed to include it. The list now refreshes first, and the page clears a choice only against a settled list.
- **Silent failures.** Switching or deleting a Telegram profile, saving its provider, and toggling a skill failed with no message.
- **Wrong toast.** Any failed dictation change said the hold shortcut couldn't be set.
- **Two buttons for one action.** The Browser dialog saves as you go, yet showed **Done** and **Cancel**, and Cancel kept the changes too. It now shows only **Done**.

Not bugs, so they moved to the proposals:

- Pages with their own heading show a description that has drifted from `settingsDescriptions`, which then only feeds search. Web Search's map text is never shown and disagrees with the page's own ("Search current information in attended conversations. No startup or background search occurs."). P2 moves that text into `SETTINGS_DESTINATIONS`. The `bots` entry repeats the Approvals description on purpose: it's an anchor on that page.
- The second **Add device** on Control this device is deliberate (`remote-access-settings.test.tsx` asserts both). P5 proposes cutting it.
- Three `InfoHint`s break the two-sentence rule: Model Pad's marker legend (`model-pad-settings.tsx:1178`), benchmark scores (`model-pad-data-rows.tsx:454`) and the discovered-skills paths (`skills-settings.tsx:190`). P5 shortens them.
- The Connectors heading hint "Tool inputs are sent to that service." is a data-leaving disclosure that belongs on the page. P5 makes it visible.

## How OpenCode does it

OpenCode's desktop app (`github.com/sst/opencode`, read at commit `77b322cea`, 2026-11-18) is an Electron shell (`packages/desktop`) around a SolidJS app. Settings lives in `packages/app/src/settings/`, and its strings live in `packages/app/src/runtime/i18n/en.ts`. Only source was read; nothing was installed or run.

**Shape.** Settings is a full-screen `/settings` route with Back to app, a search field and a left list of pages in four unlabeled groups: Preferences, Appearance, Notifications and Shortcuts; then Providers, Models, Extensions, Projects, Worktrees and Servers; then pages added by plugins; then Experimental and About. Below 768px the list becomes a dropdown. A project opens a nested page with its own sidebar. This is close to Aiden's model, with fewer pages.

**Row anatomy.** One `SettingsRow` (`settings/row.tsx`) with `title`, `description`, a trailing control and `align="start"` for tall controls, inside a `SettingsList` card, under an `h3` section title. Cards have an 8px radius and a hairline inset border, rows are split by 0.5px rules, and controls wrap to full width below 640px. Every change saves at once; there are no Save buttons, and a failed save shows an inline Retry.

**Copy.** OpenCode is not leaner everywhere:

- Every page header has a short muted subtitle of 25 to 55 characters, such as "Manage server connections".
- Preference pages describe nearly every row (Preferences 14 of about 15, Appearance 7 of 7, Notifications 9 of 9), and many of those restate the label: Sound → Errors reads "Play sound when an error occurs".
- List pages have no row descriptions at all. Shortcuts, Models, MCPs, Skills, Servers and connected providers are a name, a status and a control, and they read fine.
- Descriptions are short when they exist: median 8 words, longest 111 characters.
- There are no ⓘ hints. Help is three inline links and one footnote under a list.

**Status.** Neutral badges for a provider's source (Environment, API key, Account, Config, Custom), a coloured dot for MCP status with the words kept for screen readers, and a warning-toned **Needs sign-in** button. A source comment states the rule (`runtime/plugin/extension-plugins.tsx:121`): "The switch already shows whether a plugin runs; only the states it cannot show get a label."

**Search.** `settings/search-catalog.ts` is a metadata-only index of 61 entries, 43 with hidden keyword lists. A result opens the page, scrolls to the row with the matching `data-action` and flashes it (`search-reveal.ts`), with a stepped flash under Reduce Motion. The command palette uses the same index, and an E2E test checks that every indexed control exists on screen.

**Where it drifts.** The type requires a description, so rows without one pass `""` and a CSS `:empty` rule hides the slot. The plugin kit has already made it optional. About half the pages use `SettingsRow`; every list page (providers, extensions, servers, worktrees, projects) has its own row class, and the page header is copied by hand into each page. Its strings already show drift ("Customise" beside "Customize").

**What Aiden takes from it:**

1. List pages need no descriptions. A name, a status and a control are enough, which is what `SettingsListRow` encodes.
2. The comment in `extension-plugins.tsx` is the copy budget in one sentence: label only the states the control can't show.
3. Findability lives in a keyword index, not in prose. Aiden's sidebar search reads page descriptions today; P2 keeps that text as search keywords and adds a row index.
4. Make the description optional in the type, and make the list row a variant of the same kit, so that pages don't each grow their own row class.
5. Show inherited defaults as an option: OpenCode's per-project Select lists "Use default (On)", the pattern Aiden's Workspace settings already uses for approvals.
6. Reset to defaults stays disabled until something is overridden, as on OpenCode's Shortcuts page.

Aiden is already ahead on one point: it has `InfoHint` for the one fact that matters, where OpenCode's only choices are inline text or nothing.

## Proposals

### P1. A copy budget

Add this to `docs/settings-design-system.md` as the rule for every settings string, including the Workspace settings dialog and a Bot's Advanced tab.

| Text | Rule |
|---|---|
| Label | Names the thing in the person's words, as a noun or a short verb phrase, in sentence case. If a row needs its description to make sense, rename the label instead. No questions. |
| Description | Optional, and absent by default. Allowed only for a consequence the label and control can't show: what changes for the person, what it costs, who sees it. One line, at most 12 words, no second sentence. |
| Never in a description | The label restated; the default ("Off by default"); the control's own behavior; how Aiden does it (protocols, endpoints, internal names); "This setting…", "Lets you…", "Aiden will…"; reassurance already given once on the page. |
| State | A `Badge` from `settingsStatus()` beside the label, or the current value as secondary text in the control column. At most one action line, and only when the person can act on it. An action line that is the only fix (a command to run, a setting to change elsewhere) always stays. |
| `InfoHint` | Unchanged: one fact, two short sentences, nothing to click. Add a 30-word ceiling. |
| `SettingsNote` | The visible line for data leaving the device, money or unattended authority. At most 15 words per note and one note per disclosure, under the control it qualifies or at the group's foot. A merged group may hold several. |
| `Callout` | Errors, blocked states and safety warnings only. Never an introduction, never the body of a row. |
| Empty state | One line and one action: "No rules yet." + **Add rule**. |
| Success | No notice when the control already shows the change. A toast only for something that happened off screen. |
| Confirmation | Destructive: the title asks the question, and the description says what is lost and what stays, in at most two short sentences. Grants and changes to outside configuration: what it allows, what it never allows and what it leaves unchanged, in at most three. |
| Words | "Aiden" for the app, "your chat model" for the model, "this Mac" through `localComputerNoun`. No "the assistant", "the agent", "Pi", "pi-vcc", "LLM", "stdio" or "config.json" in visible copy. |

### P2. Title-only page headings

`SettingsPage` renders the title, an optional `InfoHint` and optional actions, and no description. One `SettingsPageHeading` replaces the seven hand-built headings, so `OWN_HEADING` and its drifting copies go away. The 28 `settingsDescriptions` strings become search keywords on `SETTINGS_DESTINATIONS`, where sidebar search keeps using them. The command palette matches titles and keywords only (`command-palette.tsx:329`), so it gains them. Two details change how they move. Today's descriptions take the computer noun (`settings-view.tsx:202`) while `SETTINGS_DESTINATIONS` is a static array, and search matches every term as a substring (`settings-section.ts:469-481`), so whole sentences would make results noisier. Turn each description into a few noun-free keyword phrases instead of moving the sentence.

Before removing any heading text, check whether a control points at it and whether it is a disclosure. Three are:

- Hooks: "Run your own shell commands… Each one runs only after you approve it."
- Apps using Aiden: apps "read your chats and work in them".
- Web Search: the heading paragraph describes the master switch (`aria-describedby="web-search-master-description"`, `web-search-settings.tsx:1714`) and says no search runs at startup or in the background.

Each becomes a `SettingsNote` under the heading, and the Web Search switch points `aria-describedby` at its note.

macOS System Settings opens each pane on its title and first group. OpenCode keeps a short muted subtitle on every page; if the owner prefers that, the fallback is one line of at most six words, drawn from the same search text.

**A row index for search.** Cutting descriptions shouldn't make settings harder to find. Following OpenCode's catalog, add a `SETTINGS_ROWS` index next to `SETTINGS_PAGES` (section, row id, label, keywords) and mark each indexed row with `data-settings-row`. A search result for a row opens its tab and scrolls to it, reusing the anchor scroll that `links` and `bots` already use, instantly under Reduce Motion. Many rows render only in some states (Extract, Translate, a dedicated key), and P4 moves others into folds and sheets, so the index follows three rules. A row in a fold opens the fold first. A row that lives in a sheet is not indexed; the list row that opens the sheet is. A conditional row is indexed under the row that reveals it. Each entry names the state it needs, and the E2E check seeds that state before asserting the row renders. The index starts with the rows people search for most and grows as the copy pass touches each page.

### P3. One settings kit

Put the settings-only pieces in `renderer/components/settings/kit/` and keep the generic primitives in `ui.tsx`. Each component replaces patterns listed in [design-system drift](#7-design-system-drift).

| Component | What it is | Replaces |
|---|---|---|
| `SettingsPageHeading` | Title, optional hint, optional actions | 7 page-built headings |
| `SettingsGroup` | `FieldSet` plus `footer` (for a `SettingsNote`) and `empty` (an inline `EmptyState`) | Footnote paragraphs, `-mt-4` hacks, empty-state divs |
| `SettingsRow` | `Field` plus `status` (a Badge after the label), `value` (the current value as secondary text), `leading` (an icon tile) and `onOpen` (the row drills into a sheet, with a chevron) | Branching descriptions, `DetailRow`, `FormRow`, `ModelPadDataRow` |
| `SettingsListRow` | Leading tile, title with status, one meta line, a trailing slot for one control (switch, `Segmented`, shortcut recorder or button) or a chevron, and an optional ⋯ menu; inset separator starting after the tile. A row with a control opens its sheet from the name, which is a button (as hook rows do), so a switch never sits inside a clickable row. | Most of the 19 local row and card helpers. Approval rules (a `Segmented` plus Remove) and shortcuts (a recorder plus a switch) put the second action in the ⋯ menu. |
| `SettingsSheet` | The detail view for one item: header with icon, name and status; `SettingsGroup`s; destructive actions last | Provider editor, connector editor, hook detail sheet, device and app details, per-model `<details>` |
| `SecretField` | One key or token. Saved state as a "Saved" badge with **Replace…** and **Remove**; an empty state as a password input with **Save**; one hint, "Encrypted on this device. Aiden never shows a saved key again." Where no keyring is running (Linux), it shows "Secure storage is unavailable…" (`secure-storage-core.ts:27-31`) instead of the input. The Web Search key pool keeps its own ordered, rotating editor. | 16+ encrypted-storage lines in seven wordings, write-only explanations |
| `SettingsNote` | Icon plus one line, for the [must-stay](#must-stay-visible) disclosures | Privacy paragraphs, "What leaves this device" rows written by hand |
| `RadioCardGroup` | Borderless radio rows with the list-selection fill, one tab stop and arrow keys from `radio-navigation.ts` | 6+ radio card copies with two selected fills |
| `SettingsDisclosure` | Unchanged, plus an `inset` variant for use inside dialogs, sheets and cards | 9 raw `<details>`, Telegram's `Disclosure`, Web Search's expander |
| `ListSearchField`, `FilterChips` | The existing search field, plus one chip row | 5 search fields, 3 chip rows |
| `SettingsLoadState` | Skeleton rows while loading; an inline error with **Try again**; nothing else | Raw "Loading…" text, alert divs, Callouts with Retry |
| `settingsStatus()` | Maps a state to one label and one colour. Green only for a state Aiden has checked (Connected, Active, Installed). Gray for saved but unchecked (Key saved, Signed in) and for Off, Offline and Paused. Warning for Needs setup, red with the short reason (Sign-in expired, Port in use), blue for Update available. No location badges such as "On this Mac": a local provider's address can be edited to point anywhere. | Six badge vocabularies, dots and glyphs |

Fix `Field` while the kit lands: move its geometry into the component so there is one source, add `--settings-row-min-height` (52px), and widen the label column to `minmax(0, 1.25fr) minmax(0, 1fr)`. Shorter descriptions make the 64px minimum and the even split unnecessary. The geometry can't live in `.settings-page` CSS alone. `Field` also renders in portaled dialogs (Workspace settings, the provider key dialog, the scheduled task editor), in `usage-data.tsx` and on eleven Bot pages under `renderer/main/bots/`, and the proposed `SettingsSheet` is portaled too. Moving it into the component changes those surfaces as well, so phase 1 checks each of them at 390, 600 and 1280px.

The Settings sidebar moves to `SidebarList`, `SidebarListGroup`, `SidebarListItem` and `ListSearchField`, and drops the "All settings" header. Check that `SidebarListItem` keeps a visible `focus-visible` ring before the swap, since today it relies on a fill.

### P4. Structure patterns

- **Lists open sheets.** A list row shows name, status and one meta line, with at most one trailing control. Edit forms, tools, exposure, versions and Remove live in the item's `SettingsSheet`. Connector rows today carry Edit, a switch, Trash and the exposure controls inline; skill rows carry Edit, a switch and Trash.
- **Summary rows instead of embedded lists.** "4 tasks · 1 failed ›" for Scheduled tasks, "12 shown · 3 hidden ›" for model visibility, "3 connected · Manage ›" for Web Search providers.
- **Show rows only when they do something.** Hide the Voice Engine row while it reads Ready, Phone setup after the first device is paired, and the "2. Scan to finish" row that has no control.
- **Folds never hold a must-stay line.** A disclosure stays on the first screen even when the rows it qualifies move into a fold or a sheet, and a sheet repeats it next to its control.
- **One Advanced fold per page**, at the bottom, with a summary that names what's inside ("Custom endpoints · chat titles · catalog").
- **Merge one-row groups.** Aiden Live's Chats, Approvals and In Aiden become "What Live can do". Image Generation's default model joins the top of Models. Memory's Workspaces joins What Aiden remembers, with "n facts ›" per workspace.

### P5. Page by page

Each row names the first screen to aim for and the largest cuts. The page audits hold the full before-and-after lists, with line references, and the phase PRs should work from them.

| Page | First screen | Largest cuts |
|---|---|---|
| Providers | One "Your connections" group of `SettingsListRow`s (built-in, Codex and custom alike), **Connect another AI** in the heading, an Advanced fold | Codex's six state sentences; the 40-word catalog description becomes a value ("Updated Nov 15") and one note, still inside Advanced; three nested folds in the custom endpoint dialog |
| Model Pad | Unchanged | Two hints shortened to two sentences |
| Context & Limits | Compaction engine with one privacy note, then the wait select | Cache-warming text (73 words over two rows) to one line and a hint; "Local" with an Experimental badge instead of "pi-vcc Compaction" |
| Skills | Global switch, then Your skills | Heading copy; "Skills are off…" restating the switch; the discovered-skills paths hint to two sentences; an `EmptyState` with **New skill** |
| Connectors | Your connectors (name, status, access badge, switch ›), then the directory | Exposure help shortened but kept beside its `Segmented` (it changes with the choice, describes the control, and is on the must-stay list), in the sheet once rows open sheets; status switch copy; five secret notes; the 35-word OAuth client text into a "Custom OAuth" fold; "Tool inputs are sent to that service" made visible |
| Hooks | Pause all, then the scope groups (already close) | `FormRow` and `DetailRow` become `SettingsRow`; up to three stacked Callouts in the sheet become one |
| Web Search | One group: the switch with a status badge and "Searches go to X", a Providers summary row, a Routing fold, Web pages, an Access row with both grant buttons | Its own header, with its attended-only line kept as a note under the switch, and the On/Off label; route and readiness shown three times; the provider browser four levels deep (overview, browse, detail, dialog) down to two; "Setup is request-free" |
| Image Generation | Providers, then Models (default row, search, list) | The duplicate dialog line; "Default model" group |
| Memory | Use memory, then the workspace list | "Memory controls" title; the per-row repeated line, with the global-off line becoming a Paused badge (Workspace settings uses the same rule since this branch: a disabled switch and one line); the footer paragraph |
| Approvals | The mode radios with the lock note directly under them, Rules, an Advanced fold | Three Always allow / Always ask / Blocked groups become one Rules group with one **Add rule**; three empty states become one; the 48-word Approval model description becomes one note |
| Scheduled tasks | The master switch, a tasks summary row, then New task defaults: Default permission and Default connector access stay on the page, and mode and timezone go into a fold | "Default …" prefixes; the timezone free-text field becomes a `Select` |
| Computers & VMs | macOS access with a status badge and **Open Mac permissions**; the data note as the last row | "asks in each chat" said three times (Always allow keeps its consequence, `computer-use-settings.tsx:67`); base-computer text to one line |
| Simulator | Permissions with status, Workspace, Helper tools fold, SSH hosts, Remove | Sentence-length statuses; up to seven lines per SSH host row |
| Voice & Speech → Voice | Voice input (Processing, Language, Translate), Dictation, On-device engine | 51 of 52 descriptions down to about 4; Callouts as row bodies, except the clipboard note where Aiden can't paste; Active model and Models become one "Model ›" row. The Linux hold-shortcut setup line depends on the choice and the platform, so it stays beside the control. |
| Voice & Speech → Text to Speech | Read aloud, key with a status badge, voice and delivery, privacy | The Status row; the Google notice shown twice; "never read back into settings" |
| Voice & Speech → Aiden Live | Availability with the Live mark and Beta badge, then the groups | The intro Callout; three one-row groups |
| Connections → Control this device | The access switch with a status badge, then devices with **Add device** as the group action | Nine Tailscale route sentences down to a badge plus the fix where there is one; the second **Add device** (on purpose today: `remote-access-settings.test.tsx` asserts both buttons, so the cut changes that test); "Identity remains 3f9a2c." |
| Connections → Control other devices | Paired computers with **Add device** as the group action | Three secondary lines per row down to one |
| Connections → Apps using Aiden | Unchanged layout (closest to the spec) | The 50-word footnote down to one note, since it is the only statement of what a Supervised app may do; the separate "Start again" row |
| Connections → Telegram | Bot token, a status row (badge, one Connect or Disconnect, owner), the security warning | Six "How to connect" steps; "Rich Drafts" copy; glyph status; numbered group titles move into a setup sheet |
| Appearance | Theme, Chat width, Sidebar, then Chat split into display and "Sending & links" | "Current theme: Moss"; the width and sidebar sentences; raw `<section><h2>` titles that don't match `FieldSet` titles |
| Keyboard shortcuts | Search, then rows with the recorder | Its own heading; two badges per row ("Global · Active", "Default") down to "Custom" when overridden, keeping "Global · Unavailable", which the switch can't show |
| Storage | Unchanged (the reference page) | The `EmptyState` moves inside its card |
| About | Version with a status badge ("Up to date", "1.4.2 ready") | Update-feed mechanism text; "never uploaded" said three times (Usage data keeps what it sends and never sends); full-width rules stacked on inset separators |
| Workspace settings (dialog) | Unchanged tabs | Per-tab intros; the folder path shown twice; the same line on every grant row |
| Browser settings (dialog) | Two `FieldSet`s, New tabs and Profiles | Raw selects and checkboxes; a third "Open links in" control that should link to Appearance |

### P6. Guardrails

- **A lint rule**, `aiden/settings-copy-budget`, scoped to `renderer/components/settings/**`, `browser-settings.tsx`, `workspace-settings-dialog.tsx`, `usage-data.tsx`, `renderer/main/settings-view.tsx` (where the sidebar's inline sizes are) and `renderer/main/bots/bot-advanced.tsx`, which P1 covers. It flags a literal `description` longer than about 80 characters, `InfoHint` text over 30 words, raw `<details>`, `<select>` and `<input type="checkbox">`, and inline `text-[Npx]` sizes. It starts as a warning and becomes an error once the copy pass lands. It is lint, not a test; the repo's rule against tests that grep production source stays as it is.
- **Tests query by role.** The settings tests make 361 `getByText`-style queries across 52 files, many on description text. Each phase PR moves the queries it touches to `getByRole(…, { name })`, which ties tests to labels (which stay stable) instead of descriptions (which this plan removes). Text queries stay where the text is the claim: the must-stay tests, and tests such as `web-search-settings.test.tsx:443` that prove a disclosure renders.
- **A review checklist** at the end of `docs/settings-design-system.md`: label carries the meaning, no description over 12 words, state in a badge, one note per disclosure, no page-built heading, row, fold or search field.

## Must stay visible

These stay on the page under the existing rules. The plan only shortens them, and the phase PRs confirm each new wording with the owner. The review added twelve rows the first draft missed, so phase 1 starts with a sweep of every authority, data and billing string in settings and adds anything still missing before any copy changes.

Each row gets a behavioral test in phase 1. The test renders the page in the state that shows the disclosure and finds it, so a later copy pass can shorten the line but can't drop it.

| Disclosure | Where | Proposed wording |
|---|---|---|
| Recordings go to a cloud provider | Voice → Processing, and Automatic whenever it resolves to a cloud provider | "Recordings go to {OpenAI \| Google}." for the provider in use. Google's access scope ("Models + transcription") stays visible. |
| Transcript cleanup uses the chat model | Voice → Clean up transcript | "Sends the transcript to your chat model first." |
| Text to Speech goes to Google and may be billed | TTS | "Sends the selected response to Google, even from local models. Google may bill you." |
| Computer Use sees and acts | Computer Use | "Allowed chats send screenshots and screen text to your model, and Aiden can click and type." / "Aiden doesn't keep it; your provider's data policy applies." |
| Always allow skips the prompt | Computer Use → Always allow in every chat | "Aiden can then use your computer in any chat without asking." |
| Extract mode sends page text to Cloudflare | Web Search → Web pages | "Extract sends page text and field names to Cloudflare, never your chat." |
| Searches run only when you're there | Web Search, under the switch | "No searches at startup or in the background." |
| Where searches go, and billing | Web Search | "Searches go to {first}; if it fails, to {next}." naming each fallback, and "{Provider} bills these searches." for every paid or quota provider on the route (`routeMayUseBilling`), not only OpenAI |
| Bot and schedule grants | Web Search | "{Bots and schedules \| Schedules} need their own Web Search grant.", keeping the `capabilities.bots` branch |
| Approval model receives actions | Approvals → Approval model | "Auto sends each action here, minus typed text, passwords and cards." |
| Passwords, codes and money always come to you | Approvals, once | Unchanged, under the mode radios |
| An older setting lets routines skip approval | Approvals → Routines go ahead without asking, while it is on | "Routines skip your OK. Once off, it can't be turned back on." |
| New scheduled tasks can act unattended | Scheduled tasks → Default permission, Default connector access | "Full edits files and runs commands without asking." / "New Full tasks get every enabled connector." Outside any fold. |
| Telegram turns run unattended | Telegram | "Turns run unattended and can edit files and run commands. Only the paired owner starts them; Disconnect stops them at once." / "Messages go through Telegram and your AI service." |
| Who becomes the Telegram owner | Telegram → Reset pairing confirmation | "The next person to message your bot becomes its owner." |
| Hooks run your commands | Hooks | "Hooks run your shell commands, each only after you approve it." |
| Apps can read and act | Connections → Apps using Aiden | "Apps you add can read your chats. Supervised apps follow the workspace's approval mode." |
| Model catalog update | Providers → Advanced | "Contacts models.dev (no credentials) and each provider's catalog with your sign-in. No prompts or chats." |
| Custom connectors can use a provider key | A provider's key sharing switch | "Custom connectors you approve can use this key." |
| Context may be sent to the chat model | Context & Limits | "Local compaction may send earlier details to your chat model." |
| Paid cache warming | Context & Limits | "Paid one-token requests keep the cache warm during long runs." |
| Connector tool inputs go to the service | Connectors | "Tool inputs go to the service you connect." (moves out of the hint) |
| What the model can reach on a connector | Connectors, beside each exposure choice | One line per choice, for example "Chats, Bots, schedules and the Assistant can't use it." for Off |
| Simulator streaming to phones | Simulator | "Paired phones can watch, tap and shut down simulators." |
| Chats can drive simulators | Simulator → Agent access | "Chats can tap, type and install apps. Downloads a helper from npm." |
| Paired Macs can drive simulators | Simulator → Share with paired Macs | "Paired Macs you allow can view and drive these simulators." |
| Live can use chats and the window | Aiden Live | "Live can read, send to and open chats." / "Live can use this window, and asks before deleting or signing out." / "It never answers approvals or touches keys." |
| Live voice approvals have limits | Aiden Live → Voice approvals | "Voice allows once. Passwords and payments still need a tap." |
| macOS download size and source | Bot computers | "Downloads macOS {version} from Apple ({size}); needs {free} free." |
| Anonymous usage data, on by default | About → Usage data | "Sends anonymous usage and crash reports, never chats, files, keys or paths." |

## Phases

Each phase is one PR unless noted, and each updates `docs/settings-design-system.md` and the tests it touches.

1. **Kit and rules.** Sweep every authority, data and billing string and finish the must-stay table, then add one behavioral test per row. Add the kit components, `settingsStatus()`, the copy budget and checklist in the design doc, and the lint rule as a warning. Fix `Field`'s double geometry and check the dialogs and Bot pages that use it. No page changes yet beyond the components' own tests.
2. **Shell.** Title-only headings through `SettingsPageHeading`, descriptions moved to search text, the first `SETTINGS_ROWS` entries with row-level search, the sidebar on `SidebarListItem` and `ListSearchField`, and one status vocabulary. Small, and visible on every page.
3. **Copy pass**, four PRs by sidebar group: Models & Context; Capabilities; Autonomy & Devices; Voice & Channels with App. Each applies the budget, moves state into badges, deletes explanatory Callouts and footnotes, and moves tests to role queries.
4. **Lists and sheets**, two PRs: Providers, Connectors, Skills and Hooks; then Web Search providers, Connections (devices, peers, apps), Memory, Scheduled tasks, Keyboard shortcuts and the dictionary.
5. **Outliers.** Telegram's setup, Web Search's header and provider browser, the Browser settings dialog, the Workspace settings dialog, a Bot's Advanced tab and the transcription model manager.
6. **Lock it in.** The lint rule becomes an error.

## Risks and checks

- **Accessibility.** Descriptions are wired as `aria-describedby`, so removing them removes context for screen readers. The labels have to carry the meaning, and the facts that move into an `InfoHint` stay reachable because the hint opens on keyboard focus. Some controls point `aria-describedby` at text outside their row (the Web Search switch at its page heading, the connector exposure `Segmented` at its help), so check for references before deleting text. `Field` names only its group, so a control inside it needs its own `aria-label`. Keep every `focus-visible` ring.
- **Model-visible text.** The assistant reads `resources/aiden-help/manifest.json`, `main/services/aiden-app-knowledge.ts` and `main/services/aiden-app-navigation.ts`. None of them reads `settingsDescriptions` today, but each phase PR checks them for quoted copy and page names. `main/services/app-controls-core.ts:150-208` keeps its own descriptions of chat controls, which the model and paired phones see. They are out of this plan's scope, but a copy pass must not leave them contradicting the page.
- **Aiden Live guards.** Portaled content inherits `data-live-guard` only through `useLiveGuardAttributes` (`live-guard.tsx`), and `data-live-safe` doesn't cross a portal at all (`settings-view.tsx:189-197`). Build `SettingsSheet` on the shared `Dialog` root and test it under a guarded page. Main's guards also match control names (allow, enable, grant, approve, pair), so renaming a label on an unguarded page (Memory, Skills, Keyboard shortcuts) can weaken what Live may press. Check each rename against the guard rules.
- **Docs that quote copy.** `docs/settings-design-system.md` describes many rows in detail (for example the 11 languages named in the voice approvals description). Update those notes in the same PR as the copy.
- **Onboarding** shares the provider connection choices and some wording. Keep the two in step.
- **Phones.** The iOS and Android apps have their own settings screens and are out of scope. The copy budget can apply to them later as a separate pass.
- **E2E.** `settings-unification.spec.ts` checks for horizontal overflow of at most 2px on every page at 1280, 600 and 390px (`:458-474`). Keep that guard as it is, and extend the sweep to portaled sheets, which sit outside `.settings-responsive` today. The spec also asserts copy this plan removes ("Current theme: Dusk", `:215`; `/Optional paid one-token requests/`, `:547`), so the phase that removes each line updates those assertions to a role query.

## Decisions for the owner

1. **Page descriptions.** Remove them from screen and keep them as search text (recommended), or keep OpenCode's short subtitle of at most six words.
2. **Row density.** 52px rows with a wider label column (recommended), or keep 64px rows and only cut text.
3. **Item details.** Sheets for every list item (recommended; the Workspace settings dialog and a Bot's Advanced tab already work this way), or inline expansion.
4. **Status words.** One "Connected" for every checked state, or a word per noun (Active, Allowed, Installed) from the same colour map (recommended). Either way a saved but unchecked key or sign-in stays gray.
5. **Telegram setup.** Keep its numbered steps inside a setup sheet (recommended), or flatten them into rows.
6. **Lint rule.** Start as a warning and become an error in phase 6 (recommended), or block from phase 1.
7. **Must-stay wordings.** Approve the table's wordings before phase 3 starts, since each one shortens a disclosure.
