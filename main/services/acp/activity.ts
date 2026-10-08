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
import { createHash, type Hash } from "node:crypto";
import type {
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";

import { lineChangeCounts } from "../coding-tools.js";
import { rootPath, type AcpRoot } from "./client-files.js";

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
const MAX_RETAINED_DIFF_CHARS = 8_000_000;
const MAX_PATH = 4_096;

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

/** Only activity metadata and output fingerprints survive a notification. */
export type AcpToolCallState = Pick<ToolCallUpdate, "toolCallId" | "kind" | "status" | "title" | "locations"> & {
  mcp: boolean;
  subagent: boolean;
  created: boolean;
  detail?: string;
  textOutput?: string;
  rawOutput?: string;
};

interface TrackedCall {
  state: AcpToolCallState;
  activity?: AcpToolActivity;
  /** Text-only content updates do not erase the last countable streamed diff. */
  diffs?: readonly ToolCallContent[];
  diffChars: number;
  parsedFingerprint?: string;
  lineChanges?: { additions: number; deletions: number };
}

function hashText(hash: Hash, value: string): void {
  hash.update(`${value.length}:`).update(value);
}

function outputFingerprint(value: unknown): string | undefined {
  const json = JSON.stringify(value);
  return json === undefined ? undefined : createHash("sha256").update(json).digest("hex");
}

function textFingerprint(content: readonly ToolCallContent[]): string | undefined {
  let hash: Hash | undefined;
  for (const item of content) {
    if (item.type !== "content" || item.content.type !== "text") continue;
    hash ??= createHash("sha256");
    hashText(hash, item.content.text);
  }
  return hash?.digest("hex");
}

function diffFingerprint(diffs: readonly ToolCallContent[]): string {
  const hash = createHash("sha256");
  for (const item of diffs) {
    if (item.type !== "diff") continue;
    hashText(hash, item.oldText ?? "");
    hashText(hash, item.newText);
  }
  return hash.digest("hex");
}

/** Updates may arrive before the initial call and carry any subset of fields. */
export class AcpToolCallTracker {
  private readonly calls = new Map<string, TrackedCall>();
  private retainedDiffChars = 0;

  /** Merge every chunk without normalizing the activity or parsing its diff. */
  merge(update: ToolCall | ToolCallUpdate): AcpToolCallState {
    const id = String(update.toolCallId);
    const entry = this.calls.get(id);
    const previous = entry?.state;
    const paths = new Set((previous?.locations ?? []).map((location) => location.path));
    for (const location of update.locations ?? []) {
      if (paths.size < MAX_LOCATIONS && location?.path && location.path.length <= MAX_PATH) paths.add(location.path);
    }
    for (const file of diffPaths(update.content)) {
      if (paths.size < MAX_LOCATIONS && file && file.length <= MAX_PATH) paths.add(file);
    }
    const next: AcpToolCallState = {
      toolCallId: id,
      title: update.title == null ? previous?.title : cleanText(update.title, MAX_TITLE) || previous?.title,
      kind: update.kind ?? previous?.kind,
      status: update.status ?? previous?.status,
      // Raw arguments, arbitrary metadata, images and other opaque blocks are
      // not consumed by activity. Retain fingerprints of visible output only.
      textOutput: update.content == null ? previous?.textOutput : textFingerprint(update.content),
      rawOutput: update.rawOutput === undefined ? previous?.rawOutput : outputFingerprint(update.rawOutput),
      detail: (update as ToolCallUpdate & { detail?: unknown }).detail === undefined
        ? previous?.detail : outputFingerprint((update as ToolCallUpdate & { detail?: unknown }).detail),
      locations: [...paths].map((file) => ({ path: file })),
      mcp: previous?.mcp === true || update._meta?.is_mcp_tool_call === true,
      subagent: previous?.subagent ?? false,
      created: previous?.created === true || diffCreatesFile(update.content),
    };
    const diffs = (update.content ?? []).filter((item) => item.type === "diff");
    this.calls.delete(id);
    const tracked: TrackedCall = { ...entry, state: next, diffChars: entry?.diffChars ?? 0 };
    if (diffs.length) {
      this.retainedDiffChars -= tracked.diffChars;
      // Mirror the existing parser limit; oversized diffs must never be kept
      // just because parsing them was skipped. Copy only the counting fields.
      tracked.diffs = diffs.flatMap((item) => {
        if (item.type !== "diff" || (item.oldText?.length ?? 0) + item.newText.length > MAX_DIFF_CHARS) return [];
        return [{ type: "diff" as const, path: "", oldText: item.oldText, newText: item.newText }];
      });
      tracked.diffChars = tracked.diffs.reduce((total, item) =>
        total + (item.type === "diff" ? (item.oldText?.length ?? 0) + item.newText.length : 0), 0);
      this.retainedDiffChars += tracked.diffChars;
    }
    this.calls.set(id, tracked);
    if (!entry && this.calls.size > MAX_TRACKED) {
      const oldest = this.calls.keys().next().value;
      if (oldest !== undefined) {
        this.retainedDiffChars -= this.calls.get(oldest)?.diffChars ?? 0;
        this.calls.delete(oldest);
      }
    }
    // Under memory pressure, replace old full diffs with their compact counts.
    // This exceptional path preserves final counts without retaining an
    // unbounded set of concurrently streamed diffs.
    for (const candidate of this.calls.values()) {
      if (this.retainedDiffChars <= MAX_RETAINED_DIFF_CHARS) break;
      this.countDiffs(candidate);
      this.releaseDiffs(candidate);
    }
    return next;
  }

  private countDiffs(entry: TrackedCall, force = false): void {
    const diffs = entry.diffs;
    if (!diffs) return;
    const fingerprint = diffFingerprint(diffs);
    if (force || entry.parsedFingerprint !== fingerprint) {
      entry.lineChanges = diffLineChanges(diffs) ?? entry.lineChanges;
      entry.parsedFingerprint = fingerprint;
    }
  }

  private releaseDiffs(entry: TrackedCall): void {
    this.retainedDiffChars -= entry.diffChars;
    entry.diffChars = 0;
    entry.diffs = undefined;
    entry.parsedFingerprint = undefined;
  }

  /** Existing callers, including permission requests, always project immediately. */
  apply(update: ToolCall | ToolCallUpdate): AcpToolActivity {
    const state = this.merge(update);
    return this.project(state.toolCallId);
  }

  project(id: string): AcpToolActivity {
    const entry = this.calls.get(id);
    if (!entry) throw new Error("Unknown ACP tool call.");
    const { state, activity: previous } = entry;
    // Completion normally recomputes the last diff. Under memory pressure it
    // was already reduced to compact counts before its full text was released.
    this.countDiffs(entry, state.status === "completed");
    const lineChanges = entry.lineChanges ?? previous?.lineChanges;
    const next: AcpToolActivity = {
      id,
      kind: state.kind ?? "other",
      title: cleanText(state.title ?? undefined, MAX_TITLE) || previous?.title || "",
      status: activityStatus(state.status) ?? "pending",
      locations: (state.locations ?? []).map((location) => location.path),
      mcp: state.mcp,
      subagent: state.subagent,
      created: state.created,
      ...(lineChanges ? { lineChanges } : {}),
    };
    entry.activity = next;
    if (state.status === "completed" || state.status === "failed") this.releaseDiffs(entry);
    return next;
  }

  /** Harness quirk hook: reclassify a call after the fact. */
  mark(id: string, patch: Partial<Pick<AcpToolActivity, "subagent" | "mcp">>): void {
    const entry = this.calls.get(id);
    if (!entry) return;
    entry.state = { ...entry.state, ...patch };
    if (entry.activity) entry.activity = { ...entry.activity, ...patch };
  }

  get(id: string): AcpToolActivity | undefined {
    return this.calls.get(id)?.activity;
  }

  getState(id: string): AcpToolCallState | undefined {
    return this.calls.get(id)?.state;
  }

  clear(): void {
    this.calls.clear();
    this.retainedDiffChars = 0;
  }
}

/** A workspace-relative display path, or undefined when outside every root. */
export function relativeDisplayPath(absolute: string, roots: readonly AcpRoot[]): string | undefined {
  for (const entry of roots) {
    const root = rootPath(entry);
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
  roots: readonly AcpRoot[],
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
      // The title is the raw command line, which can carry secrets; never persist it.
      return { toolName: "run_command", args: { description: "a command" } };
    case "fetch":
      return { toolName: "web_fetch", args: {} };
    case "think":
    case "switch_mode":
      return undefined;
    default:
      return { toolName: "agent_tool", args: {} };
  }
}
