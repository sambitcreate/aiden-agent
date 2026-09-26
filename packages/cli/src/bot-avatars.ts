import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { createFileBotAvatarStore } from "../../../main/services/bot-avatar-store.js";
import { createBotAvatarApplicationAdapter } from "../../../main/services/bot-avatar-application-adapter.js";
import { inspectCanonicalBotAvatarPng, BotAvatarInputError } from "../../../main/services/bot-avatar-store-core.js";

export function createCliBotAvatars(agentDir: string, ownerId: string) {
  let active = 0;
  const store = createFileBotAvatarStore({ root: () => join(agentDir, "bot-avatars"), normalizer: {
    async normalize(source) {
      if (active >= 2) throw new Error("Bot photo processing is busy. Try again shortly.");
      active++;
      try {
        const worker = new Worker(join(dirname(process.env.AIDEN_CLI_ENTRY!), "avatar-worker.js"), { workerData: source,
          resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await new Promise<Buffer>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Bot photo decoding timed out.")), 15_000);
            worker.once("error", reject);
            worker.once("exit", () => reject(new Error("Bot photo decoder exited without an image.")));
            worker.once("message", (value) => {
              try { const bytes = Buffer.from(value); inspectCanonicalBotAvatarPng(bytes); resolve(bytes); }
              catch (error) { reject(error); }
            });
          });
        } catch { throw new BotAvatarInputError("That Bot photo could not be decoded safely."); }
        finally { clearTimeout(timer); await worker.terminate(); }
      } finally { active--; }
    },
  } });
  return createBotAvatarApplicationAdapter({ store, ownerId });
}
