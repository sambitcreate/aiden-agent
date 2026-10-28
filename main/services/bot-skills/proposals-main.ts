// Production wiring of Bot skill review. A skill found in a Bot's folder that
// nobody approved waits for the person: one card per skill, offered once per
// content (spec 2026-10-27 §7 L0, L2).

import type { DiscoveredSkill } from "../types.js";
import { botSkillContentFingerprint } from "../bot-skill-approvals.js";

const offered = new Set<string>();

export async function reviewHomeSkills(botId: string, found: readonly DiscoveredSkill[]): Promise<void> {
  const { botSkillProposals } = await import("./skill-proposals-main.js");
  for (const skill of found) {
    const key = `${botId}\0${skill.id}\0${botSkillContentFingerprint(skill)}`;
    if (offered.has(key)) continue;
    offered.add(key);
    await botSkillProposals.reviewExisting(botId, skill);
  }
}
