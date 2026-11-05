# Terminal fills its area; T3 Code comparison — 2026-11-05

## Layout fix

The single-pane body was `display: block`, so its pane had auto height and the canvas's `height: 100%` computed to auto. The canvas then took its height from the bitmap's ratio: the default 300x150 gives height = width / 2, and `fit()` wrote that ratio back into the backing store, so it never corrected. Tall side panels showed an empty band below the screen; the bottom drawer hid about 400px of rows past its edge. Split layouts were always grids, so they were fine.

Every layout now uses one grid with definite tracks. The pane host has no padding and the pane uses `--terminal-background`, which removes the 8px `bg-list-selection` frame. `CONTENT_PADDING` went from 4 to 8 to keep the text off the edge. The active split used to rely on that frame, so inactive split canvases now dim to 70% (Ghostty's `unfocused-split-opacity` idea), alongside the existing hollow cursor.

`initialHeight()` also read a missing key as `Number(null) === 0`, which passed the finite check and clamped to the 152px minimum, so `DEFAULT_DRAWER_HEIGHT` (232) never applied on first open.

Covered by `terminal screen reaches every edge of its area in both placements` in `tests/e2e/workspace-panel.spec.ts`.

## T3 Code comparison

Source read at `pingdotgg/t3code` 337c5858 (2026-11-05, MIT). Aiden's `ghostty-vt.wasm` and `ghostty-write-pty.wasm` are byte-identical to T3's desktop/web build, and both pin Ghostty 9f62873bf. The engine needs no upgrade. T3's mobile app uses a newer native pin (cf8edc23f), which is a different build.

T3's adapter has moved on from the copy Aiden took. Not yet ported to `renderer/lib/ghostty-terminal/`:

- `core.ts`, `surface.ts`: synchronized output (mode 2026) with a 500ms render timeout; batched cell queries.
- `renderer.ts`: solid powerline separators drawn from cell edges; selection no longer splits text runs.
- `surface.ts`: selection autoscroll past the edge, select all, Shift+PageUp/PageDown and Home/End scrollback keys, links on wide-character rows, link press then drag starts a selection, `setVisible` pauses rendering while hidden, fit sized from the mount, touch scrolling, middle-click paste on Linux, Ctrl+Insert copy.

Product features T3 has that Aiden lacks: selection or right-click "Add to chat" as a composer context chip, file-path links that open in the editor, running-subprocess detection (tab activity and a close confirmation), restart of exited sessions, and terminals that survive switching threads.
