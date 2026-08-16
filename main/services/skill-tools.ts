import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import * as path from "node:path";
import type { RegisteredSkill, SkillRegistrySnapshot } from "./skill-registry.js";
import { skillToolKey } from "./skill-registry-core.js";

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

export function makeSkillTool(skill: RegisteredSkill): AgentTool {
  const summary = skill.description ? `${skill.name}: ${skill.description}` : skill.name;
  return declarePiRuntimeReplay({
    name: skillToolKey(skill),
    label: skill.name,
    description: `${summary} — call this to load detailed instructions before performing the task.`,
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<null>> => {
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
  }, "safe");
}

export function buildSkillTools(
  snapshot: SkillRegistrySnapshot,
  allowWorkspaceSkills = true,
): AgentTool[] {
  return snapshot.available
    .filter((skill) => allowWorkspaceSkills || skill.source !== "workspace")
    .map(makeSkillTool);
}
