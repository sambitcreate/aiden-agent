// Which window chrome the main window uses. Shared by main (window creation)
// and the renderer (top-bar layout); kept free of Electron and DOM imports.

/** macOS traffic lights, Aiden-drawn Linux controls, or the desktop's own title bar. */
export type WindowChrome = "mac" | "aiden" | "system";

/** The Linux title-bar preference stored in Appearance. */
export type LinuxTitleBarPreference = "auto" | "aiden" | "system";

export const WINDOW_CHROME_ARGUMENT = "--aiden-window-chrome=";

export function isLinuxTitleBarPreference(value: unknown): value is LinuxTitleBarPreference {
  return value === "auto" || value === "aiden" || value === "system";
}

export function isWindowChrome(value: unknown): value is WindowChrome {
  return value === "mac" || value === "aiden" || value === "system";
}

const TILING_DESKTOPS = new Set(["sway", "hyprland", "i3", "niri", "river", "qtile", "bspwm", "awesome", "dwm", "xmonad"]);
const TILING_SOCKETS = ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "I3SOCK", "NIRI_SOCKET"] as const;

/**
 * Whether the session runs a tiling window manager, where window buttons do
 * nothing useful and the compositor usually draws no frame at all.
 */
export function isTilingWindowManager(env: Readonly<Record<string, string | undefined>>): boolean {
  if (TILING_SOCKETS.some((name) => Boolean(env[name]))) return true;
  const desktops = `${env.XDG_CURRENT_DESKTOP ?? ""}:${env.XDG_SESSION_DESKTOP ?? ""}:${env.DESKTOP_SESSION ?? ""}`;
  return desktops
    .toLowerCase()
    .split(/[:;]/u)
    .some((name) => TILING_DESKTOPS.has(name.trim()));
}

/**
 * Picks the chrome for a new main window. Linux uses Aiden's own controls
 * unless the person chose the system title bar, or chose nothing on a tiling
 * window manager. Platforms other than macOS and Linux keep their native frame.
 */
export function resolveWindowChrome(input: {
  platform: NodeJS.Platform;
  preference: LinuxTitleBarPreference;
  env: Readonly<Record<string, string | undefined>>;
}): WindowChrome {
  if (input.platform === "darwin") return "mac";
  if (input.platform !== "linux") return "system";
  if (input.preference !== "auto") return input.preference;
  return isTilingWindowManager(input.env) ? "system" : "aiden";
}

/** The chrome named on the renderer's command line by `WINDOW_CHROME_ARGUMENT`. */
export function windowChromeFromArgv(argv: readonly string[]): WindowChrome | null {
  const entry = argv.find((value) => value.startsWith(WINDOW_CHROME_ARGUMENT));
  const value = entry?.slice(WINDOW_CHROME_ARGUMENT.length);
  return isWindowChrome(value) ? value : null;
}

/** Live state of the window behind Aiden's drawn controls. */
export interface WindowControlsState {
  maximized: boolean;
  fullScreen: boolean;
}

export function parseWindowControlsState(value: unknown): WindowControlsState | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.maximized !== "boolean" || typeof record.fullScreen !== "boolean") return null;
  return { maximized: record.maximized, fullScreen: record.fullScreen };
}
