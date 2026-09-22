import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { compactGenerationContext } from "../generation-context.js";
import { chatMessageToPiMessage } from "../generation-messages.js";
import type { Chat } from "../types.js";
import { BTW_LIMITS } from "../../../renderer/shared/btw.js";

export const BTW_SYSTEM_PROMPT = `You are answering a quick side question about the user's current Aiden conversation.

Treat the supplied conversation as read-only background. Do not continue prior work, imitate tool calls, or claim to have performed actions. You have no tools. Answer the side question directly and concisely in plain text. Ground claims in the conversation when possible; if the context is insufficient, say so instead of guessing.`;

export interface BtwHistoryTurn {
  question: string;
  answer: string;
  timestamp: number;
}

function codePointSlice(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function safeText(value: string, max = 32_000): string {
  return codePointSlice(value, max);
}

function sanitizeMessage(message: Message): Message | null {
  if (message.role === "user") {
    const text = typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n\n");
    return { role: "user", content: safeText(text), timestamp: message.timestamp };
  }
  if (message.role === "assistant") {
    const text = message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (!text.trim()) return null;
    return {
      role: "assistant",
      content: [{ type: "text", text: safeText(text) }],
      api: message.api,
      provider: message.provider,
      model: message.model,
      usage: message.usage,
      stopReason: message.stopReason,
      timestamp: message.timestamp,
    };
  }
  // BTW is intentionally a plain-text, read-only view of visible user and
  // assistant prose. Tool results can contain private filesystem or command
  // output and become invalid protocol orphans after tool calls are removed.
  return null;
}

export function boundedContextMessages(messages: readonly Message[]): Message[] {
  const retained: Message[] = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (retained.length >= BTW_LIMITS.contextMessages) break;
    const sanitized = sanitizeMessage(messages[index]!);
    if (!sanitized) continue;
    const serialized = JSON.stringify(sanitized);
    const nextBytes = Buffer.byteLength(serialized, "utf8");
    if (retained.length > 0 && bytes + nextBytes > BTW_LIMITS.contextBytes) break;
    bytes += nextBytes;
    retained.unshift(sanitized);
  }
  while (retained.length > 0 && retained[0]?.role !== "user") retained.shift();
  return retained;
}

export function completedVisibleContext(chat: Chat, model: Model<Api>): Message[] {
  let terminal = -1;
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index];
    if (
      message?.role === "assistant" &&
      message.content.trim() &&
      (!message.pi || message.pi.stopReason === "stop" || message.pi.stopReason === "length")
    ) {
      terminal = index;
      break;
    }
  }
  if (terminal < 0) return [];
  return boundedContextMessages(
    chat.messages
      .slice(0, terminal + 1)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => chatMessageToPiMessage(message, model, false)),
  );
}

export function boundedHistory(history: readonly BtwHistoryTurn[]): BtwHistoryTurn[] {
  const retained: BtwHistoryTurn[] = [];
  let bytes = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (retained.length >= BTW_LIMITS.historyTurns) break;
    const turn = history[index]!;
    const next = {
      question: codePointSlice(turn.question, BTW_LIMITS.questionCodePoints),
      answer: codePointSlice(turn.answer, BTW_LIMITS.answerCodePoints),
      timestamp: turn.timestamp,
    };
    const nextBytes = Buffer.byteLength(JSON.stringify(next), "utf8");
    if (retained.length > 0 && bytes + nextBytes > BTW_LIMITS.historyBytes) break;
    bytes += nextBytes;
    retained.unshift(next);
  }
  return retained;
}

export function buildBtwContext(input: {
  branch: readonly Message[];
  history: readonly BtwHistoryTurn[];
  question: string;
  model: Model<Api>;
  retry?: boolean;
}): { messages: Message[]; trimmed: boolean } {
  const history = boundedHistory(input.history);
  const historyMessages: Message[] = history.flatMap((turn) => [
    { role: "user" as const, content: turn.question, timestamp: turn.timestamp },
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: turn.answer }],
      api: input.model.api,
      provider: input.model.provider,
      model: input.model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: turn.timestamp,
    },
  ]);
  const branch = boundedContextMessages(input.branch);
  const retryBranch = input.retry ? branch.slice(Math.floor(branch.length / 2)) : branch;
  const assembled: Message[] = [
    ...retryBranch,
    ...historyMessages,
    { role: "user", content: input.question, timestamp: Date.now() },
  ];
  const transformed = compactGenerationContext(assembled, {
    contextWindow: input.retry
      ? Math.max(4_096, Math.floor(input.model.contextWindow / 2))
      : input.model.contextWindow,
    systemPrompt: BTW_SYSTEM_PROMPT,
    tools: [],
    supportsImages: false,
  });
  return {
    messages: transformed.messages as Message[],
    trimmed:
      input.branch.length !== branch.length ||
      input.retry === true ||
      transformed.compacted,
  };
}

export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}
