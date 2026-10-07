/**
 * Turn ACP tool-call notifications into Aiden activity.
 *
 * Normalization and payload bounds follow T3 Code
 * apps/server/src/provider/acp/{AcpRuntimeModel,AntigravityProtocol}.ts
 * @ f870c419fc (MIT). Tools the agent runs natively are never Pi tool calls
 * (Aiden would execute them again); they become generation-timeline steps,
 * which persist on the assistant message and reach both native clients.
 */
import path from "node:path";
import type {
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";

import { lineChangeCounts } from "../coding-tools.js";

export type AcpActivityStatus = "pending" | "running" | "completed" | "failed";

export interface AcpToolActivity {
  id: string;
  kind: ToolKind;
  title: string;
  status: AcpActivityStatus;
  /** Absolute paths the call touched, bounded. */
  locations: string[];
  lineChanges?: { additions: number; deletions: number };
  /** True when a diff created the file (no previous text). */
  created: boolean;
  /** True when the agent itself marked the call as an MCP tool call. */
  mcp: boolean;
  /** Set by harness quirks for calls that represent subagent batches. */
  subagent: boolean;
}

/** Projection of one activity onto an Aiden timeline tool step. */
export interface AcpTimelineStep {
  toolName: string;
  args: Record<string, unknown>;
}

const MAX_TITLE = 240;
const MAX_LOCATIONS = 16;
const MAX_DIFF_CHARS = 2_000_000;
const MAX_TRACKED = 512;

export function activityStatus(status: ToolCallStatus | null | undefined): AcpActivityStatus | undefined {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

function cleanText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function diffLineChanges(
  content: readonly ToolCallContent[] | null | undefined,
): { additions: number; deletions: number } | undefined {
  if (!Array.isArray(content)) return undefined;
  let additions = 0;
  let deletions = 0;
  let found = false;
  for (const item of content) {
    if (item?.type !== "diff" || typeof item.newText !== "string") continue;
    const before = typeof item.oldText === "string" ? item.oldText : "";
    if (before.length + item.newText.length > MAX_DIFF_CHARS) continue;
    const counts = lineChangeCounts(before, item.newText);
    additions += counts.additions;
    deletions += counts.deletions;
    found = true;
  }
  return found ? { additions, deletions } : undefined;
}

function diffCreatesFile(content: readonly ToolCallContent[] | null | undefined): boolean {
  return (
    Array.isArray(content) &&
    content.some((item) => item?.type === "diff" && (item.oldText === null || item.oldText === undefined))
  );
}

function diffPaths(content: readonly ToolCallContent[] | null | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item): item is ToolCallContent & { type: "diff" } => item?.type === "diff")
    .map((item) => item.path)
    .filter((value): value is string => typeof value === "string");
}

/**
 * Merges `tool_call` and `tool_call_update` notifications by id. Updates may
 * arrive before the call (agents race) and carry any subset of fields.
 */
export class AcpToolCallTracker {
  private readonly calls = new Map<string, AcpToolActivity>();

  apply(update: ToolCall | ToolCallUpdate): AcpToolActivity {
    const id = String(update.toolCallId);
    const previous = this.calls.get(id);
    const locations = [
      ...(previous?.locations ?? []),
      ...(update.locations ?? []).map((location) => location?.path),
      ...diffPaths(update.content),
    ].filter((value, index, all): value is string =>
      typeof value === "string" && value.length > 0 && all.indexOf(value) === index,
    );
    const lineChanges = diffLineChanges(update.content) ?? previous?.lineChanges;
    const meta = update._meta ?? undefined;
    const next: AcpToolActivity = {
      id,
      kind: update.kind ?? previous?.kind ?? "other",
      title: cleanText(update.title ?? undefined, MAX_TITLE) || previous?.title || "",
      status: activityStatus(update.status) ?? previous?.status ?? "pending",
      locations: locations.slice(0, MAX_LOCATIONS),
      mcp: previous?.mcp === true || (meta as Record<string, unknown> | undefined)?.is_mcp_tool_call === true,
      subagent: previous?.subagent ?? false,
      created: previous?.created === true || diffCreatesFile(update.content),
      ...(lineChanges ? { lineChanges } : {}),
    };
    this.calls.delete(id);
    this.calls.set(id, next);
    while (this.calls.size > MAX_TRACKED) {
      const oldest = this.calls.keys().next().value;
      if (oldest === undefined) break;
      this.calls.delete(oldest);
    }
    return next;
  }

  /** Harness quirk hook: reclassify a call after the fact. */
  mark(id: string, patch: Partial<Pick<AcpToolActivity, "subagent" | "mcp">>): void {
    const current = this.calls.get(id);
    if (current) this.calls.set(id, { ...current, ...patch });
  }

  get(id: string): AcpToolActivity | undefined {
    return this.calls.get(id);
  }

  clear(): void {
    this.calls.clear();
  }
}

/** A workspace-relative display path, or undefined when outside every root. */
export function relativeDisplayPath(absolute: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    if (!root) continue;
    const relative = path.relative(root, absolute);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/");
    }
  }
  return undefined;
}

/**
 * Map an activity onto the Aiden tool name whose timeline row best describes
 * it. Raw commands and titles never leave as `detail`: the timeline contract
 * forbids raw shell commands, and agent titles often embed them.
 */
export function timelineStepFor(
  activity: AcpToolActivity,
  roots: readonly string[],
): AcpTimelineStep | undefined {
  const target = activity.locations
    .map((location) => relativeDisplayPath(location, roots))
    .find((value): value is string => !!value);
  const withPath = target ? { path: target } : {};
  if (activity.subagent) return { toolName: "agent_subagents", args: {} };
  switch (activity.kind) {
    case "read":
      return { toolName: "read_file", args: withPath };
    case "edit":
      return { toolName: activity.created ? "write_file" : "edit_file", args: withPath };
    case "delete":
      return { toolName: "delete_file", args: withPath };
    case "move":
      return { toolName: "move_file", args: withPath };
    case "search":
      return { toolName: "grep", args: withPath };
    case "execute":
      return { toolName: "run_command", args: {} };
    case "fetch":
      return { toolName: "web_fetch", args: {} };
    case "think":
    case "switch_mode":
      return undefined;
    default:
      return { toolName: "agent_tool", args: {} };
  }
}
