// A short-lived journal of the files a Bot's routine runs wrote with its file
// tools (write_file, edit_file). The folder watch reads it to tell the Bot's
// own output from a file the person dropped in while the run was going: only
// the Bot's own paths are ignored. Shell commands are not journaled.

const KEEP_MS = 60 * 60_000;

export function createBotOwnWrites(now: () => number = Date.now) {
  /** `${botId}\0${absolutePath}` → when it was last written. */
  const writes = new Map<string, number>();
  const key = (botId: string, absolutePath: string) => `${botId}\0${absolutePath}`;

  return {
    record(botId: string, absolutePath: string): void {
      const at = now();
      for (const [entry, writtenAt] of writes) {
        if (at - writtenAt > KEEP_MS) writes.delete(entry);
      }
      writes.set(key(botId, absolutePath), at);
    },
    /** True when this Bot wrote the file with its file tools at or after `since`. */
    wroteSince(botId: string, absolutePath: string, since: number): boolean {
      const at = writes.get(key(botId, absolutePath));
      return at !== undefined && at >= since;
    },
  };
}

export type BotOwnWrites = ReturnType<typeof createBotOwnWrites>;

/** Process-wide journal: the Bot tool sources write it, the folder watch reads it. */
export const botOwnWrites = createBotOwnWrites();
