# Untitled theme adoption (2026-10-05)

Branch `feature/untitled-theme-ui-upgrade-eaa2ac`. Installed the Graphical "Untitled" guidance from `https://www.graphicalui.com/r/8a0bznunlg9m.zip` (Markdown only): `GUI.md`, `gui/`, and `.agents/skills/graphical-{ui,convert,audit}`. AGENTS.md points to them.

Owner decisions:
- Keep Aiden's corner radii (`--radius-*`, 16px squircle buttons, 40px composer) and all preset palettes. Untitled's teal/stone palette is NOT adopted wholesale.
- New `monochrome` preset (pure black/white). Paper and Calm use Untitled's warm stone neutral scale with their original accents.
- Timeless Grotesk is skipped; UI font options unchanged.
- Adopted structure for every preset: motion tokens (`--motion-duration` 200ms, `--motion-easing`, large 360ms, `--motion-popup-scale` 0.96, `--motion-press-distance` 1px; Tailwind `ease-standard`/`ease-emphasized`), borderless cards/popovers/sheets (inset row separators kept), filled inputs (`bg-input` rest, `bg-control` focus, neutral resting border kept), roomier button padding (px-3/4/5), and Untitled type-step ratios anchored to `--ui-font-size`.

Intentional exceptions: shared dialogs keep the 10ms / 0.9-scale entrance locked by `dialog-motion-contract.test.ts`; sidebar keeps 300ms width timing (inspiration doc) but uses the emphasized curve; heading2 keeps 18/24 so it stays distinct from large-strong; press shift skips buttons that use Tailwind `translate-*` utilities. Focus ring stays neutral (not Untitled's accent).

Coverage: `settings-unification.spec.ts` "text fields rest on a fill..." measures rendered field fill/border/outline; the `focus:bg-input` source grep was removed from `text-entry-focus-contract.test.ts`.
