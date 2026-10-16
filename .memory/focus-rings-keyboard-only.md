# Focus rings are keyboard-only

- User (2026-10-16) wants no focus outlines when using the mouse anywhere in the desktop app; keyboard navigation keeps the neutral `--focus-ring` outline for accessibility.
- `renderer/lib/input-modality.ts` (installed in `renderer/main/index.tsx` and `renderer/pill/main.tsx`) sets `<html data-input-modality>` to `pointer` on pointerdown and `keyboard` on any non-modifier, non-chord keydown.
- `renderer/styles.css` hides every `:focus-visible` outline and Tailwind ring under `[data-input-modality="pointer"]`. Needed because Chromium matches `:focus-visible` on script focus after a click (Radix menu rows focused on hover showed a dark ring).
- New box-shadow focus rings need a matching pointer-mode override; outline and `ring-*` utilities are covered automatically.
