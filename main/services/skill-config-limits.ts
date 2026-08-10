import { SLASH_LIMITS, normalizeSafeSkillText } from "../../renderer/shared/slash-commands.js";
import { MAX_CONFIG_ID_LENGTH, type Skill } from "./types.js";

export const CONFIGURED_SKILL_LIMITS = Object.freeze({
  entries: SLASH_LIMITS.catalogEntries,
  aggregateBytes: 16 * 1024 * 1024,
});

export function configuredSkillBytes(
  skill: Pick<Skill, "id" | "name" | "description" | "instructions">,
): number {
  return (
    Buffer.byteLength(skill.id, "utf8") +
    Buffer.byteLength(skill.name, "utf8") +
    Buffer.byteLength(skill.description, "utf8") +
    Buffer.byteLength(skill.instructions, "utf8")
  );
}

export function isConfiguredSkill(value: unknown): value is Skill {
  if (typeof value !== "object" || value === null) return false;
  const skill = value as Record<string, unknown>;
  if (
    typeof skill.id !== "string" ||
    !skill.id.trim() ||
    skill.id.length > MAX_CONFIG_ID_LENGTH ||
    typeof skill.name !== "string" ||
    typeof skill.description !== "string" ||
    typeof skill.instructions !== "string" ||
    typeof skill.enabled !== "boolean" ||
    Buffer.byteLength(skill.instructions, "utf8") > SLASH_LIMITS.instructionBytes
  ) {
    return false;
  }
  try {
    normalizeSafeSkillText(skill.name, "skill name", SLASH_LIMITS.safeNameCharacters);
    normalizeSafeSkillText(
      skill.description,
      "skill description",
      SLASH_LIMITS.safeDescriptionCharacters,
      true,
    );
    return true;
  } catch {
    return false;
  }
}

export function isConfiguredSkillList(value: unknown): value is Skill[] {
  if (!Array.isArray(value) || value.length > CONFIGURED_SKILL_LIMITS.entries) return false;
  const ids = new Set<string>();
  let aggregateBytes = 0;
  for (const candidate of value) {
    if (!isConfiguredSkill(candidate) || ids.has(candidate.id)) return false;
    ids.add(candidate.id);
    aggregateBytes += configuredSkillBytes(candidate);
    if (aggregateBytes > CONFIGURED_SKILL_LIMITS.aggregateBytes) return false;
  }
  return true;
}
