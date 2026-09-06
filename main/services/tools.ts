// Assembles the pi agent tool set for a generation: Web Search + Agent Skills +
// MCP server tools, based on current settings. Empty when nothing is enabled.
//
// Tool inputs use typebox schemas (pi's AgentTool.parameters). MCP tools wrap
// their raw JSON Schema via Type.Unsafe (see mcp.ts).

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { configStore } from "./config-store.js";
import { collectMcpAgentTools } from "./mcp.js";
import { buildCodingTools } from "./coding-tools.js";
import type { ScheduledMcpServerBinding, WorkspacePermission } from "./types.js";
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
import { buildTelegramAgentTools } from "./telegram/telegram-agent-tools.js";
import { createShareImageTool } from "./share-image-tool.js";
import type { Attachment } from "./types.js";
import { webSearchService } from "./web-search-main.js";

export { skillToolKey } from "./skill-registry-core.js";

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
  const servers = selectedMcpServers(await configStore.listMcpServers(), ctx.mcpServerIds);
  if (ctx.mcpServerBindings) assertScheduledMcpServerBindings(servers, ctx.mcpServerBindings);
  return collectMcpAgentTools(servers, {
    strict: ctx.mcpServerIds !== undefined,
  });
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
      throw new Error("Assistant project automations cannot use MCP connectors.");
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
  if (ctx.allowScheduling !== false) {
    tools.push(createAssistantProjectTool(), createAssistantMcpServerTool());
  }
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

  const webSearchTool = await webSearchService.toolForGeneration();
  if (webSearchTool) tools.push(webSearchTool);

  // Every skill consumer uses this exact authoritative snapshot.
  const skillsEnabled = async () => (await configStore.getSettings()).skillsEnabled !== false;
  const skillSnapshot =
    ctx.includeSkillTools !== false && (await skillsEnabled())
      ? (ctx.skillSnapshot ??
        (ctx.workspaceId ? await skillRegistry.snapshot(ctx.workspaceId) : undefined))
      : undefined;
  if (ctx.includeSkillTools !== false && skillSnapshot) {
    tools.push(...buildSkillTools(skillSnapshot, ctx.permission !== "none", skillsEnabled));
  }

  // MCP server tools.
  if (ctx.allowMcpTools !== false) {
    tools.push(...(await configuredMcpTools(ctx)));
  }

  return tools;
}
