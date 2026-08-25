// Wait until a macOS virtual key is released (hold-to-talk).

import { spawn, type ChildProcess } from "node:child_process";

export const HOLD_KEY_WATCH_DELAY_SEC = 0.08;

function isMacKeyCode(keyCode: number): boolean {
  return Number.isInteger(keyCode) && keyCode >= 0 && keyCode <= 127;
}

export type SpawnMacKeyWatch = typeof spawn;

export interface WatchMacKeyUntilUpOptions {
  spawnFn?: SpawnMacKeyWatch;
  onFailed?: () => void;
}

/**
 * One long-lived JXA process that waits until the key is up, then exits.
 * Returns null when the watcher cannot start. Killing the child from stop()
 * must not fire onRelease or onFailed.
 */
export function watchMacKeyUntilUp(
  keyCode: number,
  onRelease: () => void,
  options: WatchMacKeyUntilUpOptions = {},
): (() => void) | null {
  if (!isMacKeyCode(keyCode)) return null;
  const spawnFn = options.spawnFn ?? spawn;
  let stopped = false;
  let settled = false;
  let child: ChildProcess;
  try {
    child = spawnFn(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("CoreGraphics"); var code = ${keyCode}; while ($.CGEventSourceKeyState(1, code)) { delay(${HOLD_KEY_WATCH_DELAY_SEC}); }`,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  } catch {
    return null;
  }
  const finish = (released: boolean) => {
    if (stopped || settled) return;
    settled = true;
    if (released) onRelease();
    else options.onFailed?.();
  };
  child.once("exit", (code) => {
    if (code === 0) finish(true);
    else finish(false);
  });
  child.once("error", () => {
    finish(false);
  });
  return () => {
    stopped = true;
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
  };
}
