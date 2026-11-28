// Delete-only cleanup of what v1's design-system offer left on disk (design
// mode v2 Phase 3d, S114): the log of workspaces already offered a tokens file
// and its hashing key. Nothing reads them any more. It makes no network
// request, never recreates anything, can run any number of times, and never
// rejects: a failed removal is logged and retried next launch.

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** What the offer stored in userData: its log, and the log's HMAC key beside it. */
export const RETIRED_DESIGN_SYSTEM_OFFER_FILES: readonly string[] = Object.freeze(["design-system-offers.json", "design-system-offers.json.key"]);

/**
 * Removes the retired files from `userDataDir` (default: Aiden's userData).
 * A missing file counts as removed. Resolves with the names it couldn't
 * remove.
 */
export async function cleanUpRetiredDesignSystemOffers(
  userDataDir?: string,
  options: { removeFile?: (filePath: string) => Promise<void>; onFailure?: (file: string, error: unknown) => void } = {},
): Promise<string[]> {
  const failed: string[] = [];
  let directory = userDataDir;
  try {
    if (directory === undefined) {
      const { app } = await import("../../platform.js");
      directory = app.getPath("userData");
    }
  } catch (error) {
    options.onFailure?.("userData", error);
    return ["userData"];
  }
  const removeFile = options.removeFile ?? ((filePath: string) => fs.rm(filePath, { force: true }));
  for (const name of RETIRED_DESIGN_SYSTEM_OFFER_FILES) {
    try {
      await removeFile(path.join(directory, name));
    } catch (error) {
      failed.push(name);
      try {
        options.onFailure?.(name, error);
      } catch {
        // Diagnostics can't turn a quiet cleanup into a failure.
      }
    }
  }
  return failed;
}
