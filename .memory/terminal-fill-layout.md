# Terminal fills its area; T3 Code comparison — 2026-11-05

## Layout fix

The single-pane body was `display: block`, so its pane had auto height and the canvas's `height: 100%` computed to auto. The canvas then took its height from the bitmap's ratio: the default 300x150 gives height = width / 2, and `fit()` wrote that ratio back into the backing store, so it never corrected. Tall side panels showed an empty band below the screen; the bottom drawer hid about 400px of rows past its edge. Split layouts were always grids, so they were fine.

Every layout now uses one grid with definite tracks. The pane host has no padding and the pane uses `--terminal-background`, which removes the 8px `bg-list-selection` frame. `CONTENT_PADDING` went from 4 to 8 to keep the text off the edge. The active split used to rely on that frame, so inactive split canvases now dim to 70% (Ghostty's `unfocused-split-opacity` idea), alongside the existing hollow cursor.

`initialHeight()` also read a missing key as `Number(null) === 0`, which passed the finite check and clamped to the 152px minimum, so `DEFAULT_DRAWER_HEIGHT` (232) never applied on first open.

Covered by `terminal screen reaches every edge of its area in both placements` in `tests/e2e/workspace-panel.spec.ts`.

## T3 Code comparison

Source read at `pingdotgg/t3code` 337c5858 (2026-11-05, MIT). Aiden's `ghostty-vt.wasm` and `ghostty-write-pty.wasm` are byte-identical to T3's desktop/web build, and both pin Ghostty 9f62873bf. The engine needs no upgrade. T3's mobile app uses a newer native pin (cf8edc23f), which is a different build.

## Ported on 2026-11-05 (`feature/terminal-upgrades`, stacked on #770)

From T3's adapter: synchronized output with the 500ms deadline, `setVisible`, Select All, Shift+PageUp/PageDown and primary+Shift+Home/End, the speed ramp on selection autoscroll, drag selection that follows moving output, solid powerline separators, links on wide-character rows, and press-then-drag from a link gesture.

Kept different from T3 on purpose:

- Links still need Cmd/Ctrl. T3 moved to plain click, which is a separate behaviour change.
- `fit()` still sizes from the canvas, which `terminal-drawer.test.tsx` locks; #770 removed the padding that made mount and canvas differ.
- Aiden keeps its screen-reader log and host-reserved Command chords.

Aiden's own additions:

- **Add to chat** reuses the `kind: "text"` attachment path browser annotations use, so there is no message contract or phone change. `ComposerDeliveryRegistry` (`renderer/lib/composer-delivery.ts`) now backs both. `terminalContextText` frames output as untrusted and keeps the tail of long selections.
- **Running program** uses node-pty's `pty.process` (the PTY foreground process group) instead of T3's `ps -eo` table. It spawns nothing and ignores background jobs, so a job left running with `&` does not trigger the close confirmation. A program must hold across two 1s polls before the tab shows it, because prompt themes run short foreground commands. Close reads it fresh over `terminal:foregroundCommand`.

## Not ported

- `core.ts`, `runtime.ts`: batched cell queries and cached memory views. Performance only.
- `surface.ts`: touch scrolling, middle-click paste on Linux, Ctrl+Insert copy, plain-click links, `encodedKeyCodes` key tracking, fit sized from the mount, shared PTY grids.
- Product: file-path links that open in the editor, restart of exited sessions, terminals that survive switching threads.
