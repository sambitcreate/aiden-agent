import { createHmac } from "node:crypto";
import { BOT_CAPABILITY_LIMITS } from "../../renderer/shared/bot-capabilities.js";
import { resolveSkillCandidates, type SkillRegistryCandidate } from "./skill-registry-core.js";
import type { DiscoveredSkill, Skill } from "./types.js";
import type { BotResolvedSkill } from "./bot-capability-inventory-ports.js";

export interface BotSkillInventoryDependencies {
  loadIdentityKey(): Promise<Uint8Array>;
  listConfigured(): Promise<readonly Skill[]>;
  botId?: string;
  loadBotHomePath?(): Promise<string>;
  discover(workspaceRoot?: string): Promise<readonly DiscoveredSkill[]>;
}

function configuredCandidate(skill: Skill): SkillRegistryCandidate {
  return {
    stableId: `configured:${skill.id}`,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    source: "configured",
    enabled: skill.enabled,
  };
}

function discoveredCandidate(skill: DiscoveredSkill): SkillRegistryCandidate {
  return {
    stableId: skill.id,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    source: skill.source,
    enabled: true,
    path: skill.path,
  };
}

function safeSourceId(key: Uint8Array, candidate: SkillRegistryCandidate): string {
  return `skill:${createHmac("sha256", key)
    .update("aiden-bot-skill-source-v1\0")
    .update(candidate.source)
    .update("\0")
    .update(candidate.stableId)
    .digest("base64url")}`;
}

/** Resolve configured/global skills plus only the selected Bot's managed-home skills. */
export async function resolveBotCapabilitySkills(
  dependencies: BotSkillInventoryDependencies,
): Promise<readonly BotResolvedSkill[]> {
  const [key, configured, home, globalDiscovered] = await Promise.all([
    dependencies.loadIdentityKey(),
    dependencies.listConfigured(),
    dependencies.loadBotHomePath?.(),
    dependencies.discover(undefined),
  ]);
  if (key.byteLength !== 32) throw new Error("Bot skill identity key is invalid.");
  const workspaceDiscovered = home
    ? (await dependencies.discover(home)).filter(({ source }) => source === "workspace")
    : [];
  const candidates = [
    ...configured.map(configuredCandidate),
    ...globalDiscovered.filter(({ source }) => source === "global").map(discoveredCandidate),
    ...workspaceDiscovered.map(discoveredCandidate),
  ];
  return resolveSkillCandidates(candidates)
    .slice(0, BOT_CAPABILITY_LIMITS.skills)
    .map((skill) => ({
      sourceId: safeSourceId(key, skill),
      label: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      available: skill.available,
      incarnationPartition:
        skill.source === "workspace" ? `bot:${dependencies.botId}` : "global",
    }));
}
