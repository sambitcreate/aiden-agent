# PR #199: theme tile picker (0.50.0)

- Desktop Appearance is now a Theme section: a 3-option Theme mode radiogroup (System/Light/Dark) plus a 9-preset "Themes" tile radiogroup; picking a tile sets the same preset for light and dark. Mixed presets show "Current theme: Custom" and no checked tile.
- Other AppearanceConfig fields (fonts, contrast, reduce motion, auto-hide workspace bar, workspace paths, dock icon) remain in the schema but have no controls; e2e drives them through `settings:set`.
- #200 (iOS/Android tile pickers, five new presets in `protocol/aiden-appearance-v1.json`) was squash-merged into #199's branch on 2026-09-26.
- Responsive rules use `@container settings-content (max-width: 540px)`: grid drops to 2 columns and mode-label icons hide. Covered by `settings-unification.spec.ts` "theme tiles select a preset...".
