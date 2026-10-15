# Android Material 3 theme roles (2026-10-07, PR #374)

- `aidenColorScheme(palette, isDark)` in `ui/theme/AidenTheme.kt` maps every M3 role from an
  `AidenPalette`. Container roles are opaque tones composited over `sidebar`; `outline` /
  `outlineVariant` are real foreground tints. Before this, both outlines were transparent, so
  unchecked `Switch` thumbs (drawn in `outline`) and `HorizontalDivider`s were invisible.
- `surfaceVariant` is deliberately a unique tint: `contentColorFor` checks `surfaceVariant`
  before the container tiers, so if it equalled a container tier, text on that container
  would turn grey (`onSurfaceVariant`).
- `palette.onAccent` / `AidenPalette.readableOn(fill)` pick white or black by WCAG contrast,
  matching the desktop `accentForeground`. Never hard-code `Color.White` on an accent fill;
  dark-mode accents failed 4.5:1 with white.
- `aidenTypography(scale)` carries no colors. Material components supply content color, and
  `AidenTheme` provides `LocalContentColor = palette.foreground` at the root. `BasicTextField`
  styles must still pass an explicit color (an unspecified color renders black).
- Corner radii come from `MaterialTheme.shapes` (M3 scale xs4/s8/m12/l16/xl28), or from
  `AidenShapes` outside composition. Component tokens remain in `AidenShape`.
- `rememberAidenFullSheetState()`: long sheets open fully expanded, because their gestures are
  disabled (`ScrollableSheetGesturesEnabled = false`), so a half-height detent could never be
  expanded.
- The launch theme has day/night `aiden_launch_canvas` colors, so a cold start doesn't flash
  white in dark mode.
- Tests: `AidenExpressiveFoundationTest` checks onPrimary ≥ 4.5:1, opaque roles and outline
  contrast for every preset and mode.
