// Assembles the pi agent tool set for a generation: Exa web search + Agent
// Skills + MCP server tools, based on current settings. Empty when nothing is
// enabled.
//
// Tool inputs use typebox schemas (pi's AgentTool.parameters). MCP tools wrap
// their raw JSON Schema via Type.Unsafe (see mcp.ts).

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import * as fs from "fs/promises";
import * as path from "path";
import { configStore } from "./config-store.js";
import { secrets } from "./secrets.js";
import { collectMcpAgentTools } from "./mcp.js";
import { buildCodingTools } from "./coding-tools.js";
import { discoverSkills } from "./skills-discovery.js";
import type { DiscoveredSkill, Skill, WorkspacePermission } from "./types.js";
import type { ComputerUseController } from "./computer-use/controller.js";
import { createComputerUseAgentTool } from "./computer-use/tool.js";
import { scheduleTaskToolsForContext } from "./schedule-tool.js";
import { registerSubagentTool } from "./subagents/feature-flag.js";
import { buildSubagentCapabilityTools } from "./subagents/capability-tools.js";
import type { SubagentCapabilityRequest } from "./subagents/capability-profile.js";
import { createAssistantProjectTool } from "./assistant/project-tool.js";
import { createAssistantMcpServerTool } from "./assistant/mcp-tool.js";
import { selectedMcpServers } from "./mcp-selection.js";

const EXA_ENDPOINT = "https://api.exa.ai/search";

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

export function skillToolKey(skill: Skill | DiscoveredSkill): string {
  const slugify = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
  const slug = slugify(skill.name);
  // Names without any ASCII alphanumeric characters (e.g. CJK-only) slug to
  // nothing; fall back to the id so the tool name stays API-valid.
  return `skill_${slug || slugify(skill.id) || "unnamed"}`;
}

function makeExaTool(apiKey: string): AgentTool {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for current, real-world information using Exa. Use when the user asks about recent events, facts you're unsure of, or anything that benefits from up-to-date sources.",
    parameters: Type.Object({
      query: Type.String({ description: "The web search query." }),
      numResults: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          description: "How many results to return (default 5).",
        }),
      ),
    }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { query, numResults } = params as { query: string; numResults?: number };
      const response = await fetch(EXA_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          query,
          numResults: numResults ?? 5,
          contents: { text: { maxCharacters: 1200 } },
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Exa search failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
        );
      }
      const data = (await response.json()) as {
        results?: Array<{ title?: string; url?: string; text?: string }>;
      };
      const results = (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        text: (r.text ?? "").slice(0, 1200),
      }));
      return textResult(JSON.stringify({ results }));
    },
  };
}

const SKILL_FILE_SAMPLE_LIMIT = 10;

/** Supporting files bundled next to a discovered skill's SKILL.md (sampled). */
async function listSkillSupportingFiles(skillMdPath: string): Promise<string[]> {
  const dir = path.dirname(skillMdPath);
  const files: string[] = [];
  try {
    for await (const entry of fs.glob("**/*", { cwd: dir, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const absolute = path.join(entry.parentPath, entry.name);
      if (absolute === skillMdPath) continue;
      files.push(absolute);
      if (files.length >= SKILL_FILE_SAMPLE_LIMIT) break;
    }
  } catch {
    // Unreadable skill directory — the instructions still stand alone.
  }
  return files.sort();
}

function makeSkillTool(skill: Skill | DiscoveredSkill): AgentTool {
  const summary = skill.description ? `${skill.name}: ${skill.description}` : skill.name;
  return {
    name: skillToolKey(skill),
    label: skill.name,
    description: `${summary} — call this to load detailed instructions before performing the task.`,
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<null>> => {
      if (!("path" in skill)) return textResult(skill.instructions);
      // Discovered skill: mirror opencode's skill tool output — instructions
      // plus the base directory and a sample of bundled files, so relative
      // paths like scripts/ or reference/ inside the skill stay usable.
      const base = path.dirname(skill.path);
      const files = await listSkillSupportingFiles(skill.path);
      return textResult(
        [
          `<skill_content name="${skill.name.replace(/"/g, "&quot;")}">`,
          skill.instructions,
          "",
          `Base directory for this skill: ${base}`,
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
          ...(files.length > 0
            ? ["", "Files bundled with this skill (sampled):", ...files.map((file) => `- ${file}`)]
            : []),
          "</skill_content>",
        ].join("\n"),
      );
    },
  };
}

/** Context describing where and how much the agent may act. */
export interface ToolContext {
  /** Workspace identity used as the default target for agent-created schedules. */
  workspaceId?: string;
  /** Absolute path to the workspace folder, if one is bound. */
  workspaceRoot?: string;
  /** Workspace permission level; "none" withholds all folder-scoped tools. */
  permission: WorkspacePermission;
  /** Optional generation-owned controller. Omitted until Computer Use is explicitly enabled. */
  computerUse?: ComputerUseController;
  /** Background scheduled runs disable this to prevent recursive task creation. */
  allowScheduling?: boolean;
  /** Read-only background runs withhold MCP tools because their mutation semantics are unknown. */
  allowMcpTools?: boolean;
  /** Exact configured server identities approved for this unattended generation. */
  mcpServerIds?: readonly string[];
  /** Only a foreground, persisted-workspace generation may register the delegation tool. */
  allowSubagents?: boolean;
  /**
   * Assistant modes use positive allowlists rather than the workspace set minus
   * exclusions, so ambient tools cannot appear there by default.
   */
  mode?: "assistant" | "assistant-automation" | "subagent";
  /** Lazily constructed so the disabled feature flag prevents registration entirely. */
  createSubagentTool?: () => AgentTool;
  /**
   * When present, bypasses normal workspace/ambient assembly and positively
   * constructs only the resolved child capability intersection.
   */
  capabilityProfile?: SubagentCapabilityRequest | unknown;
}

export function buildSchedulingTools(
  context: Pick<ToolContext, "workspaceId" | "allowScheduling" | "mode">,
): AgentTool[] {
  return scheduleTaskToolsForContext({
    workspaceId: context.workspaceId,
    allowScheduling: context.allowScheduling,
    mode: context.mode === "assistant" ? "assistant-attended" : "standard",
  });
}

async function configuredMcpTools(ctx: ToolContext): Promise<AgentTool[]> {
  const servers = selectedMcpServers(await configStore.listMcpServers(), ctx.mcpServerIds);
  return collectMcpAgentTools(servers, { strict: ctx.mcpServerIds !== undefined });
}

export async function buildAgentTools(ctx: ToolContext): Promise<AgentTool[]> {
  const hasCapabilityProfile = Object.prototype.hasOwnProperty.call(ctx, "capabilityProfile");
  if (ctx.mode === "subagent" || hasCapabilityProfile) {
    if (ctx.mode !== "subagent") {
      throw new Error("Subagent capabilities require the explicit subagent tool mode.");
    }
    return buildSubagentCapabilityTools({
      workspaceRoot: ctx.workspaceRoot,
      permission: ctx.permission,
      capabilityProfile: ctx.capabilityProfile,
    }).tools;
  }
  if (ctx.mode !== undefined && ctx.mode !== "assistant" && ctx.mode !== "assistant-automation") {
    throw new Error(`Unknown agent tool mode: ${JSON.stringify(ctx.mode)}.`);
  }

  // Aiden receives a positive allowlist. The attended dock may inspect MCP
  // server identities and propose a narrowly constrained scheduled task. An
  // unattended global automation receives only the exact MCP servers approved
  // on that task.
  if (ctx.mode === "assistant") {
    const tools =
      ctx.allowScheduling === false
        ? []
        : [
            createAssistantProjectTool(),
            createAssistantMcpServerTool(),
            ...buildSchedulingTools(ctx),
          ];
    if (ctx.allowMcpTools === true) tools.push(...(await configuredMcpTools(ctx)));
    return tools;
  }

  // An approved project automation receives folder-scoped coding tools and,
  // only when explicitly selected on the task, exact MCP server tools.
  if (ctx.mode === "assistant-automation") {
    const tools =
      ctx.workspaceRoot && ctx.permission !== "none" ? buildCodingTools(ctx.workspaceRoot) : [];
    if (ctx.allowMcpTools === true) tools.push(...(await configuredMcpTools(ctx)));
    return tools;
  }

  const tools: AgentTool[] = [];
  if (ctx.computerUse) tools.push(createComputerUseAgentTool(ctx.computerUse));
  tools.push(...buildSchedulingTools(ctx));
  if (ctx.allowSubagents === true) {
    registerSubagentTool(tools, ctx.createSubagentTool);
  }

  // Folder-scoped coding tools (read/write/edit/list/glob/grep/run_command).
  // Withheld entirely when permission is "none" or no folder is bound.
  if (ctx.workspaceRoot && ctx.permission !== "none") {
    tools.push(...buildCodingTools(ctx.workspaceRoot));
  }

  const settings = await configStore.getSettings();

  // Exa web search.
  if (settings.exaEnabled) {
    const key = await secrets.getKey("exa");
    if (key) tools.push(makeExaTool(key));
  }

  // Agent Skills — each enabled skill becomes a tool that returns its instructions.
  // Config-defined skills first, then skills discovered on disk (see
  // skills-discovery.ts for the scanned roots). Dedupe by tool key so a disk
  // skill can't collide with a configured one.
  const seenSkillKeys = new Set<string>();
  const skills = await configStore.listSkills();
  for (const skill of skills) {
    if (!skill.enabled) continue;
    const key = skillToolKey(skill);
    if (seenSkillKeys.has(key)) continue;
    seenSkillKeys.add(key);
    tools.push(makeSkillTool(skill));
  }

  const discovered = await discoverSkills(ctx.workspaceRoot);
  for (const skill of discovered) {
    const key = skillToolKey(skill);
    if (seenSkillKeys.has(key)) continue;
    seenSkillKeys.add(key);
    tools.push(makeSkillTool(skill));
  }

  // MCP server tools.
  if (ctx.allowMcpTools !== false) {
    tools.push(...(await configuredMcpTools(ctx)));
  }

  return tools;
}
