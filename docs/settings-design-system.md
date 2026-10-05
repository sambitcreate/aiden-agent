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

Model Pad measures the actual scrollport and remaining column. Axis captions and the legend use a reserved height so the square outline stays put while surrounding copy, marker labels, and catalog text change. The square is constrained by remaining height, column width, and the visible scrollport. On very short or highly zoomed windows, it keeps a usable canvas (160px when the scrollport allows) and the Settings page scrolls; the Pad and its labels remain reachable. Ordinary window allocations show the full canvas and legend together. Opening model or benchmark panels uses the same measurement.

## Workspace labels

`AppearanceConfig` owns `showWorkspacePaths` (default false) and `workspacePathFormat` (`middle`, `end`, or `start`). The Appearance page no longer renders controls for them — the fields stay in the schema so stored preferences keep applying. Older v1 preferences normalize to hidden paths. The sidebar and picker follow persisted/live-preview changes, and measure their own text allocation so CSS does not replace the selected truncation with end clipping. Preserve legal whitespace, emoji, and combining characters. These strings are display-only; filesystem operations always use the full original path.

Duplicate workspace names receive a short stable ID suffix in both visible and accessible names. Worktree branches and folderless workspace identity remain available when paths are hidden. Destructive confirmation and permission-scope review still identify their exact filesystem target.

## Chat width

`AppearanceConfig.chatWidth` (`narrow`, `default`, `wide`, or `full`; default `default`) is the one Appearance layout preference. `applyAppearanceConfig` writes it to `--chat-content-max-width` (44rem, 52rem, 64rem, or `none`) and `data-chat-width` on the root. Every `.chat-content-column` surface shares that token, so the transcript, pending approvals, and composer stay aligned. The dock inset still reserves the floating Aiden mark's gutter at Full. Older v1 settings and exports without the field load as Default, and strict parsing rejects unknown values. The control is a four-option radio card group: selection is the label's list-selection fill, never a border, and keyboard focus uses the neutral focus ring. Below 540px of content width it reflows to two columns. `settings-unification.spec.ts` measures the rendered transcript and composer widths for every option and checks that the choice survives a relaunch.

## Icons and illustrations

Use `MemoryCardIcon`, an SD-card silhouette, for Memory. Do not introduce brain glyphs or brain illustrations. The existing onboarding artwork is outside this Settings change.

## Checks

`npm run test:settings-design` covers preference defaults/migration, path formats and identities, and structural/accessibility contracts. The deterministic Electron suite includes `settings-unification.spec.ts` (path persistence and all settings at 390/600/1280px) and `model-pad-responsive.spec.ts` (window/zoom/panel states, scrolling, keyboard movement, and save). Keep layout assertions tied to rendered geometry rather than only source strings.
