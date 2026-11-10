// Replaces a workspace page's text for an in-place word edit. Readers see the
// old file or the new one, never a half-written page, and the file keeps its
// permissions. Once the new file is in place the edit counts as written, even
// if the directory flush after it fails: the person sees the new words, so
// they must also be able to undo them. The file is read again just before
// the new one goes in, so a change another writer made meanwhile is never
// overwritten.

import * as fs from "node:fs/promises";
import { writeFileAtomic, type DurableFsIo } from "../durable-fs.js";

export async function replaceWorkspaceText(
  file: string,
  text: string,
  /** What the file held when the edit was planned. */
  expected: string,
  io: Partial<DurableFsIo> = {},
): Promise<"written" | "changed" | "failed"> {
  let published = false;
  let changed = false;
  try {
    const { mode } = await fs.stat(file);
    const rename = io.rename ?? fs.rename;
    await writeFileAtomic(file, text, {
      mode: mode & 0o777,
      beforePublish: async () => {
        if ((await fs.readFile(file, "utf8")) === expected) return;
        changed = true;
        throw new Error("The page changed while it was being saved.");
      },
      io: {
        ...io,
        rename: async (from, to) => {
          await rename(from, to);
          published = true;
        },
      },
    });
    return "written";
  } catch {
    return published ? "written" : changed ? "changed" : "failed";
  }
}
