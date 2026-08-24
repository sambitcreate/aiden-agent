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
import type {
  ScheduledMcpServerBinding,
  WorkspacePermission,
} from "./types.js";
import type { SkillRegistrySnapshot } from "./skill-registry.js";
import { skillRegistry } from "./skill-registry-main.js";
import { buildSkillTools } from "./skill-tools.js";
import type { ComputerUseController } from "./computer-use/controller.js";
import { createComputerUseAgentTool } from "./computer-use/tool.js";
import {
  scheduleTaskToolsForContext,
  type AssistantScheduleModelSelection,
} from "./schedule-tool.js";
import { registerSubagentTool } from "./subagents/feature-flag.js";
import { buildSubagentCapabilityTools } from "./subagents/capability-tools.js";
import type { SubagentCapabilityRequest } from "./subagents/capability-profile.js";
import { createAssistantProjectTool } from "./assistant/project-tool.js";
import { createAssistantMcpServerTool } from "./assistant/mcp-tool.js";
import { selectedMcpServers } from "./mcp-selection.js";
import { assertScheduledMcpServerBindings } from "./schedule-mcp-binding.js";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import { buildTelegramAgentTools } from "./telegram/telegram-agent-tools.js";
import { createShareImageTool } from "./share-image-tool.js";
import type { Attachment } from "./types.js";

const EXA_ENDPOINT = "https://api.exa.ai/search";

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

export { skillToolKey } from "./skill-registry-core.js";

function makeExaTool(apiKey: string): AgentTool {
  return declarePiRuntimeReplay({
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
    execute: async (_id, params, signal): Promise<AgentToolResult<null>> => {
      const { query, numResults } = params as {
        query: string;
        numResults?: number;
      };
      const response = await fetch(EXA_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          query,
          numResults: numResults ?? 5,
          contents: { text: { maxCharacters: 1200 } },
        }),
        signal,
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
  }, "never");
}

/** Context describing where and how much the agent may act. */
export interface ToolContext {
  /** Workspace identity used as the default target for agent-created schedules. */
  workspaceId?: string;
  /** Absolute path to the workspace folder, if one is bound. */
  workspaceRoot?: string;
  /** Generation-scoped skill snapshot shared with prompt disclosure. */
  skillSnapshot?: SkillRegistrySnapshot;
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
  /** Exact connection fingerprints approved for this unattended generation. */
  mcpServerBindings?: readonly ScheduledMcpServerBinding[];
  /** Only a foreground, persisted-workspace generation may register the delegation tool. */
  allowSubagents?: boolean;
  /**
   * Assistant modes use positive allowlists rather than the workspace set minus
   * exclusions, so ambient tools cannot appear there by default.
   */
  mode?: "assistant" | "assistant-automation" | "subagent";
  /** Main-resolved generation identity pinned on new or edited Assistant schedules. */
  assistantModelSelection?: AssistantScheduleModelSelection;
  /** Lazily constructed so the disabled feature flag prevents registration entirely. */
  createSubagentTool?: () => AgentTool;
  /**
   * When present, bypasses normal workspace/ambient assembly and positively
   * constructs only the resolved child capability intersection.
   */
  capabilityProfile?: SubagentCapabilityRequest | unknown;
  interactionSurface?: "telegram";
  /** Explicitly expose cross-target Telegram delivery to attended local agents. */
  allowTelegramDirect?: boolean;
  /** Generation-scoped sink for assistant images that become durable with the final response. */
  shareImage?: (attachment: Attachment) => void;
  /** Main-owned Bot assembly supplies its own exact multi-root file tools. */
  includeCodingTools?: boolean;
  /** Main-owned Bot assembly may withhold skills until exact grants are joined. */
  includeSkillTools?: boolean;
  /** Host-constructed, current-generation image tool. Never accepts paths or URLs. */
  imageInspectionTool?: AgentTool;
}

export function buildSchedulingTools(
  context: Pick<
    ToolContext,
    "workspaceId" | "allowScheduling" | "mode" | "assistantModelSelection"
  >,
): AgentTool[] {
  return scheduleTaskToolsForContext({
    workspaceId: context.workspaceId,
    allowScheduling: context.allowScheduling,
    mode: context.mode === "assistant" ? "assistant-attended" : "standard",
    assistantModelSelection: context.assistantModelSelection,
  });
}

async function configuredMcpTools(ctx: ToolContext): Promise<AgentTool[]> {
  const servers = selectedMcpServers(
    await configStore.listMcpServers(),
    ctx.mcpServerIds,
  );
  if (ctx.mcpServerBindings)
    assertScheduledMcpServerBindings(servers, ctx.mcpServerBindings);
  return collectMcpAgentTools(servers, {
    strict: ctx.mcpServerIds !== undefined,
  });
}

export async function buildAgentTools(ctx: ToolContext): Promise<AgentTool[]> {
  const hasCapabilityProfile = Object.prototype.hasOwnProperty.call(
    ctx,
    "capabilityProfile",
  );
  if (ctx.mode === "subagent" || hasCapabilityProfile) {
    if (ctx.mode !== "subagent") {
      throw new Error(
        "Subagent capabilities require the explicit subagent tool mode.",
      );
    }
    return buildSubagentCapabilityTools({
      workspaceRoot: ctx.workspaceRoot,
      permission: ctx.permission,
      capabilityProfile: ctx.capabilityProfile,
    }).tools;
  }
  if (
    ctx.mode !== undefined &&
    ctx.mode !== "assistant" &&
    ctx.mode !== "assistant-automation"
  ) {
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
    if (ctx.allowMcpTools === true)
      tools.push(...(await configuredMcpTools(ctx)));
    if (ctx.interactionSurface === "telegram" || ctx.allowTelegramDirect === true) {
      tools.push(...buildTelegramAgentTools());
    }
    return tools;
  }

  // An approved project automation receives folder-scoped coding tools only.
  // Project and connector scopes are intentionally separate so untrusted data
  // from an external service cannot flow into project mutation tools.
  if (ctx.mode === "assistant-automation") {
    if (ctx.allowMcpTools === true || (ctx.mcpServerIds?.length ?? 0) > 0) {
      throw new Error(
        "Assistant project automations cannot use MCP connectors.",
      );
    }
    const tools =
      ctx.workspaceRoot && ctx.permission !== "none" ? buildCodingTools(ctx.workspaceRoot) : [];
    if (ctx.interactionSurface === "telegram" || ctx.allowTelegramDirect === true) {
      tools.push(...buildTelegramAgentTools());
    }
    return tools;
  }

  const tools: AgentTool[] = [];
  if (ctx.imageInspectionTool) tools.push(ctx.imageInspectionTool);
  if (ctx.allowTelegramDirect === true) tools.push(...buildTelegramAgentTools());
  if (ctx.computerUse) tools.push(createComputerUseAgentTool(ctx.computerUse));
  tools.push(...buildSchedulingTools(ctx));
  if (ctx.allowSubagents === true) {
    registerSubagentTool(tools, ctx.createSubagentTool);
  }

  // Folder-scoped coding tools (read/write/edit/list/glob/grep/run_command).
  // Withheld entirely when permission is "none" or no folder is bound.
  if (ctx.includeCodingTools !== false && ctx.workspaceRoot && ctx.permission !== "none") {
    tools.push(...buildCodingTools(ctx.workspaceRoot));
    if (ctx.shareImage) {
      tools.push(createShareImageTool({ workspaceRoot: ctx.workspaceRoot, share: ctx.shareImage }));
    }
  }

  const settings = await configStore.getSettings();

  // Exa web search.
  if (settings.exaEnabled) {
    const key = await secrets.getKey("exa");
    if (key) tools.push(makeExaTool(key));
  }

  // Every skill consumer uses this exact authoritative snapshot.
  const skillSnapshot =
    ctx.skillSnapshot ??
    (ctx.workspaceId
      ? await skillRegistry.snapshot(ctx.workspaceId)
      : undefined);
  if (ctx.includeSkillTools !== false && skillSnapshot) {
    tools.push(...buildSkillTools(skillSnapshot, ctx.permission !== "none"));
  }

  // MCP server tools.
  if (ctx.allowMcpTools !== false) {
    tools.push(...(await configuredMcpTools(ctx)));
  }

  return tools;
}
