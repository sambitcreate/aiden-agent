import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export const SUBAGENT_INFERENCE_PROTOCOL_VERSION = 1;
export const MAX_SUBAGENT_INFERENCE_MESSAGE_BYTES = 32 * 1024 * 1024;

export class SubagentInferenceOutboundBudget {
  private bytes = 0;

  constructor(private readonly maxBytes = MAX_SUBAGENT_INFERENCE_MESSAGE_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Invalid isolated inference IPC budget.");
    }
  }

  consume(message: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (bytes > this.maxBytes || this.bytes + bytes > this.maxBytes) {
      throw new Error("The isolated provider stream exceeded its IPC budget.");
    }
    this.bytes += bytes;
  }
}

export type SerializableStreamOptions = Omit<
  SimpleStreamOptions,
  "signal" | "onPayload" | "onResponse"
> & {
  env?: Record<string, string>;
  headers?: ProviderHeaders;
};

export interface SubagentInferenceStartMessage {
  kind: "start";
  version: typeof SUBAGENT_INFERENCE_PROTOCOL_VERSION;
  requestId: string;
  model: Model<Api>;
  context: Context;
  options: SerializableStreamOptions;
}

export interface SubagentInferenceCancelMessage {
  kind: "cancel";
  version: typeof SUBAGENT_INFERENCE_PROTOCOL_VERSION;
  requestId: string;
}

export interface SubagentInferenceHookResultMessage {
  kind: "hook-result";
  version: typeof SUBAGENT_INFERENCE_PROTOCOL_VERSION;
  requestId: string;
  callId: number;
  payload?: unknown;
}

export interface SubagentInferenceTerminalAckMessage {
  kind: "terminal-ack";
  version: typeof SUBAGENT_INFERENCE_PROTOCOL_VERSION;
  requestId: string;
}

export interface SubagentInferenceReadyAckMessage {
  kind: "ready-ack";
  version: typeof SUBAGENT_INFERENCE_PROTOCOL_VERSION;
  requestId: string;
}

export interface SubagentInferenceEventMessage {
  kind: "event";
  version: typeof SUBAGENT_INFERENCE_PROTOCOL_VERSION;
  requestId: string;
  sequence: number;
  /** Text/thinking partial snapshots are omitted from delta/end frames. */
  event: Record<string, unknown>;
  /** Closed worker-side classification; raw provider text never crosses IPC. */
  authenticationFailure?: true;
}

export interface SubagentInferenceFailureMessage {
  kind: "failure";
  version: typeof SUBAGENT_INFERENCE_PROTOCOL_VERSION;
  requestId: string;
  message: string;
}

export interface SubagentInferenceReadyMessage {
  kind: "ready";
  version: typeof SUBAGENT_INFERENCE_PROTOCOL_VERSION;
  requestId: string;
}

export interface SubagentInferenceHookMessage {
  kind: "hook";
  version: typeof SUBAGENT_INFERENCE_PROTOCOL_VERSION;
  requestId: string;
  callId: number;
  hook: "payload" | "response";
  payload: unknown;
}

export type SubagentInferenceParentMessage =
  | SubagentInferenceStartMessage
  | SubagentInferenceCancelMessage
  | SubagentInferenceHookResultMessage
  | SubagentInferenceReadyAckMessage
  | SubagentInferenceTerminalAckMessage;
export type SubagentInferenceWorkerMessage =
  | SubagentInferenceReadyMessage
  | SubagentInferenceEventMessage
  | SubagentInferenceFailureMessage
  | SubagentInferenceHookMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isWireAssistantEvent(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const index = () =>
    Number.isSafeInteger(value.contentIndex) && (value.contentIndex as number) >= 0;
  switch (value.type) {
    case "start":
      return hasExactKeys(value, ["type", "partial"]) && isRecord(value.partial);
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return (
        hasExactKeys(value, ["type", "contentIndex", "partial"]) &&
        index() &&
        isRecord(value.partial)
      );
    case "text_delta":
    case "thinking_delta":
      return (
        hasExactKeys(value, ["type", "contentIndex", "delta"]) &&
        index() &&
        typeof value.delta === "string"
      );
    case "text_end":
    case "thinking_end":
      return (
        hasExactKeys(value, ["type", "contentIndex", "content"]) &&
        index() &&
        typeof value.content === "string"
      );
    case "toolcall_delta":
      return (
        hasExactKeys(value, ["type", "contentIndex", "delta"]) &&
        index() &&
        typeof value.delta === "string"
      );
    case "toolcall_end":
      return (
        hasExactKeys(value, ["type", "contentIndex", "toolCall"]) &&
        index() &&
        isRecord(value.toolCall)
      );
    case "done":
      return hasExactKeys(value, ["type", "reason", "message"]) && isRecord(value.message);
    case "error":
      return hasExactKeys(value, ["type", "reason", "error"]) && isRecord(value.error);
    default:
      return false;
  }
}

export function isSubagentInferenceWorkerMessage(
  value: unknown,
): value is SubagentInferenceWorkerMessage {
  if (!isRecord(value) || value.version !== SUBAGENT_INFERENCE_PROTOCOL_VERSION) return false;
  if (typeof value.requestId !== "string" || value.requestId.length === 0) return false;
  if (value.kind === "ready") return Object.keys(value).length === 3;
  if (value.kind === "failure") {
    return Object.keys(value).length === 4 && typeof value.message === "string";
  }
  if (value.kind === "hook") {
    return (
      Object.keys(value).length === 6 &&
      Number.isSafeInteger(value.callId) &&
      (value.callId as number) >= 0 &&
      (value.hook === "payload" || value.hook === "response") &&
      Object.prototype.hasOwnProperty.call(value, "payload")
    );
  }
  const eventKeys = value.authenticationFailure === true ? 6 : 5;
  return (
    value.kind === "event" &&
    Object.keys(value).length === eventKeys &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) >= 0 &&
    (value.authenticationFailure === undefined ||
      (value.authenticationFailure === true &&
        isRecord(value.event) &&
        value.event.type === "error")) &&
    isWireAssistantEvent(value.event)
  );
}

export function compactAssistantMessageEvent(
  event: AssistantMessageEvent,
): Record<string, unknown> {
  if (
    event.type === "text_delta" ||
    event.type === "text_end" ||
    event.type === "thinking_delta" ||
    event.type === "thinking_end" ||
    event.type === "toolcall_delta" ||
    event.type === "toolcall_end"
  ) {
    const { partial: _partial, ...compact } = event;
    return compact;
  }
  return event as unknown as Record<string, unknown>;
}

export function expandAssistantMessageEvent(
  wire: Record<string, unknown>,
  current: AssistantMessage | undefined,
): { event: AssistantMessageEvent; partial: AssistantMessage | undefined } {
  if (wire.type === "start") {
    const partial = wire.partial as AssistantMessage;
    return { event: wire as unknown as AssistantMessageEvent, partial };
  }
  if (wire.type === "done" || wire.type === "error") {
    return { event: wire as unknown as AssistantMessageEvent, partial: current };
  }
  const supplied = wire.partial as AssistantMessage | undefined;
  const partial = supplied ?? current;
  if (!partial) throw new Error("Provider delta arrived before its start event.");
  const contentIndex = wire.contentIndex as number;
  const block = partial.content[contentIndex];
  if (wire.type === "text_delta" && block?.type === "text") block.text += String(wire.delta);
  else if (wire.type === "text_end" && block?.type === "text") block.text = String(wire.content);
  else if (wire.type === "thinking_delta" && block?.type === "thinking") {
    block.thinking += String(wire.delta);
  } else if (wire.type === "thinking_end" && block?.type === "thinking") {
    block.thinking = String(wire.content);
  } else if (wire.type === "toolcall_end") {
    partial.content[contentIndex] = wire.toolCall as AssistantMessage["content"][number];
  }
  return {
    event: { ...wire, partial } as unknown as AssistantMessageEvent,
    partial,
  };
}

export function isSubagentInferenceParentMessage(
  value: unknown,
): value is SubagentInferenceParentMessage {
  if (!isRecord(value) || value.version !== SUBAGENT_INFERENCE_PROTOCOL_VERSION) return false;
  if (typeof value.requestId !== "string" || value.requestId.length === 0) return false;
  if (value.kind === "cancel" || value.kind === "ready-ack" || value.kind === "terminal-ack") {
    return Object.keys(value).length === 3;
  }
  if (value.kind === "hook-result") {
    return (
      (Object.keys(value).length === 4 || Object.keys(value).length === 5) &&
      Number.isSafeInteger(value.callId) &&
      (value.callId as number) >= 0
    );
  }
  return (
    value.kind === "start" &&
    Object.keys(value).length === 6 &&
    isRecord(value.model) &&
    typeof value.model.id === "string" &&
    typeof value.model.provider === "string" &&
    typeof value.model.api === "string" &&
    isRecord(value.context) &&
    Array.isArray(value.context.messages) &&
    isRecord(value.options)
  );
}

export function serializeError(error: unknown): string {
  return error instanceof Error && error.name === "AbortError"
    ? "The isolated provider request was cancelled."
    : "The isolated provider request failed.";
}
