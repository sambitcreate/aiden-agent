import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentHarnessResources } from "./pi-legacy-harness.js";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import * as path from "node:path";
import { findSkillByName, modelInvocableSkills, type RegisteredSkill, type SkillRegistrySnapshot } from "./skill-registry.js";
import { SKILL_TOOL_NAME } from "./skill-registry-core.js";

export { SKILL_TOOL_NAME };

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

function skillContent(skill: RegisteredSkill): string {
  if (!skill.path) return skill.instructions;
  const base = path.dirname(skill.path);
  return [
    `<skill_content name="${skill.name.replace(/"/g, "&quot;")}">`,
    skill.instructions,
    "",
    `Base directory for this skill: ${base}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "</skill_content>",
  ].join("\n");
}

/**
 * One tool for every skill: the system prompt lists the skills, and the model
 * passes the listed name. A skill not in `skills` (a user-only skill, or one a
 * Bot was not granted) cannot be loaded, whatever name the model sends.
 */
export function makeSkillTool(
  skills: readonly RegisteredSkill[],
  isEnabled: () => Promise<boolean> = async () => true,
): AgentTool {
  return declarePiRuntimeReplay(
    {
      name: SKILL_TOOL_NAME,
      label: "Load skill",
      description:
        "Load a skill's detailed instructions before doing a task it covers. Pass a name from <available_skills> in the system prompt.",
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 256 }) }),
      execute: async (_id, args): Promise<AgentToolResult<null>> => {
        if (!(await isEnabled())) throw new Error("Skills are disabled in Settings → Skills.");
        const requested = typeof (args as { name?: unknown })?.name === "string" ? (args as { name: string }).name : "";
        const skill = findSkillByName(skills, requested);
        if (!skill) {
          const names = skills.slice(0, 40).map(({ name }) => name).join(", ");
          throw new Error(`No skill named "${requested.slice(0, 80)}" is available here. Available: ${names}.`);
        }
        if (skill.modelInvocable === false) throw new Error("This skill does not allow model invocation.");
        return textResult(skillContent(skill));
      },
    },
    "safe",
  );
}

/** The `skill` tool when at least one skill may be loaded by the model, else nothing. */
export function buildSkillTools(
  snapshot: SkillRegistrySnapshot,
  allowWorkspaceSkills = true,
  isEnabled: () => Promise<boolean> = async () => true,
): AgentTool[] {
  const skills = modelInvocableSkills(snapshot, allowWorkspaceSkills);
  return skills.length > 0 ? [makeSkillTool(skills, isEnabled)] : [];
}

export function piResourcesForSkillSnapshot(
  snapshot: SkillRegistrySnapshot | undefined,
): AgentHarnessResources {
  if (!snapshot) return {};
  return {
    // Pi resources promise a truthful filePath. Configured database skills
    // keep their existing leased invocation path until Pi supports in-memory
    // resource locations.
    skills: snapshot.available
      .filter((skill) => skill.modelInvocable !== false && Boolean(skill.path))
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        content: skill.instructions,
        filePath: skill.path!,
      })),
  };
}
