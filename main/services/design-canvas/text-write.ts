// Replaces a workspace page's text for an in-place word edit. Readers see the
// old file or the new one, never a half-written page, and the file keeps its
// permissions. Once the new file is in place the edit counts as written, even
// if the directory flush after it fails: the person sees the new words, so
// they must also be able to undo them.

import * as fs from "node:fs/promises";
import { writeFileAtomic, type DurableFsIo } from "../durable-fs.js";

export async function replaceWorkspaceText(
  file: string,
  text: string,
  io: Partial<DurableFsIo> = {},
): Promise<"written" | "failed"> {
  let published = false;
  try {
    const { mode } = await fs.stat(file);
    const rename = io.rename ?? fs.rename;
    await writeFileAtomic(file, text, {
      mode: mode & 0o777,
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
    return published ? "written" : "failed";
  }
}
