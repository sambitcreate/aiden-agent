# PR #199: theme tile picker (0.50.0)

- Desktop Appearance is now a Theme section: a 3-option Theme mode radiogroup (System/Light/Dark) plus a 9-preset "Themes" tile radiogroup; picking a tile sets the same preset for light and dark. Mixed presets show "Current theme: Custom" and no checked tile.
- Other AppearanceConfig fields (fonts, contrast, reduce motion, auto-hide workspace bar, workspace paths, dock icon) remain in the schema but have no controls; e2e drives them through `settings:set`.
- #200 (iOS/Android tile pickers, five new presets in `protocol/aiden-appearance-v1.json`) was squash-merged into #199's branch on 2026-09-26.
- Responsive rules use `@container settings-content (max-width: 540px)`: grid drops to 2 columns and mode-label icons hide. Covered by `settings-unification.spec.ts` "theme tiles select a preset...".

## Untitled palette pass (2026-10)

- Added a 10th preset `monochrome` (white/black light, near-black dark: canvas `#0A0A0A` because the preset test forbids a pure-black dark canvas). Desktop accent foreground auto-derives (black accent -> white text, white accent -> black text).
- Paper and Calm now use the Untitled warm stone neutral scale while keeping their accent/status hues. Paper is the lighter/crisper pair (light canvas n2/sidebar n3/raised n1; dark canvas n2/sidebar n3/raised n4); Calm is one step deeper (light canvas n3/sidebar n4/raised n2; dark canvas n3/sidebar n2/raised n4).
- Android gained `AidenPalette.onAccent` (= canvas, matching iOS `onAccent`). Accent-filled controls and `onPrimary` use it instead of hard-coded white, so the white Monochrome dark accent keeps readable labels; dark-mode accents on Android now carry dark labels like iOS/desktop. Danger fills still use white.
- Android has a fixture-parity unit test against `protocol/aiden-appearance-v1.json` for every preset except its own Aiden palette.
