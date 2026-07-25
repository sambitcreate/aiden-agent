import type { OrbState } from "thinking-orbs";

export interface ToolActivity {
  state: "running" | "finished" | "failed" | "blocked";
  label: string;
  toolName: string;
}

export type AgentActivityPhase =
  | "preparing"
  | "loading"
  | "thinking"
  | "responding"
  | "searching"
  | "working"
  | "waiting"
  | "stopping";

export interface AgentActivity {
  phase: AgentActivityPhase;
  label: string;
  orbState: OrbState;
}

interface AgentActivityInput {
  isStarting: boolean;
  isStopping: boolean;
  /** True while a local model is still loading into memory. */
  isModelLoading?: boolean;
  streamingText: string | null;
  pendingApproval: boolean;
  toolActivity: ToolActivity | null;
}

const SEARCH_TOOL_PATTERN = /(?:^|[_:-])(find|glob|grep|list|read|search)(?:$|[_:-])/iu;

function isSearchTool(toolName: string): boolean {
  return SEARCH_TOOL_PATTERN.test(toolName);
}

/**
 * Maps only real generation lifecycle signals to motion. Idle and terminal
 * outcomes do not animate; transcript, tool, and error rows represent them.
 */
export function resolveAgentActivity({
  isStarting,
  isStopping,
  isModelLoading = false,
  streamingText,
  pendingApproval,
  toolActivity,
}: AgentActivityInput): AgentActivity | null {
  if (isStopping) {
    return { phase: "stopping", label: "Stopping…", orbState: "shaping" };
  }

  if (pendingApproval) {
    return { phase: "waiting", label: "Waiting for approval", orbState: "listening" };
  }

  if (toolActivity?.state === "running") {
    return isSearchTool(toolActivity.toolName)
      ? { phase: "searching", label: toolActivity.label, orbState: "searching" }
      : { phase: "working", label: toolActivity.label, orbState: "working" };
  }

  if (isStarting) {
    return { phase: "preparing", label: "Preparing…", orbState: "shaping" };
  }

  if (isModelLoading) {
    return { phase: "loading", label: "Model loading…", orbState: "shaping" };
  }

  if (streamingText === null) return null;

  return streamingText.length > 0
    ? { phase: "responding", label: "Responding…", orbState: "composing" }
    : { phase: "thinking", label: "Thinking…", orbState: "solving" };
}
