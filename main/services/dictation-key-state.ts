// Query whether a macOS virtual key is currently down (hold-to-talk release).

import { execFile, spawn, type ChildProcess } from "node:child_process";

export const HOLD_KEY_WATCH_DELAY_SEC = 0.08;

const inFlightQueries = new Map<number, Promise<boolean>>();

function isMacKeyCode(keyCode: number): boolean {
  return Number.isInteger(keyCode) && keyCode >= 0 && keyCode <= 127;
}

export type ExecMacKeyQuery = typeof execFile;
export type SpawnMacKeyWatch = typeof spawn;

export function queryMacKeyDown(
  keyCode: number,
  execFileFn: ExecMacKeyQuery = execFile,
): Promise<boolean> {
  if (!isMacKeyCode(keyCode)) {
    return Promise.resolve(false);
  }
  const existing = inFlightQueries.get(keyCode);
  if (existing) return existing;
  const pending = new Promise<boolean>((resolve) => {
    execFileFn(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("CoreGraphics"); $.CGEventSourceKeyState(1, ${keyCode}) ? "1" : "0";`,
      ],
      { timeout: 400 },
      (error, stdout) => {
        inFlightQueries.delete(keyCode);
        if (error) {
          resolve(false);
          return;
        }
        resolve(String(stdout ?? "").trim() === "1");
      },
    );
  });
  inFlightQueries.set(keyCode, pending);
  return pending;
}

/**
 * One long-lived JXA process that waits until the key is up, then exits.
 * Killing the child from stop() must not fire onRelease.
 */
export function watchMacKeyUntilUp(
  keyCode: number,
  onRelease: () => void,
  spawnFn: SpawnMacKeyWatch = spawn,
): () => void {
  if (!isMacKeyCode(keyCode)) {
    return () => {};
  }
  let stopped = false;
  let released = false;
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
    return () => {};
  }
  const finishRelease = () => {
    if (stopped || released) return;
    released = true;
    onRelease();
  };
  child.once("exit", (code) => {
    if (code === 0) finishRelease();
  });
  child.once("error", () => {
    // A watcher failure must not stop recording; the user can still toggle.
  });
  return () => {
    stopped = true;
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
  };
}
