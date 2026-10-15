// One-time marker for the startup wipe of legacy Bot transcripts.
//
// Durable Bot sessions replaced the ChatStore + Pi JSONL Bot run path. The
// wipe (in BotApplicationService.initialize) empties what that path wrote and
// then publishes this marker, so it never runs again on this profile.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "./durable-fs.js";

export const BOT_LEGACY_TRANSCRIPT_WIPE_MARKER = "bot-legacy-transcripts-wiped.json";

export function createBotLegacyTranscriptWipeMarker(root: () => string) {
  const marker = () => path.join(root(), BOT_LEGACY_TRANSCRIPT_WIPE_MARKER);
  return {
    async isDone(): Promise<boolean> {
      try {
        const info = await fs.lstat(marker());
        return info.isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async markDone(): Promise<void> {
      await writeFileAtomic(marker(), `${JSON.stringify({ version: 1, wipedAt: Date.now() })}\n`, {
        mode: 0o600,
      });
    },
  };
}
