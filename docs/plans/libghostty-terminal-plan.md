# Libghostty workspace terminal

Status: Implemented

Replace the workspace drawer's xterm.js emulator with Ghostty's official
`libghostty-vt` WebAssembly C ABI, following T3 Code's browser adapter:
runtime + write-pty trampoline, core snapshots, canvas renderer, and surface
input (IME, selection, scrollback, mouse reporting).

PTY spawn, `TERM=xterm-256color`, snapshot hydrate, and session limits stay in
`main/services/terminal.ts`.

## Remaining

- Packaged/physical drawer acceptance on a signed Mac build.
- Optional later native Metal embed if Ghostty publishes a stable headless
  surface API.
