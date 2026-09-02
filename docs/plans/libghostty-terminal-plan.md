# Libghostty workspace terminal

Status: Implemented

Replace the workspace drawer's xterm.js emulator with Ghostty's `libghostty-vt`
WebAssembly engine while keeping Aiden's existing node-pty session, IPC, and
history contracts.

## Decision

Native `libghostty` GPU embedding (Metal IOSurface into Electron) is still
macOS-only research and needs an unpublished Ghostty headless patch. The
shipped path is the portable engine that already exists: `libghostty-vt` WASM
for VT parsing and screen state, with an Aiden canvas host in the renderer.

PTY spawn, `TERM=xterm-256color`, snapshot hydrate, and session limits stay in
`main/services/terminal.ts`.

## Remaining

- Visual scrollback inside an open pane (this WASM export returns `-1` for
  `ghostty_terminal_get_scrollback_line`; history still hydrates from the PTY
  snapshot).
- Packaged/physical drawer acceptance on a signed Mac build.
- Optional later native Metal embed if Ghostty publishes a stable headless
  surface API.
