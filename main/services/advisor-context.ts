import { createHash } from "node:crypto";
import type { AgentMessage, AgentState, AgentTool } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { compactGenerationContext } from "./generation-context.js";

export const ADVISOR_INVENTORY_MAX_CHARS = 64 * 1024;
export const ADVISOR_RESULT_MAX_CHARS = 32 * 1024;
export const ADVISOR_MAX_IMAGES = 3;
export const ADVISOR_MAX_IMAGE_DATA_CHARS = 8 * 1024 * 1024;
export const ADVISOR_TEXT_MAX_CHARS = 2 * 1024 * 1024;
export const ADVISOR_CONTEXT_NUDGE = "Please advise on the executor's situation above.";

const OMITTED_IMAGE =
  "[Image omitted from the advisor request because of reviewer modality or request bounds.]";

function redactAdvisorText(value: string): string {
  const bounded = value.length > ADVISOR_TEXT_MAX_CHARS
    ? `${value.slice(0, ADVISOR_TEXT_MAX_CHARS)}\n[Text truncated before advisor transfer.]`
    : value;
  return bounded
    .replace(
      /-----BEGIN [^-\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\n]+ PRIVATE KEY-----/giu,
      "[credential redacted]",
    )
    .replace(
      /\bauthorization\s*:\s*bearer\s+[^\s,;]+/giu,
      "[credential redacted]",
    )
    .replace(
      /\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*["']?[^\s,;'"}]+["']?/giu,
      "[credential redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[credential redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, "[credential redacted]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[credential redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "[credential redacted]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu, "[credential redacted]");
}

function hasToolCall(message: AgentMessage | undefined, toolCallId: string): boolean {
  return (
    message?.role === "assistant" &&
    message.content.some((part) => part.type === "toolCall" && part.id === toolCallId)
  );
}

/** Snapshot the exact live branch, including a still-streaming assistant call when needed. */
export function snapshotAdvisorRuntimeMessages(
  state: Pick<AgentState, "messages" | "streamingMessage">,
  toolCallId: string,
): AgentMessage[] {
  const messages = structuredClone(state.messages) as AgentMessage[];
  if (
    !messages.some((message) => hasToolCall(message, toolCallId)) &&
    hasToolCall(state.streamingMessage, toolCallId)
  ) {
    messages.push(structuredClone(state.streamingMessage) as AgentMessage);
  }
  return messages;
}

function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (seen.has(value)) return JSON.stringify("[circular]");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, seen)).join(",")}]`;
    const entries = Object.keys(value as object)
      .sort()
      .flatMap((key) => {
        const encoded = stableJson((value as Record<string, unknown>)[key], seen);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      });
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export interface AdvisorInventory {
  hash: string;
  text: string;
  truncated: boolean;
  message: UserMessage;
}

export function buildAdvisorInventory(
  tools: readonly AgentTool[],
  timestamp = 0,
): AdvisorInventory | undefined {
  const sorted = tools
    .filter((tool) => tool.name !== "advisor")
    .map((tool) => ({
      name: redactAdvisorText(tool.name),
      description: redactAdvisorText(tool.description),
      parameters: redactAdvisorText(stableJson(tool.parameters)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (sorted.length === 0) return undefined;
  const canonical = stableJson(sorted);
  const hash = createHash("sha256").update(canonical).digest("hex");
  const header = `## Available Executor Tools\nInventory SHA-256: ${hash}\n\n`;
  let body = "";
  let truncated = false;
  for (const tool of sorted) {
    const block = `### ${tool.name}\n${tool.description.slice(0, 4_096)}\n\nParameters: ${tool.parameters}\n\n`;
    if (header.length + body.length + block.length > ADVISOR_INVENTORY_MAX_CHARS) {
      truncated = true;
      break;
    }
    body += block;
  }
  if (truncated) body += "[Additional executor tool schemas omitted to stay within bounds.]";
  const text = `${header}${body}`.slice(0, ADVISOR_INVENTORY_MAX_CHARS);
  return {
    hash,
    text,
    truncated,
    message: { role: "user", content: text, timestamp },
  };
}

function sanitizeContent(
  content: string | readonly (TextContent | ImageContent)[],
  images: { count: number; chars: number },
  supportsImages: boolean,
): string | (TextContent | ImageContent)[] {
  if (typeof content === "string") return redactAdvisorText(content);
  const sanitized: (TextContent | ImageContent)[] = [];
  let omittedImage = false;
  for (const part of content) {
    if (part.type === "text") {
      sanitized.push({ type: "text", text: redactAdvisorText(part.text) });
      continue;
    }
    const allowed =
      supportsImages &&
      images.count < ADVISOR_MAX_IMAGES &&
      images.chars + part.data.length <= ADVISOR_MAX_IMAGE_DATA_CHARS;
    if (allowed) {
      sanitized.push({ type: "image", data: part.data, mimeType: part.mimeType });
      images.count += 1;
      images.chars += part.data.length;
    } else {
      omittedImage = true;
    }
  }
  if (omittedImage) sanitized.push({ type: "text", text: OMITTED_IMAGE });
  return sanitized;
}

function sanitizeMessage(
  message: AgentMessage,
  images: { count: number; chars: number },
  supportsImages: boolean,
): Message | undefined {
  if (message.role === "user") {
    return {
      role: "user",
      content: sanitizeContent(message.content, images, supportsImages),
      timestamp: message.timestamp,
    };
  }
  if (message.role === "assistant") {
    const content: (TextContent | ToolCall)[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: redactAdvisorText(part.text) });
        continue;
      }
      if (part.type === "toolCall") {
        content.push({
          type: "toolCall",
          id: part.id,
          name: part.name,
          // Arguments can contain file contents, commands, environment values,
          // or connector secrets. Completed result text carries the reviewable
          // evidence without forwarding that second high-risk copy.
          arguments: {},
        });
      }
      // Thinking and encrypted/redacted signatures are deliberately not transferred.
    }
    if (content.length === 0) return undefined;
    const sanitized: AssistantMessage = {
      role: "assistant",
      content,
      api: message.api,
      provider: message.provider,
      model: message.model,
      usage: structuredClone(message.usage),
      stopReason: message.stopReason,
      timestamp: message.timestamp,
    };
    return sanitized;
  }
  if (message.role === "toolResult") {
    const sanitized: ToolResultMessage = {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: sanitizeContent(message.content, images, supportsImages) as (
        | TextContent
        | ImageContent
      )[],
      isError: message.isError,
      timestamp: message.timestamp,
    };
    return sanitized;
  }
  return undefined;
}

/** Remove the exact in-flight call and every orphan call/result pair. */
export function repairAdvisorToolProtocol(
  messages: readonly Message[],
  inflightToolCallId: string,
): Message[] {
  const resultNames = new Map(
    messages
      .filter((message): message is ToolResultMessage => message.role === "toolResult")
      .map((message) => [message.toolCallId, message.toolName] as const),
  );
  const seenCalls = new Map<string, string>();
  const repaired: Message[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      for (const part of message.content) {
        if (part.type !== "toolCall") {
          content.push(part);
          continue;
        }
        if (part.id === inflightToolCallId || resultNames.get(part.id) !== part.name) continue;
        seenCalls.set(part.id, part.name);
        content.push(part);
      }
      if (content.length > 0) repaired.push({ ...message, content });
      continue;
    }
    if (message.role === "toolResult") {
      if (seenCalls.get(message.toolCallId) === message.toolName) repaired.push(message);
      continue;
    }
    repaired.push(message);
  }
  return repaired;
}

export function ensureAdvisorUserTail(
  messages: readonly Message[],
  timestamp = Date.now(),
): Message[] {
  if (messages[messages.length - 1]?.role === "user") return [...messages];
  return [...messages, { role: "user", content: ADVISOR_CONTEXT_NUDGE, timestamp }];
}

export interface AdvisorContextProjection {
  messages: Message[];
  inventoryHash?: string;
  inventoryTruncated: boolean;
  compacted: boolean;
  usedContextFallback: boolean;
}

export function projectAdvisorContext(input: {
  liveMessages: readonly AgentMessage[];
  inflightToolCallId: string;
  executorTools: readonly AgentTool[];
  reviewerContextWindow: number;
  reviewerSupportsImages: boolean;
  reviewerSystemPrompt: string;
  timestamp?: number;
}): AdvisorContextProjection {
  const images = { count: 0, chars: 0 };
  const sanitized = input.liveMessages.flatMap((message) => {
    const projected = sanitizeMessage(message, images, input.reviewerSupportsImages);
    return projected ? [projected] : [];
  });
  const repaired = ensureAdvisorUserTail(
    repairAdvisorToolProtocol(sanitized, input.inflightToolCallId),
    input.timestamp,
  );
  const inventory = buildAdvisorInventory(input.executorTools, input.timestamp ?? 0);
  const compacted = compactGenerationContext(repaired, {
    contextWindow: input.reviewerContextWindow,
    // Reserve inventory as static context, then send it as a stable first message.
    systemPrompt: `${input.reviewerSystemPrompt}\n\n${inventory?.text ?? ""}`,
    tools: [],
    supportsImages: input.reviewerSupportsImages,
  });
  const finalBranch = ensureAdvisorUserTail(
    repairAdvisorToolProtocol(compacted.messages as Message[], input.inflightToolCallId),
    input.timestamp,
  );
  return {
    messages: inventory ? [inventory.message, ...finalBranch] : finalBranch,
    ...(inventory ? { inventoryHash: inventory.hash } : {}),
    inventoryTruncated: inventory?.truncated ?? false,
    compacted: compacted.compacted,
    usedContextFallback: compacted.usedContextFallback,
  };
}

export function boundedAdvisorText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= ADVISOR_RESULT_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, ADVISOR_RESULT_MAX_CHARS)}\n\n[Advisor response truncated by Aiden.]`;
}
