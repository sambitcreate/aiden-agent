import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessResources, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import * as path from "node:path";
import type { RegisteredSkill, SkillRegistrySnapshot } from "./skill-registry.js";
import { skillToolKey } from "./skill-registry-core.js";

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

export function makeSkillTool(
  skill: RegisteredSkill,
  isEnabled: () => Promise<boolean> = async () => true,
): AgentTool {
  const summary = skill.description ? `${skill.name}: ${skill.description}` : skill.name;
  return declarePiRuntimeReplay(
    {
      name: skillToolKey(skill),
      label: skill.name,
      description: `${summary} — call this to load detailed instructions before performing the task.`,
      parameters: Type.Object({}),
      execute: async (): Promise<AgentToolResult<null>> => {
        if (skill.modelInvocable === false) throw new Error("This skill does not allow model invocation.");
        if (!(await isEnabled())) throw new Error("Skills are disabled in Settings → Skills.");
        if (!skill.path) return textResult(skill.instructions);
        const base = path.dirname(skill.path);
        return textResult(
          [
            `<skill_content name="${skill.name.replace(/"/g, "&quot;")}">`,
            skill.instructions,
            "",
            `Base directory for this skill: ${base}`,
            "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
            "</skill_content>",
          ].join("\n"),
        );
      },
    },
    "safe",
  );
}

export function buildSkillTools(
  snapshot: SkillRegistrySnapshot,
  allowWorkspaceSkills = true,
  isEnabled: () => Promise<boolean> = async () => true,
): AgentTool[] {
  return snapshot.available
    .filter((skill) => skill.modelInvocable !== false && (allowWorkspaceSkills || skill.source !== "workspace"))
    .map((skill) => makeSkillTool(skill, isEnabled));
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
