import assert from "node:assert/strict";
import test from "node:test";

import {
  isTilingWindowManager,
  parseWindowControlsState,
  resolveWindowChrome,
  windowChromeFromArgv,
} from "./window-chrome.js";

const GNOME = { XDG_CURRENT_DESKTOP: "ubuntu:GNOME", XDG_SESSION_TYPE: "wayland" };

test("macOS always keeps its traffic lights and other non-Linux hosts their native frame", () => {
  for (const preference of ["auto", "aiden", "system"] as const) {
    assert.equal(resolveWindowChrome({ platform: "darwin", preference, env: GNOME }), "mac");
    assert.equal(resolveWindowChrome({ platform: "win32", preference, env: {} }), "system");
  }
});

test("Linux draws Aiden's title bar on desktops like GNOME and KDE by default", () => {
  assert.equal(resolveWindowChrome({ platform: "linux", preference: "auto", env: GNOME }), "aiden");
  assert.equal(resolveWindowChrome({ platform: "linux", preference: "auto", env: { XDG_CURRENT_DESKTOP: "KDE" } }), "aiden");
  assert.equal(resolveWindowChrome({ platform: "linux", preference: "auto", env: {} }), "aiden");
});

test("tiling window managers default to the system title bar", () => {
  const tiling = [
    { XDG_CURRENT_DESKTOP: "sway" },
    { XDG_CURRENT_DESKTOP: "Hyprland" },
    { XDG_CURRENT_DESKTOP: "i3" },
    { XDG_SESSION_DESKTOP: "niri" },
    { DESKTOP_SESSION: "bspwm" },
    { SWAYSOCK: "/run/user/1000/sway-ipc.sock" },
    { HYPRLAND_INSTANCE_SIGNATURE: "abc" },
    { I3SOCK: "/run/user/1000/i3/ipc-socket" },
  ];
  for (const env of tiling) {
    assert.equal(isTilingWindowManager(env), true, JSON.stringify(env));
    assert.equal(resolveWindowChrome({ platform: "linux", preference: "auto", env }), "system", JSON.stringify(env));
  }
  // A desktop name that merely contains a tiling WM's name is not one.
  assert.equal(isTilingWindowManager({ XDG_CURRENT_DESKTOP: "swaylike-gnome" }), false);
});

test("an explicit Linux choice wins over detection", () => {
  assert.equal(resolveWindowChrome({ platform: "linux", preference: "aiden", env: { XDG_CURRENT_DESKTOP: "sway" } }), "aiden");
  assert.equal(resolveWindowChrome({ platform: "linux", preference: "system", env: GNOME }), "system");
});

test("the renderer reads its chrome from the command line and ignores anything else", () => {
  assert.equal(windowChromeFromArgv(["electron", "--type=renderer", "--aiden-window-chrome=aiden"]), "aiden");
  assert.equal(windowChromeFromArgv(["--aiden-window-chrome=system"]), "system");
  assert.equal(windowChromeFromArgv(["--aiden-window-chrome=fancy"]), null);
  assert.equal(windowChromeFromArgv(["--type=renderer"]), null);
});

test("window state payloads must carry both flags as booleans", () => {
  assert.deepEqual(parseWindowControlsState({ maximized: true, fullScreen: false }), { maximized: true, fullScreen: false });
  assert.equal(parseWindowControlsState({ maximized: "yes", fullScreen: false }), null);
  assert.equal(parseWindowControlsState({ maximized: true }), null);
  assert.equal(parseWindowControlsState(null), null);
});
