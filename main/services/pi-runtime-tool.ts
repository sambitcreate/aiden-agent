import type { AgentTool } from "@earendil-works/pi-agent-core";

export type PiRuntimeReplayPolicy = "safe" | "never";

export type PiRuntimeTool = AgentTool & {
  /** Crash-recovery policy. Omission and unknown values always mean never replay. */
  readonly replay?: PiRuntimeReplayPolicy;
};

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
