import type { ActivityMark } from "../shared/activity-marks";
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
  mark: ActivityMark;
}

/** Hold transient phase changes briefly without delaying safety-critical controls. */
export function activityPresentationDelay(
  current: AgentActivity | null,
  next: AgentActivity | null,
  reduceMotion = false,
): number {
  if (reduceMotion || !current || !next || next.phase === "stopping" || next.phase === "waiting" ||
    next.phase === "preparing" || current.phase === next.phase) return 0;
  return 120;
}

interface AgentActivityVisibility {
  reasoningVisible: boolean;
  visualizingVisible: boolean;
  toolVisible?: boolean;
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
    return { phase: "stopping", label: "Stopping…", mark: "bounce" };
  }

  if (pendingApproval) {
    return { phase: "waiting", label: "Waiting for approval", mark: "glance" };
  }

  if (toolActivity?.state === "running") {
    if (toolActivity.toolName === RENDER_ARTIFACT_TOOL_NAME) {
      return { phase: "visualizing", label: "Visualizing", mark: "scan-grid" };
    }
    return isSearchTool(toolActivity.toolName)
      ? { phase: "searching", label: toolActivity.label, mark: "scan-grid" }
      : { phase: "working", label: toolActivity.label, mark: "quad-shuffle" };
  }

  if (isStarting) {
    return { phase: "preparing", label: "Preparing…", mark: "bounce" };
  }

  if (isModelLoading) {
    return { phase: "loading", label: "Model loading…", mark: "bounce" };
  }

  if (streamingText === null) return null;

  return textStreaming && streamingText.length > 0
    ? { phase: "responding", label: "Responding…", mark: "compose" }
    : { phase: "thinking", label: "Thinking", mark: "tri-step" };
}

/** Let transcript-owned phase cards replace the generic activity row exactly once. */
export function resolveVisibleAgentActivity(
  activity: AgentActivity | null,
  { reasoningVisible, visualizingVisible, toolVisible = false }: AgentActivityVisibility,
): AgentActivity | null {
  if (!activity) return null;
  if (reasoningVisible && activity.phase === "thinking") return null;
  if (visualizingVisible && activity.phase === "visualizing") return null;
  if (toolVisible && (activity.phase === "searching" || activity.phase === "working")) return null;
  return activity;
}
