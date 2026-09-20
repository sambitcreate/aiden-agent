// System prompt assembly for chat generations and for ambient context
// estimates (context meter). Kept dependency-free of llm-client so services
// that only need the static prompt do not import the generation pipeline.

import { BROWSER_AGENT_GUIDANCE } from "./browser-tools.js";
import { PI_CHAT_SYSTEM_PROMPT } from "./response-format-guidance.js";
import { formatAvailableSkills, type SkillRegistrySnapshot } from "./skill-registry.js";
import { SUBAGENT_PARENT_SECURITY_GUIDANCE } from "./subagents/role-catalog.js";
import type { WorkspacePermission } from "./types.js";

export type ChatSystemPromptPermission = WorkspacePermission | "read-only";

export async function buildSystemPrompt(
  folderPath: string | undefined,
  branch: string | undefined,
  permission: ChatSystemPromptPermission,
  subagentsAvailable: boolean,
  skillsAvailable = true,
  skillSnapshot?: SkillRegistrySnapshot,
  availableToolNames?: ReadonlySet<string>,
): Promise<string> {
  const base = PI_CHAT_SYSTEM_PROMPT;
  const skillsText =
    skillsAvailable && skillSnapshot
      ? formatAvailableSkills(skillSnapshot, availableToolNames)
      : undefined;
  const skillsSuffix = skillsText ? `\n\n${skillsText}` : "";
  const browserSuffix = availableToolNames?.has("browser_open")
    ? `\n\n${BROWSER_AGENT_GUIDANCE}`
    : "";
  if (!folderPath || permission === "none") {
    return `${base} Call the available tools when they help answer the user's request.${skillsSuffix}${browserSuffix}`;
  }
  const git = branch ? ` It is a git repository on branch \`${branch}\`.` : "";
  const capability =
    permission === "read-only"
      ? "You have tools to read, search, and list files in this folder. You cannot edit files or run commands. "
      : "You have tools to read, search, list, and edit files and to run shell commands in this folder. ";
  const workflow =
    permission === "read-only"
      ? "All file paths are relative to this folder. If the request requires a mutation, explain that this scheduled run is read-only."
      : "All file paths are relative to this folder. Prefer editing existing files over creating new ones, read a file before editing it, and keep changes surgical. ";
  const delegation = subagentsAvailable
    ? ` Use the subagent tool for independent bounded investigation, comparison, planning, or fresh review—not trivial work—and always reconcile its ordered results yourself. ${SUBAGENT_PARENT_SECURITY_GUIDANCE}`
    : "";
  return (
    `${base}\n\n` +
    `You are working inside the folder: ${folderPath}.${git} ` +
    capability +
    workflow +
    (permission === "ask"
      ? "The user must approve each file write and shell command before it runs."
      : permission === "full"
        ? "You may make changes and run commands directly."
        : "") +
    delegation +
    skillsSuffix +
    browserSuffix
  );
}
