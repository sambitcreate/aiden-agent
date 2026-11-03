# Linux window controls (Aiden title bar) — 2026-11-01

Owner (sbt) disliked Ubuntu's title bar + Electron menu strip stacked above Aiden's 52px bar on Linux, and picked "option C": Aiden-drawn controls inside Aiden's own top bar (not Electron's Window Controls Overlay, which draws Chromium glyphs on Electron 43 and Yaru-styled ones only from 44).

## How it works
- `renderer/shared/window-chrome.ts`: `WindowChrome` = `mac | aiden | system`; `resolveWindowChrome({platform, preference, env})`. Linux `auto` → `aiden`, except tiling WMs (`XDG_CURRENT_DESKTOP`/`XDG_SESSION_DESKTOP`/`DESKTOP_SESSION` sway, Hyprland, i3, niri, river, qtile, bspwm, awesome, dwm, xmonad, or `SWAYSOCK`/`HYPRLAND_INSTANCE_SIGNATURE`/`I3SOCK`/`NIRI_SOCKET`) → `system`. Non-mac non-Linux → `system`.
- Preference: `appearance.linuxTitleBar` (`auto` default, `aiden`, `system`); Settings → Appearance → Window → "Use system title bar" switch (Linux only). Read once when the main window is created (`main/index.ts` createMainWindow), so a change applies on the next launch; the switch description says so when saved ≠ running.
- `main/windows/main-window-options.ts`: Linux `aiden` → `titleBarStyle: "hidden"` (frameless, no overlay, no menu bar; app-menu accelerators still fire). Every window passes `--aiden-window-chrome=<chrome>` in `additionalArguments`; the sandboxed preload reads `process.argv` and exposes `aidenAPI.window.chrome` synchronously; `renderer/main/app.tsx` sets `<html data-window-chrome>`.
- IPC (`main/handlers/window-controls.ts`, registered in index.ts): `app:window:getState|minimize|toggleMaximize|close|showMenu`, main-window sender only. Close calls `window.close()` → the existing guarded close. `showMenu` pops `Menu.getApplicationMenu()` at the ☰ button (CSS px × zoom factor). `trackWindowControlsState` sends `app:window-state` {maximized, fullScreen} on change.
- Renderer: `renderer/lib/window-chrome.ts` (store + `leadingClusterOffset` 90/12, `collapsedHeaderInset` 190/142/112, `useTrailingWindowControlsClearance(ref)` pads a top bar only while its right end meets the window's top-right corner). `renderer/components/window-controls.tsx` (`WindowControls`, fixed top-right, z-80 above every dialog layer incl. onboarding-layer dialogs at z-70, hidden in full screen, custom 14px glyphs incl. restore; the group stops `pointerdown` propagation so Radix dialogs/popovers don't treat a window action as an outside click and close, losing typed input — review finding on #691). ☰ `WindowMenuButton` leads the SidebarToggle cluster in `ui.tsx`. Clearance applied in ScrollArea header, StudioSurface header, WorkbenchTabStrip header.
- Unknown host (unit tests, browser tests without `aidenAPI`) lays out as `mac`.

## Verified (cloud, Xvfb + mutter X11)
Maximize/restore button, double-click empty bar → maximize, drag bar → move, minimize, ☰ popup, Ctrl+Plus zoom accelerator all work frameless. Not verified on real GNOME Wayland/KDE.

## Tests
`renderer/shared/window-chrome.test.ts`, `main/handlers/window-controls.test.ts`, `main/windows/main-window-options.test.ts`, `renderer/components/window-controls.test.tsx` (happy-dom: dialog survives minimize/maximize) (test:linux-contracts), appearance test, e2e `tests/e2e/linux-window-controls.spec.ts` (Linux only; minimize counted via a patched `minimize` because CI has no WM).
