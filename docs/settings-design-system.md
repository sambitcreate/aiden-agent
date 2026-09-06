# Settings design system

Settings adapts the Appearance page and the desktop UI references in `chatgpt-desktop-ui-inspiration.md` and `chatgpt-ui-element-specimen.html`.

## Composition

- `SettingsPage` owns the page heading and description. Destinations with their own header/actions use `settings-page-heading` and suppress the wrapper heading. Keep one destination heading; group titles describe a distinct group rather than repeating the page title.
- `FieldSet` supplies `settings-group`, `settings-group-title`, and `settings-group-card`. Existing custom connection lists use `settings-card` for the same surface.
- `Field` supplies a label/description group, inset separator, and `settings-field-control`. Default rows put controls at the right; vertical rows suit editors, lists, previews, and complex forms. Direct switches retain a trailing column even on narrow windows.
- Use the shared Button, Switch, Input, Select, and other control primitives. Inputs keep their resting border and use background/caret focus states. Non-text controls retain a neutral `--focus-ring` outline.

## Tokens and adaptation

The `.settings-responsive` container defines `--settings-card-radius`, `--settings-card-fill`, `--settings-row-inset`, and `--settings-row-gap`. They derive from Aiden's semantic theme tokens; Appearance cards use these same variables. Shared heading metrics are 26/32px, with secondary copy and 26px spacing before content. Groups use soft neutral surfaces, neutral borders, inset separators, and restrained elevation. Status appears in semantic labels, icons, and fills, never decorative colored borders.

Rows respond to their allocated content width, not the whole window. Below 540px complex controls stack under descriptions, while switches remain on the right. Grid groups must use `minmax(0, 1fr)` / `grid-cols-1` so long provider names or endpoints cannot force horizontal overflow. Controls and text must stay reachable without horizontal page scrolling.

Model Pad measures the actual scrollport, wrapped toolbar, labels, and legend. Its square is constrained by both remaining height and column width. On very short or highly zoomed windows, it retains a usable 160px square and the Settings page scrolls; the Pad and its labels remain reachable. Ordinary window allocations show the full canvas and legend together. Opening model or benchmark panels uses the same measurement.

## Workspace labels

Appearance owns `showWorkspacePaths` (default false) and `workspacePathFormat` (`middle`, `end`, or `start`). Older v1 preferences normalize to hidden paths. The sidebar and picker follow persisted/live-preview changes, and measure their own text allocation so CSS does not replace the selected truncation with end clipping. Preserve legal whitespace, emoji, and combining characters. These strings are display-only; filesystem operations always use the full original path.

Duplicate workspace names receive a short stable ID suffix in both visible and accessible names. Worktree branches and folderless workspace identity remain available when paths are hidden. Destructive confirmation and permission-scope review still identify their exact filesystem target.

## Icons and illustrations

Use `MemoryCardIcon`, an SD-card silhouette, for Memory. Do not introduce brain glyphs or brain illustrations. Thinking Controls uses a lightbulb; its 1024×1024 transparent PNG lives at `renderer/assets/onboarding/features/thinking-controls.png` and is covered by the onboarding asset contract.

## Checks

`npm run test:settings-design` covers preference defaults/migration, path formats and identities, and structural/accessibility contracts. The deterministic Electron suite includes `settings-unification.spec.ts` (path persistence and all settings at 390/600/1280px) and `model-pad-responsive.spec.ts` (window/zoom/panel states, scrolling, keyboard movement, and save). Keep layout assertions tied to rendered geometry rather than only source strings.
