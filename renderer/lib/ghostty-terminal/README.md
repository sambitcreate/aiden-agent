# Ghostty web terminal

Aiden's workspace drawer hosts the same official `libghostty-vt` C ABI T3 Code
uses in the browser. This is not an xterm.js compatibility layer.

- `runtime.ts` owns the singleton WebAssembly instance, type layouts, and the
  112-byte `ghostty-write-pty.wasm` callback trampoline for terminal-generated
  PTY replies.
- `core.ts` owns per-terminal Ghostty handles and translates the C ABI into
  render snapshots.
- `renderer.ts` batches backgrounds and style runs into a Canvas 2D frame.
- `surface.ts` owns browser input, IME, selection, scrolling, sizing, links,
  and cursor blinking (adapted from T3 Code, MIT).
- `fonts/` vendors the symbols-only Nerd Font (MIT) so prompt glyphs render
  without a locally installed Nerd Font.
- `vendor/` holds the WASM artifacts. `VERSION` is the pinned Ghostty revision
  embedded in `ghostty-vt.wasm`.

Keep browser behavior here and PTY transport in `main/services/terminal.ts`.
Do not add React state to the render loop.
