# Settings design system

Settings adapts the Appearance page and the desktop UI references in `chatgpt-desktop-ui-inspiration.md` and `chatgpt-ui-element-specimen.html`.

## Composition

- `SettingsPage` owns the page heading and description. Destinations with their own header/actions use `settings-page-heading` and suppress the wrapper heading. Keep one destination heading; group titles describe a distinct group rather than repeating the page title.
- `FieldSet` supplies `settings-group`, `settings-group-title`, and `settings-group-card`. Existing custom connection lists use `settings-card` for the same surface.
- `Field` supplies a label/description group, inset separator, and `settings-field-control`. Default rows put controls at the right; vertical rows suit editors, lists, previews, and complex forms. Direct switches retain a trailing column even on narrow windows.
- Use the shared Button, Switch, Input, Select, and other control primitives. Inputs keep their resting border and use background/caret focus states. Non-text controls retain a neutral `--focus-ring` outline.

## Tokens and adaptation

The `.settings-responsive` container defines `--settings-card-radius`, `--settings-card-fill`, `--settings-row-inset`, and `--settings-row-gap`. They derive from Aiden's semantic theme tokens; Appearance cards use these same variables. Shared heading metrics are 26/32px, with secondary copy and 26px spacing before content. Groups use soft neutral surfaces, inset separators, and restrained elevation, with no outline (Untitled borderless surfaces). Status appears in semantic labels, icons, and fills, never decorative colored borders.

Rows respond to their allocated content width, not the whole window. Below 540px complex controls stack under descriptions, while switches remain on the right. Grid groups must use `minmax(0, 1fr)` / `grid-cols-1` so long provider names or endpoints cannot force horizontal overflow. Controls and text must stay reachable without horizontal page scrolling.

Model Pad is one card: a header (model count with an ⓘ hint for the marker language and keys, the "Height: <score>" metric chip while a visible height comes from benchmarks or suggestions are previewed, naming the score those heights came from or "Height: mixed" when they differ; switching it re-ranks saved benchmark heights that have the new score as one undoable action, then Add, Arrange and ⋯), the Pad square with its axis captions and the suggestion bar under it, and an "On your Pad" tray (with an ⓘ noting that positions of temporarily unavailable models are kept) beside it, no taller than the square, that stacks under the square when the card is narrower than 640px (a container query on the card, not the window). Nothing overlays the square except its markers and the empty-Pad quick starts. Explanations live behind the shared `InfoHint` (`renderer/components/ui-info-hint.tsx`) rather than paragraphs on the page. A "Data" settings group under the card has two inset-separator rows, each a label with its ⓘ, one secondary line and trailing actions: **Benchmark scores** (source and fetch date with a warning-tone "Out of date" chip past 60 days, or "Not connected", or the error text; a "<n> of <m> models" button opening the coverage popover, Fetch latest, and a ⋯ menu with Replace key… and Disconnect; Connect or Replace key… reveals an inline password key row with Connect & fetch and a "Get a key" link, and the stored key is never shown back) and **Measured speed** (the measured count or "Nothing measured yet", with Clear… behind a confirmation). The square is sized from the actual scrollport and remaining column (`measureModelPadAvailableSize`), capped at 30rem; on very short or highly zoomed windows it keeps a usable canvas (160px when the scrollport allows) and the Settings page scrolls.

## Workspace labels

`AppearanceConfig` owns `showWorkspacePaths` (default false) and `workspacePathFormat` (`middle`, `end`, or `start`). The Appearance page no longer renders controls for them — the fields stay in the schema so stored preferences keep applying. Older v1 preferences normalize to hidden paths. The sidebar and picker follow persisted/live-preview changes, and measure their own text allocation so CSS does not replace the selected truncation with end clipping. Preserve legal whitespace, emoji, and combining characters. These strings are display-only; filesystem operations always use the full original path.

Duplicate workspace names receive a short stable ID suffix in both visible and accessible names. Worktree branches and folderless workspace identity remain available when paths are hidden. Destructive confirmation and permission-scope review still identify their exact filesystem target.

## Chat width

`AppearanceConfig.chatWidth` (`narrow`, `default`, `wide`, or `full`; default `default`) is the one Appearance layout preference. `applyAppearanceConfig` writes it to `--chat-content-max-width` (44rem, 52rem, 64rem, or `none`) and `data-chat-width` on the root. Every `.chat-content-column` surface shares that token, so the transcript, pending approvals, the task and subagent row above the composer, and the composer stay aligned. The dock inset still reserves the floating Live button's gutter at Full. Older v1 settings and exports without the field load as Default, and strict parsing rejects unknown values. The control is a four-option radio card group: selection is the label's list-selection fill, never a border, and keyboard focus uses the neutral focus ring. Below 540px of content width it reflows to two columns. `settings-unification.spec.ts` measures the rendered transcript and composer widths for every option and checks that the choice survives a relaunch.

## Window (Linux only)

`AppearanceConfig.linuxTitleBar` (`auto`, `aiden`, or `system`; default `auto`) picks the Linux window frame. Appearance shows a "Window" group with one trailing **Use system title bar** switch only when the host is Linux. `auto` draws Aiden's own title bar (window buttons in the 52px top bar, a ☰ main menu button, no menu bar strip) except on tiling window managers, which get the system title bar. The switch reads `auto` as whatever the running window uses and writes `aiden` or `system`. The frame is chosen when the main window is created, so the description adds "Takes effect the next time you open Aiden." while the saved choice differs from the running window. Older settings without the field load as `auto`, and strict parsing rejects unknown values. `linux-window-controls.spec.ts` checks that the choice is saved and applied after a relaunch.

## Aiden Live

Settings → Aiden Live opens with an "Availability" group of two trailing switches (not titled "Aiden Live", so the page keeps one heading with that name). `AppSettings.aidenLiveEnabled` (omitted means on) turns the feature off everywhere: the window's Live pill and HUD are not rendered, the `assistant.open` command and shortcut are ignored (so the `/assistant` slash command reports unavailable), any running session is stopped, and the main process refuses `assistant-live:start` with `aiden_live_disabled`. While it is off, the readiness, audio, and actions groups are hidden. `aidenLiveButtonVisible` (omitted means shown) appears only while Live is on and hides just the idle pill. Whenever a session is active, connecting, closing, awaiting approval, or in error, the pill and HUD still render so the user can see and stop it.

## Connectors

Settings → Connectors (section id `mcp`) has one heading with an ⓘ, **Add custom connector** and a ⋯ menu that holds **Reset connections**. Saved connectors sit in a "Your connectors" `FieldSet`; the directory below has its own group title with an ⓘ, a search field and category chips. Directory cards come from `renderer/shared/connector-catalog.ts`. A card's badge follows the live connection (`mcpPresetCardStatus`), so only a working connection is green. A connector marked unavailable shows its reason and a button that moves focus to its alternative instead of Set Up. A search that matches only an alias (Composio's apps, or the Mac apps iMCP reaches) shows the entry's one-line hint. Secret fields say values are stored encrypted on this device, never "this Mac's keychain".

A connector served by a Mac app (iMCP, `macApp` in the catalog) appears only where `app:getInfo` reports `macAppConnectors` (macOS). Its setup dialog (`mcp-mac-app-setup.tsx`) has three rows: **Install** (a green "Installed" chip with the version, or **Check again** and a **Download** link to the vendor's page), **Open** (a green "Open" chip, or **Open iMCP**, which opens the installed copy only when pressed), and **Choose what Aiden can use** (where in the app to turn services on, with an ⓘ saying tool results go to the chat's model). Connection details show the one command it runs. A failed Test or Connect adds a line with the app and macOS settings that usually fix it. Aiden never bundles, downloads, updates or quits the app.

Settings → Providers → Manage shows **Let custom connectors use this key** (off by default) only for a built-in provider with a saved API key; the custom-connector key picker lists only providers with it turned on.

## Workspace settings

Workspace settings is a pop-up, not a Settings page (`renderer/components/workspace-settings-dialog.tsx`). It opens from **Workspace settings…** in a workspace's ⋯ menu in the sidebar, the same item in the top-bar workspace chip menu, the command palette, or `⇧⌘,`. Only a workspace with a folder has one. Chats without a workspace, including No workspace chats in their hidden managed folders, follow Settings: the Chats group row and the No workspace chip menu have no Workspace settings item, and the config store drops any off-list saved on a No workspace record. It uses the shared `Dialog` at `size="wide"` (860px) with a vertical tab list on the left (General, Skills, Connectors; arrow keys move between tabs and selection is the list-selection fill) and the shared `FieldSet` cards on the right. Below 640px the tabs sit in a row above the content. Done closes it.

- **General:** Name (saves on Enter or when the field loses focus; the first Escape undoes an edit), Folder with Show in Finder, Access (Full access, Ask first, No access) and the per-workspace Memory switch.
- **Skills** and **Connectors:** a header with "n of m on", a search field once there are more than 8 rows, and a ⋯ menu with Turn all off here and Turn all on here. Each row has a trailing switch and a soft gray "Off here" `Badge` when it is switched off for this workspace. When Settings decides (a connector off in Settings or off for the model, a skill that only runs by name or is unavailable), the switch is disabled and the row's line says why, with a link back to Settings. A connector that can't connect shows a soft red badge, its error and Fix in Settings. Skills are grouped as Your skills, From this folder, and Built-in and global. When Skills are off in Settings the tab shows one callout instead of the list.

Switches save at once on screen and roll back with a toast if saving fails. A short line under each list says changes apply from the next message. The stored off-lists (`Workspace.disabledSkills`, by canonical skill name, and `Workspace.disabledMcpServerIds`) live with the workspace in the device-local config. The main process enforces them for every chat in that workspace, including chats started from a phone and the subagents they start; Bots keep their own access, and the CLI does not read them yet.

## Limits & spending

Settings → Limits & spending (section id `limits`, in the Agent group) has two `FieldSet` groups. **Usage limits** has one row, "Wait for a limit to clear", with a trailing Select of the longest wait (Don't wait, Up to 1, 6, 12 or 24 hours; default 6), backed by `AppSettings.usageLimitWaitHours`. **Spending limits** has four rows with trailing Selects: Each chat, Each Bot per month, Each routine run (No limit or a preset amount, `AppSettings.spendingLimits`) and "A Bot's month starts on" (1st to 28th). Each row's one secondary line says what the limit covers. A Bot's Profile has a "Spending" group with one "Monthly limit" row (Default, No limit or an amount) and a secondary line with this month's spend. The spending notices above a composer use a warning-tone icon and a soft raised fill, never a colored border; Allow more is the shared primary button. See [usage limits and spending limits](usage-limits-and-spending.md).

## Bots

Settings → Bots (section id `bots`, in the Agent group, before Bot computers) has two `FieldSet` groups. **Routines** has one trailing switch, "Go ahead without asking" (`AppSettings.botRoutinesGoAhead`, off by default), saved at once and put back if the save fails. **Always comes to you** lists what the switch never covers, each row with a trailing lock and "Always", the same treatment as a Bot's locked rules: passwords, 2FA codes and money; steps a Bot's rules hand off; and Computer Use on the person's Mac (only where this Mac offers Computer Use). A secondary line under the groups says what routines do while the switch is off. Each Bot's Rules group ends with a secondary line saying what routines do with Ask first steps and an inline "Change this for every Bot" link to the page. See [Bot rules](bot-rules.md#routines-that-go-ahead-settings--bots).

## Web pages

Settings → Web Search ends with a "Web pages" `FieldSet` (`renderer/components/settings/web-page-settings.tsx`). **Read web pages** is a trailing switch whose description says the Web Search switch above must be on. While it is on, the group adds **Extract only the values asked for** with a soft status `Badge` (On, Off or Needs setup) beside the label; the switch stays disabled until the Cloudflare account ID and a key are saved. If the setup is removed while the switch is on, the switch keeps showing the saved choice and the row reads "Paused" with Needs setup, so it can still be turned off. The account ID is a vertical field with an inline Save, the key list reuses the Web Search key pool editor, and a last row, "What leaves this device", says what extract mode sends to Cloudflare. Extract mode never turns itself on.

## Icons and illustrations

Use `MemoryCardIcon`, an SD-card silhouette, for Memory. Do not introduce brain glyphs or brain illustrations. The existing onboarding artwork is outside this Settings change.

## Checks

`npm run test:settings-design` covers preference defaults/migration, path formats and identities, and structural/accessibility contracts. The deterministic Electron suite includes `settings-unification.spec.ts` (path persistence and all settings at 390/600/1280px) and `model-pad-responsive.spec.ts` (Add list toggling into the tray; across window/zoom states the square and tray stay reachable without horizontal overflow, side by side or stacked by card width; keyboard movement and autosave with Undo). Keep layout assertions tied to rendered geometry rather than only source strings.

## Composer context usage

Appearance → Chat has a trailing “Show context usage in composer” switch,
backed by `AppearanceConfig.showComposerContextUsage` (default true for new and
legacy settings). It uses the normal live-preview/save path. This is separate
from `autoHideComposerContext`, which controls the workspace strip. Hiding the
meter changes only presentation; Context remains in the workspace launcher and
the runtime continues context accounting and compaction.

## Work details and busy sends

Appearance → Chat has **Work details** (Compact, Standard, Detailed, Verbose),
**When to collapse work details** (On completion / On next message), **Open chat
links in**, and **Send behavior while busy** (Queue / Steer). The work and send
preferences use `AppearanceConfig.workDetails`, `workDetailsCollapseTiming`, and
`busySendBehavior`, defaulting to `standard`, `completion`, and `queue` for new and
legacy v1 settings. They follow live preview and the normal debounced save path.

Compact keeps work behind summary headers. Standard shows a three-row activity
preview; Detailed opens eligible tool trails; Verbose keeps automatic details
open in history. On next message retains the latest exchange's work until the
next committed ordinary prompt, including across reopening the chat. Reasoning is
not part of these modes: it stays the steady one-line Thinking row that only the
reader opens, so the transcript does not jump while a model thinks. Manual
opens/closes win over automatic timing. Completed work never keeps live shimmer or announcements.
Answers, visuals, approvals and question recaps keep their normal placement.
Bot activity availability still follows each Bot's Quiet/Summary/Detailed level;
the global mode and timing adjust Detailed recaps without adding hidden steps.

The link row edits the same browser-service preference as Settings → Links,
including Ask each time, Aiden browser and System browser. Local-file checks,
loopback rules, modifier-click and restricted-content confirmation still apply.
This preference remains separate from Appearance import/reset.

While busy, Enter and the send pill use the chosen Queue/Steer default, and
Cmd/Ctrl+Enter uses the other action. The pill's menu can override the default
for that run; the next idle transition restores the saved default. Unsupported
Steer uses the Queue affordance. Shift+Enter and idle sends are unchanged. These
preferences apply to desktop viewers/composers; native phones and the CLI keep
their existing local behavior, with no Remote wire change.
