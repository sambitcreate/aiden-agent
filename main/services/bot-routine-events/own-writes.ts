// A short-lived journal of the files a Bot's routine runs wrote with its file
// tools (write_file, edit_file), with the size and modified time each write
// left. The folder watch reads it to tell the Bot's own output from a file the
// person dropped in or changed while the run was going: a held path is the
// Bot's own only while the file is still exactly the version the Bot wrote.
// Shell commands are not journaled.

import { promises as fs } from "node:fs";

const KEEP_MS = 60 * 60_000;

/** A file's size and modified time, as the folder watch compares them. */
export type BotFileFingerprint = { mtimeMs: number; size: number };

async function statFingerprint(absolutePath: string): Promise<BotFileFingerprint | undefined> {
  const stats = await fs.stat(absolutePath).catch(() => undefined);
  return stats?.isFile() ? { mtimeMs: stats.mtimeMs, size: stats.size } : undefined;
}

export function createBotOwnWrites(
  now: () => number = Date.now,
  stat: (absolutePath: string) => Promise<BotFileFingerprint | undefined> = statFingerprint,
) {
  /** `${botId}\0${absolutePath}` → when it was last written, and the version it left. */
  const writes = new Map<string, { at: number; fingerprint: BotFileFingerprint }>();
  const key = (botId: string, absolutePath: string) => `${botId}\0${absolutePath}`;

  return {
    /** Journals a write that just succeeded, with the version it left on disk. */
    async record(botId: string, absolutePath: string): Promise<void> {
      const at = now();
      const fingerprint = await stat(absolutePath).catch(() => undefined);
      for (const [entry, written] of writes) {
        if (at - written.at > KEEP_MS) writes.delete(entry);
      }
      // A version that can't be read can't be told from the person's: not journaled.
      if (!fingerprint) {
        writes.delete(key(botId, absolutePath));
        return;
      }
      writes.set(key(botId, absolutePath), { at, fingerprint });
    },
    /** The version this Bot's file tools last left at `absolutePath`, when written at or after `since`. */
    writtenSince(botId: string, absolutePath: string, since: number): BotFileFingerprint | undefined {
      const written = writes.get(key(botId, absolutePath));
      return written && written.at >= since ? written.fingerprint : undefined;
    },
  };
}

export type BotOwnWrites = ReturnType<typeof createBotOwnWrites>;

/** Process-wide journal: the Bot tool sources write it, the folder watch reads it. */
export const botOwnWrites = createBotOwnWrites();
