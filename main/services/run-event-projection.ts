import type { NotificationChannel } from "../../renderer/preload-channels.js";
import {
  isAssistantAutomationApprovalDetails,
  isScheduledTaskApprovalDetails,
  isSubagentMcpMutationApprovalDetails,
  isSubagentRunGrantApprovalDetails,
  isSubagentShellApprovalDetails,
  isSubagentWorkspaceWriteApprovalDetails,
  type ToolApprovalDetails,
} from "../../renderer/shared/assistant.js";
import { parseGenerationTimeline } from "../../renderer/shared/generation-timeline.js";
import type { AidenRemoteStreamState } from "./aiden-remote-streams.js";

/** Bound on one delta event's text, whether projected or coalesced. */
export const MAX_DELTA_TEXT_LENGTH = 200_000;
/**
 * Folding stops once an event's serialized envelope would pass this size, well
 * inside the 1 MiB SSE frame the native clients accept even for text that
 * escapes heavily in JSON.
 */
export const MAX_COALESCED_DELTA_EVENT_BYTES = 256 * 1_024;

/**
 * Journals coalesce consecutive deltas of one kind into a single event while
 * that event is still undelivered. A delivered event is immutable: an
 * observer's cursor has moved past it, so later text must take a new sequence.
 */
export function isCoalescibleDelta(type: string): type is "text_delta" | "reasoning_delta" {
  return type === "text_delta" || type === "reasoning_delta";
}

/**
 * Merged payload when `next` may extend `previous`, otherwise undefined.
 * Both must be deltas of the same kind and the result must stay in bounds.
 */
export function mergeDeltaPayload(
  type: string,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): { text: string } | undefined {
  if (!isCoalescibleDelta(type)) return undefined;
  if (typeof previous.text !== "string" || typeof next.text !== "string") return undefined;
  if (previous.text.length + next.text.length > MAX_DELTA_TEXT_LENGTH) return undefined;
  return { text: previous.text + next.text };
}

/**
 * Per-run memory the content projection needs across notifications: tool
 * calls are paired with their results by name, in call order, so the wire
 * carries stable `tool_N` ids without ever exposing raw tool-call ids.
 */
export interface RunProjectionState {
  toolCounter: number;
  activeTools: Map<string, string[]>;
}

export function createRunProjectionState(): RunProjectionState {
  return { toolCounter: 0, activeTools: new Map() };
}

export interface RunProjectionContext {
  chatId: string;
  turnId: string;
  /** Sequence of the newest retained event (0 when empty). */
  lastSequence: number;
  /** True once a stop was requested for this run by the projecting journal. */
  cancelRequested: boolean;
  cancellationSource: "device" | "server";
}

export type RunContentProjection =
  | {
      kind: "event";
      type: string;
      payload: Record<string, unknown>;
      terminal: boolean;
      state: AidenRemoteStreamState;
    }
  /** Channel handled, nothing to append (e.g. empty delta). */
  | { kind: "ignored" }
  /** Caller owns this channel (chat:approval, chat:questionnaire, anything unknown). */
  | { kind: "unhandled" };

export function ownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const ASSISTANT_AUTOMATION_DETAIL_KEYS = [
  "kind", "action", "taskId", "enabled", "name", "prompt", "cron", "timezone", "nextRunAt",
  "notify", "mode", "permission", "workspaceId", "workspaceName", "mcpServerIds",
  "mcpServerNames", "providerId", "providerName", "model", "modelName", "schedulerEnabled",
] as const;

const SCHEDULED_TASK_DETAIL_KEYS = [
  "kind", "action", "taskId", "expectedUpdatedAt", "enabled", "name", "prompt", "script",
  "cron", "timezone", "nextRunAt", "notify", "mode", "permission", "workspaceId",
  "workspaceName", "mcpServerIds", "mcpServerNames", "providerId", "providerName", "model",
  "modelName", "legacyGlobalMcp", "schedulerEnabled",
] as const;

function pickDeclared(
  details: Record<string, unknown>,
  keys: readonly string[],
): ToolApprovalDetails {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(details, key)) picked[key] = structuredClone(details[key]);
  }
  return picked as unknown as ToolApprovalDetails;
}

/**
 * The single allowlist for approval facts any run journal may retain.
 * Only recognized detail kinds survive, and only their declared fields:
 * internal state riding on a recognized kind (for example classifier state)
 * is dropped rather than copied. Anything else returns undefined.
 */
export function projectApprovalDetails(value: unknown): ToolApprovalDetails | undefined {
  try {
    if (isAssistantAutomationApprovalDetails(value)) {
      return pickDeclared(value as unknown as Record<string, unknown>, ASSISTANT_AUTOMATION_DETAIL_KEYS);
    }
    if (isScheduledTaskApprovalDetails(value)) {
      return pickDeclared(value as unknown as Record<string, unknown>, SCHEDULED_TASK_DETAIL_KEYS);
    }
    // These guards already require their exact key sets.
    if (
      isSubagentWorkspaceWriteApprovalDetails(value) ||
      isSubagentMcpMutationApprovalDetails(value) ||
      isSubagentShellApprovalDetails(value) ||
      isSubagentRunGrantApprovalDetails(value)
    ) {
      return structuredClone(value);
    }
  } catch {
    // Getters or uncloneable values fail closed.
  }
  return undefined;
}

/** Truncate to `maximum` UTF-16 units and replace any unpaired surrogate. */
export function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const sliced = value.slice(0, maximum);
  let result = "";
  for (let index = 0; index < sliced.length; index += 1) {
    const code = sliced.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = sliced.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += sliced[index] + sliced[index + 1];
        index += 1;
      } else {
        result += "�";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "�";
    } else {
      result += sliced[index];
    }
  }
  return result;
}

/** Newest assistant message, scanning back without copying the transcript. */
function lastAssistantMessage(messages: readonly unknown[]): unknown {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (ownRecord(messages[index])?.role === "assistant") return messages[index];
  }
  return undefined;
}

function event(
  type: string,
  payload: Record<string, unknown>,
  terminal: boolean,
  state: AidenRemoteStreamState,
): RunContentProjection {
  return { kind: "event", type, payload, terminal, state };
}

function cancelledProjection(
  payload: Record<string, unknown>,
  context: RunProjectionContext,
): RunContentProjection | null {
  const finalTimeline = parseGenerationTimeline(payload.timeline);
  if (
    !context.cancelRequested &&
    payload.cancelled !== true &&
    finalTimeline?.status !== "cancelled"
  ) {
    return null;
  }
  return event(
    "cancelled",
    { source: context.cancelRequested ? context.cancellationSource : "server" },
    true,
    "cancelled",
  );
}

/**
 * Turn one generation notification into the renderer-safe wire event shared
 * by every run journal. Only `state` is mutated; approval and questionnaire
 * prompts carry journal-owned lifecycles, so they stay with the caller.
 */
export function projectRunContentNotification(
  state: RunProjectionState,
  channel: NotificationChannel,
  payload: Record<string, unknown>,
  context: RunProjectionContext,
): RunContentProjection {
  if (channel === "chat:delta") {
    if (payload.reset === true) {
      // The snapshot occupies lastSequence + 1, so replay resumes after it.
      const nextSequence = context.lastSequence + 2;
      return event(
        "snapshot",
        { chatId: context.chatId, turnId: context.turnId, nextSequence },
        false,
        "reconciling",
      );
    }
    const text = boundedText(payload.delta, MAX_DELTA_TEXT_LENGTH);
    return text ? event("text_delta", { text }, false, "running") : { kind: "ignored" };
  }
  if (channel === "chat:reasoning-delta") {
    const text = boundedText(payload.delta, MAX_DELTA_TEXT_LENGTH);
    return text ? event("reasoning_delta", { text }, false, "running") : { kind: "ignored" };
  }
  if (channel === "chat:status") {
    return event("status", { state: "running" }, false, "running");
  }
  if (channel === "chat:tool") {
    const name = boundedText(payload.toolName, 120) || "Tool";
    const phase = payload.phase;
    if (phase === "call") {
      const toolId = `tool_${++state.toolCounter}`;
      const queue = state.activeTools.get(name) ?? [];
      queue.push(toolId);
      state.activeTools.set(name, queue);
      return event("tool_started", { toolId, name }, false, "running");
    }
    const queue = state.activeTools.get(name) ?? [];
    const toolId = queue.shift() ?? `tool_${++state.toolCounter}`;
    if (queue.length === 0) state.activeTools.delete(name);
    const status = phase === "result" ? "succeeded" : "failed";
    return event("tool_finished", { toolId, status }, false, "running");
  }
  if (channel === "chat:timeline") {
    const timeline = parseGenerationTimeline(payload.timeline);
    return timeline ? event("timeline", { timeline }, false, "running") : { kind: "ignored" };
  }
  if (channel === "chat:error") {
    return (
      cancelledProjection(payload, context) ??
      event(
        "error",
        { code: "internal_error", message: "The model provider could not complete this response." },
        true,
        "error",
      )
    );
  }
  if (channel === "chat:done") {
    const cancelled = cancelledProjection(payload, context);
    if (cancelled) return cancelled;
    const chat = ownRecord(payload.chat);
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    const assistant = lastAssistantMessage(messages);
    const messageId = boundedText(ownRecord(assistant)?.id, 128) || `assistant_${context.turnId}`;
    return event("done", { messageId }, true, "done");
  }
  return { kind: "unhandled" };
}
