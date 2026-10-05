# Untitled theme adoption (2026-10-05)

Branch `feature/untitled-theme-ui-upgrade-eaa2ac`. Installed the Graphical "Untitled" guidance from `https://www.graphicalui.com/r/8a0bznunlg9m.zip` (Markdown only): `GUI.md`, `gui/`, and `.agents/skills/graphical-{ui,convert,audit}`. AGENTS.md points to them.

Owner decisions:
- Keep Aiden's corner radii (`--radius-*`, 16px squircle buttons, 40px composer) and all preset palettes. Untitled's teal/stone palette is NOT adopted wholesale.
- New `monochrome` preset (pure black/white). Paper and Calm use Untitled's warm stone neutral scale with their original accents.
- Timeless Grotesk is skipped; UI font options unchanged.
- Adopted structure for every preset: motion tokens (`--motion-duration` 200ms, `--motion-easing`, large 360ms, `--motion-popup-scale` 0.96, `--motion-press-distance` 1px; Tailwind `ease-standard`/`ease-emphasized`), borderless cards/popovers/sheets (inset row separators kept), filled inputs (`bg-input` rest, `bg-control` focus, neutral resting border kept), roomier button padding (px-3/4/5), and Untitled type-step ratios anchored to `--ui-font-size`.

Intentional exceptions: shared dialogs keep the 10ms / 0.9-scale entrance locked by `dialog-motion-contract.test.ts`; sidebar keeps 300ms width timing (inspiration doc) but uses the emphasized curve; heading2 keeps 18/24 so it stays distinct from large-strong; press shift skips buttons that use Tailwind `translate-*` utilities. Focus ring stays neutral (not Untitled's accent).

Coverage: `settings-unification.spec.ts` "text fields rest on a fill..." measures rendered field fill/border/outline; the `focus:bg-input` source grep was removed from `text-entry-focus-contract.test.ts`.

## Android (Compose, Material 3 way)

- Motion: `AidenMotion` (ui/theme/AidenMotion.kt) holds Untitled tokens: `ShortDurationMillis` 200 + `StandardEasing` (0.16,1,0.3,1), `LongDurationMillis` 360 + `EmphasizedEasing` (0.22,1,0.36,1); `short()/long(reduceMotion)` snap when reduced. `rememberAidenReduceMotion()` = Aiden Reduce Motion OR system animator scale 0. Spatial motion keeps M3 Expressive springs; fades (nav host, jump-to-bottom, composer send/stop, product-area crossfade) use `short()`. `nonSpatialExpressiveSpring` removed.
- Surfaces were already borderless (`outline` transparent, tonal `palette.raised` fills). `outlineVariant` is now a soft separator (secondary @ 0.18) so default `HorizontalDivider`/menu dividers stay visible.
- Text fields: `aidenTextFieldColors()` filled, no indicator, neutral label on focus, focus = surfaceContainerLow -> surfaceContainer. Environment file search now uses it too.
- Buttons: `AidenButtonDefaults.TextContentPadding` (16dp h / 8dp v) applied to every TextButton; filled/tonal/outlined keep M3's 24dp default (already roomier). Heights unchanged.
- Type: labelSmall 11/14 -> 12/16 in the theme Typography; body 14/20 unchanged; no caption role in M3.
- Shapes (`AidenShapes`) and palettes untouched. Test: `ui/theme/AidenMotionTest.kt`.
