import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ModelsSimpleStreamOptions,
  ProviderHeaders,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  PROVIDER_FAILURE_CATEGORIES,
  type ProviderFailureCategoryV1,
} from "../../../renderer/shared/provider-failure.js";

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
  /** Closed worker-side classification; provider-authored text never crosses IPC. */
  providerFailureCategory?: ProviderFailureCategoryV1;
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
  /** Non-secret launch nonce delivered to the worker through UtilityProcess argv. */
  launchToken: string;
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

/**
 * Pi's agent loop passes AgentTool objects through the structurally compatible
 * Context.tools field. AgentTool adds main-owned execute/argument callbacks,
 * which must remain in main and cannot cross Electron's structured-clone IPC.
 */
export function prepareSubagentInferenceContext(context: Context): Context {
  return {
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    messages: context.messages,
    ...(context.tools === undefined
      ? {}
      : {
          tools: context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        }),
  };
}

/**
 * Project the documented Pi provider options instead of spreading the agent
 * loop config. The runtime object also contains callbacks such as getApiKey,
 * convertToLlm, and tool lifecycle hooks that are deliberately main-owned.
 */
export function prepareSubagentInferenceOptions(
  options: ModelsSimpleStreamOptions = {},
): SerializableStreamOptions {
  const projected: SerializableStreamOptions = {};
  const assign = <K extends keyof SerializableStreamOptions>(
    key: K,
    value: SerializableStreamOptions[K] | undefined,
  ) => {
    if (value !== undefined) projected[key] = value;
  };
  assign("temperature", options.temperature);
  assign("maxTokens", options.maxTokens);
  assign("apiKey", options.apiKey);
  assign("transport", options.transport);
  assign("cacheRetention", options.cacheRetention);
  assign("sessionId", options.sessionId);
  assign("headers", options.headers);
  assign("timeoutMs", options.timeoutMs);
  assign("websocketConnectTimeoutMs", options.websocketConnectTimeoutMs);
  assign("maxRetries", options.maxRetries);
  assign("maxRetryDelayMs", options.maxRetryDelayMs);
  assign("metadata", options.metadata);
  assign("env", options.env);
  assign("reasoning", options.reasoning);
  assign("thinkingBudgets", options.thinkingBudgets);
  return projected;
}

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
  if (value.kind === "ready") {
    return (
      hasExactKeys(value, ["kind", "version", "requestId", "launchToken"]) &&
      typeof value.launchToken === "string" &&
      value.launchToken.length > 0 &&
      value.launchToken.length <= 128 &&
      /^[A-Za-z0-9_-]+$/u.test(value.launchToken)
    );
  }
  if (value.kind === "failure") {
    return (
      typeof value.message === "string" &&
      hasExactKeys(value, ["kind", "version", "requestId", "message"])
    );
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
  const authenticationFailure = value.authenticationFailure === true;
  const providerFailureCategory =
    typeof value.providerFailureCategory === "string" &&
    (PROVIDER_FAILURE_CATEGORIES as readonly string[]).includes(value.providerFailureCategory);
  const eventKeys = 5 + (authenticationFailure ? 1 : 0) + (providerFailureCategory ? 1 : 0);
  return (
    value.kind === "event" &&
    Object.keys(value).length === eventKeys &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) >= 0 &&
    (value.authenticationFailure === undefined ||
      (authenticationFailure && isRecord(value.event) && value.event.type === "error")) &&
    (value.providerFailureCategory === undefined ||
      (providerFailureCategory && isRecord(value.event) && value.event.type === "error")) &&
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

/**
 * Electron UtilityProcess uses structured clone, while Pi's provider contract
 * is JSON data. Normalize at the owned boundary so symbols, undefined values,
 * prototypes, and any accidentally retained callbacks cannot reach IPC.
 */
export function toSubagentInferenceWireMessage<T extends SubagentInferenceParentMessage>(
  value: T,
): T {
  const projected =
    value.kind === "start"
      ? {
          ...value,
          context: prepareSubagentInferenceContext(value.context),
          options: prepareSubagentInferenceOptions(value.options),
        }
      : value;
  let encoded: string;
  try {
    encoded = JSON.stringify(projected);
  } catch {
    throw new Error("The isolated provider request could not be serialized.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error("The isolated provider request could not be serialized.");
  }
  if (!isSubagentInferenceParentMessage(decoded)) {
    throw new Error("The isolated provider request did not match its wire contract.");
  }
  return decoded as T;
}

export function serializeError(error: unknown): string {
  return error instanceof Error && error.name === "AbortError"
    ? "The isolated provider request was cancelled."
    : "The isolated provider request failed.";
}
