// Assembles the pi agent tool set for a generation: Exa web search + Agent
// Skills + MCP server tools, based on current settings. Empty when nothing is
// enabled.
//
// Tool inputs use typebox schemas (pi's AgentTool.parameters). MCP tools wrap
// their raw JSON Schema via Type.Unsafe (see mcp.ts).

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { configStore } from "./config-store.js";
import { secrets } from "./secrets.js";
import { collectMcpAgentTools } from "./mcp.js";
import { buildCodingTools } from "./coding-tools.js";
import { discoverSkills } from "./skills-discovery.js";
import type { DiscoveredSkill, Skill, WorkspacePermission } from "./types.js";

const EXA_ENDPOINT = "https://api.exa.ai/search";

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

function skillToolKey(skill: Skill | DiscoveredSkill): string {
  const slug = skill.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return `skill_${slug || skill.id}`;
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
        Type.Integer({ minimum: 1, maximum: 10, description: "How many results to return (default 5)." }),
      ),
    }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { query, numResults } = params as { query: string; numResults?: number };
      const response = await fetch(EXA_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ query, numResults: numResults ?? 5, contents: { text: { maxCharacters: 1200 } } }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Exa search failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
        );
      }
      const data = (await response.json()) as { results?: Array<{ title?: string; url?: string; text?: string }> };
      const results = (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        text: (r.text ?? "").slice(0, 1200),
      }));
      return textResult(JSON.stringify({ results }));
    },
  };
}

function makeSkillTool(skill: Skill | DiscoveredSkill): AgentTool {
  const summary = skill.description ? `${skill.name}: ${skill.description}` : skill.name;
  return {
    name: skillToolKey(skill),
    label: skill.name,
    description: `${summary} — call this to load detailed instructions before performing the task.`,
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<null>> => textResult(skill.instructions),
  };
}

/** Context describing where and how much the agent may act. */
export interface ToolContext {
  /** Absolute path to the workspace folder, if one is bound. */
  workspaceRoot?: string;
  /** Workspace permission level; "none" withholds all folder-scoped tools. */
  permission: WorkspacePermission;
}

export async function buildAgentTools(ctx: ToolContext): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  const settings = await configStore.getSettings();

  // Folder-scoped coding tools (read/write/edit/list/glob/grep/run_command).
  // Withheld entirely when permission is "none" or no folder is bound.
  if (ctx.workspaceRoot && ctx.permission !== "none") {
    tools.push(...buildCodingTools(ctx.workspaceRoot));
  }

  // Exa web search.
  if (settings.exaEnabled) {
    const key = await secrets.getKey("exa");
    if (key) tools.push(makeExaTool(key));
  }

  // Agent Skills — each enabled skill becomes a tool that returns its instructions.
  // Config-defined skills first, then skills discovered on disk (workspace +
  // global `.agents` folders). Dedupe by tool key so a disk skill can't collide
  // with a configured one.
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
  const servers = await configStore.listMcpServers();
  tools.push(...(await collectMcpAgentTools(servers)));

  return tools;
}
