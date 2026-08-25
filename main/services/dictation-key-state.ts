// Query whether a macOS virtual key is currently down (hold-to-talk release).

import { execFile } from "node:child_process";

export function queryMacKeyDown(keyCode: number): Promise<boolean> {
  if (!Number.isInteger(keyCode) || keyCode < 0 || keyCode > 127) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("CoreGraphics"); $.CGEventSourceKeyState(1, ${keyCode}) ? "1" : "0";`,
      ],
      { timeout: 400 },
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        resolve(stdout.trim() === "1");
      },
    );
  });
}
