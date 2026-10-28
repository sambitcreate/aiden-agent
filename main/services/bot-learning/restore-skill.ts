// Undo for a skill the Bot added: one SKILL.md, never the folder around it.

import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Put one skill's SKILL.md back to `content` while it still reads `expected`.
 * Undoing an added skill removes only that file: anything the person added
 * beside it stays, and the folder goes only when nothing else is in it.
 * Restoring an earlier version writes that text back, which loads only if
 * it was approved before.
 */
export async function restoreSkillFile(file: string, content: string | null, expected: string | null): Promise<boolean> {
  if ((await fs.readFile(file, "utf8").catch(() => null)) !== expected) return false;
  if (content === null) {
    await fs.rm(file, { force: true });
    await fs.rmdir(path.dirname(file)).catch(() => undefined);
  } else {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { mode: 0o600 });
  }
  return true;
}
