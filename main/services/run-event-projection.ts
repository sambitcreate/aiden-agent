import type { NotificationChannel } from "../../renderer/preload-channels.js";
import { parseGenerationTimeline } from "../../renderer/shared/generation-timeline.js";
import type { AidenRemoteStreamState } from "./aiden-remote-streams.js";

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
    const text = boundedText(payload.delta, 200_000);
    return text ? event("text_delta", { text }, false, "running") : { kind: "ignored" };
  }
  if (channel === "chat:reasoning-delta") {
    const text = boundedText(payload.delta, 200_000);
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
    const assistant = [...messages].reverse().find((message) => ownRecord(message)?.role === "assistant");
    const messageId = boundedText(ownRecord(assistant)?.id, 128) || `assistant_${context.turnId}`;
    return event("done", { messageId }, true, "done");
  }
  return { kind: "unhandled" };
}
