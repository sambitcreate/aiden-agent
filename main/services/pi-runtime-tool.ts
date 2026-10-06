import type { PiDiscoverableTool } from "./pi-tool-discovery.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export type PiRuntimeReplayPolicy = "safe" | "never";

export type PiRuntimeTool = AgentTool & {
  /** Crash-recovery policy. Omission and unknown values always mean never replay. */
  readonly replay?: PiRuntimeReplayPolicy;
  /** Explicit host admission for programmatic tool calls; never inferred from a remote tool name. */
  readonly codemode?: boolean;
};

const CODEMODE_WORKSPACE_TOOLS = new Set([
  "read_file", "list_dir", "glob", "grep", "write_file", "edit_file", "run_command",
]);

export function isPiCodemodeCallable(tool: AgentTool): boolean {
  const admission = (tool as PiRuntimeTool).codemode;
  return tool.name !== "codemode" && admission !== false &&
    (admission === true || CODEMODE_WORKSPACE_TOOLS.has(tool.name));
}

/** Apply only after host/model exclusions. Without codemode, tools stay directly declared. */
export function partitionPiCodemodeTools(tools: readonly AgentTool[]): { declared: AgentTool[]; deferred: AgentTool[] } {
  const enabled = tools.some((tool) => tool.name === "codemode");
  const declared: AgentTool[] = [];
  const deferred: AgentTool[] = [];
  for (const tool of tools) {
    (enabled && (tool as PiRuntimeTool).codemode === true && Boolean((tool as PiDiscoverableTool).discovery) && isPiCodemodeCallable(tool) ? deferred : declared).push(tool);
  }
  return { declared, deferred };
}

export function piRuntimeReplayPolicy(tool: unknown): PiRuntimeReplayPolicy {
  return typeof tool === "object" && tool !== null && (tool as PiRuntimeTool).replay === "safe"
    ? "safe"
    : "never";
}

export function declarePiRuntimeReplay<T extends AgentTool>(
  tool: T,
  replay: PiRuntimeReplayPolicy,
): T & PiRuntimeTool {
  return Object.assign(tool, { replay }) as T & PiRuntimeTool;
}
