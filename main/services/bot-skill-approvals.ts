// Skills in a Bot's own home folder load only once the person approved that
// exact content (spec 2026-10-27 §7 L0). A Full-access Bot can write files in
// its home, so without this it could give itself a skill nobody saw.
// Kept per Bot in `<profile>/bots/<dir>/skill-approvals.json`.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { botSessionDirectory, createKeyedSerial } from "./bot-routine-notes.js";
import { writeJsonAtomic } from "./durable-fs.js";

export const BOT_SKILL_APPROVALS_FILE = "skill-approvals.json";

/** What is approved: the skill's name, description and instructions, exactly. */
export function botSkillContentFingerprint(skill: { name: string; description: string; instructions: string }): string {
  return createHash("sha256")
    .update("aiden-bot-home-skill-v1\0")
    .update(skill.name)
    .update("\0")
    .update(skill.description)
    .update("\0")
    .update(skill.instructions)
    .digest("hex");
}

export interface BotSkillApprovals {
  isApproved(botId: string, stableId: string, contentFingerprint: string): Promise<boolean>;
  approve(botId: string, stableId: string, contentFingerprint: string): Promise<void>;
  revoke(botId: string, stableId: string): Promise<void>;
  list(botId: string): Promise<Record<string, string>>;
}

export function createBotSkillApprovals(options: { profileDir(): string }): BotSkillApprovals {
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(options.profileDir(), botId), BOT_SKILL_APPROVALS_FILE);

  async function load(botId: string): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await fs.readFile(fileOf(botId), "utf8")) as { approved?: unknown };
      const approved = parsed.approved;
      if (!approved || typeof approved !== "object" || Array.isArray(approved)) return {};
      return Object.fromEntries(
        Object.entries(approved as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string" && /^[a-f0-9]{64}$/u.test(entry[1]),
        ),
      );
    } catch {
      return {};
    }
  }

  async function save(botId: string, approved: Record<string, string>): Promise<void> {
    await writeJsonAtomic(fileOf(botId), { version: 1, approved }, { mode: 0o600, mkdirMode: 0o700 });
  }

  return {
    async isApproved(botId, stableId, contentFingerprint) {
      return (await load(botId))[stableId] === contentFingerprint;
    },
    approve(botId, stableId, contentFingerprint) {
      return serial(botId, async () => save(botId, { ...(await load(botId)), [stableId]: contentFingerprint }));
    },
    revoke(botId, stableId) {
      return serial(botId, async () => {
        const approved = await load(botId);
        delete approved[stableId];
        await save(botId, approved);
      });
    },
    list: load,
  };
}
