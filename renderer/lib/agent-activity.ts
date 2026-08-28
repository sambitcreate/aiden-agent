import type { OrbState } from "thinking-orbs";
import { RENDER_ARTIFACT_TOOL_NAME } from "../shared/generative-ui";

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
  | "visualizing"
  | "waiting"
  | "stopping";

export interface AgentActivity {
  phase: AgentActivityPhase;
  label: string;
  orbState: OrbState;
}

interface AgentActivityVisibility {
  reasoningVisible: boolean;
  visualizingVisible: boolean;
}

interface AgentActivityInput {
  isStarting: boolean;
  isStopping: boolean;
  /** True while a local model is still loading into memory. */
  isModelLoading?: boolean;
  streamingText: string | null;
  /**
   * True only while text deltas are still arriving. Prose from an earlier turn
   * of this generation must not pin the row to a static "Responding…" while
   * the model is actually reasoning or writing tool arguments.
   */
  textStreaming?: boolean;
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
  textStreaming = false,
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
    if (toolActivity.toolName === RENDER_ARTIFACT_TOOL_NAME) {
      return { phase: "visualizing", label: "Visualizing", orbState: "working" };
    }
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

  return textStreaming && streamingText.length > 0
    ? { phase: "responding", label: "Responding…", orbState: "composing" }
    : { phase: "thinking", label: "Thinking", orbState: "solving" };
}

/** Let transcript-owned phase cards replace the generic orb row exactly once. */
export function resolveVisibleAgentActivity(
  activity: AgentActivity | null,
  { reasoningVisible, visualizingVisible }: AgentActivityVisibility,
): AgentActivity | null {
  if (!activity) return null;
  if (reasoningVisible && activity.phase === "thinking") return null;
  if (visualizingVisible && activity.phase === "visualizing") return null;
  return activity;
}
