import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildSubagentCodingTools } from "../coding-tools.js";
import type { WorkspacePermission } from "../types.js";
import {
  parseSubagentCapabilityRequest,
  resolveCapabilityProfile,
  type ResolvedCapabilityProfile,
  type SubagentCapabilityRequest,
} from "./capability-profile.js";

export interface SubagentCapabilityToolContext {
  workspaceRoot?: string;
  permission: WorkspacePermission;
  capabilityProfile: SubagentCapabilityRequest | unknown;
}

export interface ResolvedSubagentCapabilityTools {
  profile: ResolvedCapabilityProfile;
  tools: AgentTool[];
}

/**
 * This is the only child tool builder. It cannot construct ambient, mutating,
 * command, scheduling, Computer Use, MCP, web, skill, or recursive tools.
 */
export function buildSubagentCapabilityTools(
  context: SubagentCapabilityToolContext,
): ResolvedSubagentCapabilityTools {
  const request = parseSubagentCapabilityRequest(context.capabilityProfile);
  const profile = resolveCapabilityProfile(request, context.permission);
  return {
    profile,
    tools:
      context.workspaceRoot && profile.tools.length > 0
        ? buildSubagentCodingTools(context.workspaceRoot, profile.tools)
        : [],
  };
}
