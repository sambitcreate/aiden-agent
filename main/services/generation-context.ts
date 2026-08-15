import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  shouldCompact,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";

const TOOL_RESULT_TEXT_LIMIT_CHARS = 32_000;
const RECENT_TOOL_OUTPUT_BUDGET_TOKENS = 40_000;
const MIN_RECENT_TOOL_RESULTS = 2;
const RESPONSE_RESERVE_RATIO = 0.2;
const SAFETY_RESERVE_RATIO = 0.05;
const MIN_RESERVE_TOKENS = 1_024;
const CONTEXT_FALLBACK_TEXT =
  "[Aiden context notice: The active conversation could not be safely retained within this model's context window. Explain that the user should retry with a larger-context model or fewer/lower-size attachments. Do not call tools for this notice.]";

export interface GenerationContextOptions {
  contextWindow: number;
  systemPrompt: string;
  tools: readonly AgentTool[];
  /** Project model-neutral journal images only when this request can accept them. */
  supportsImages?: boolean;
}

export interface GenerationContextCompaction {
  messages: AgentMessage[];
  compacted: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  inputBudgetTokens: number;
  truncatedToolResults: number;
  compactedToolResults: number;
  removedHistoryMessages: number;
  removedCurrentTurnMessages: number;
  usedContextFallback: boolean;
}

type CompactionListener = (result: GenerationContextCompaction) => void;

function safeJsonLength(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? "").length;
  } catch {
    return 0;
  }
}

function staticContextTokens(options: GenerationContextOptions): number {
  let chars = options.systemPrompt.length;
  for (const tool of options.tools) {
    const serialized = safeJsonLength({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
    });
    chars +=
      serialized ||
      tool.name.length +
        tool.label.length +
        tool.description.length +
        safeJsonLength(tool.parameters) +
        64;
  }
  return Math.ceil(chars / 4);
}

function messageTokens(messages: AgentMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
}

function isToolResult(message: AgentMessage): message is ToolResultMessage {
  return message.role === "toolResult";
}

const OMITTED_IMAGE_TEXT =
  "[Image content retained in Aiden's private journal but omitted from this text-only model request.]";

/** Project model-neutral journal history onto one model's input modalities. */
export function projectMessagesForModel(
  messages: readonly AgentMessage[],
  supportsImages: boolean,
): AgentMessage[] {
  if (supportsImages) return messages as AgentMessage[];
  return messages.map((message) => {
    if (
      (message.role !== "user" && message.role !== "toolResult") ||
      typeof message.content === "string" ||
      !message.content.some((part) => part.type === "image")
    ) {
      return message;
    }
    const content = message.content.filter((part) => part.type !== "image");
    const notice = { type: "text" as const, text: OMITTED_IMAGE_TEXT };
    return { ...message, content: [...content, notice] } as AgentMessage;
  });
}

/** Keep only the newest Computer Use screenshots while preserving every text result. */
export function limitComputerUseImages(
  messages: AgentMessage[],
  keep = 3,
): AgentMessage[] {
  const imageIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message?.role === "toolResult" &&
      message.toolName === "computer_use" &&
      message.content.some((part) => part.type === "image")
    ) {
      imageIndexes.push(index);
    }
  }
  const keepCount = Number.isFinite(keep)
    ? Math.max(0, Math.floor(keep))
    : imageIndexes.length;
  if (imageIndexes.length <= keepCount) return messages;
  const strip = new Set(imageIndexes.slice(0, imageIndexes.length - keepCount));
  return messages.map((message, index) => {
    if (!strip.has(index) || !isToolResult(message)) return message;
    return {
      ...message,
      content: message.content.filter((part) => part.type !== "image"),
    };
  });
}

function compactedToolResult(message: ToolResultMessage): ToolResultMessage {
  const outcome = message.isError ? "error payload" : "result payload";
  return {
    ...message,
    content: [
      {
        type: "text",
        text: `[Earlier ${message.toolName} ${outcome} omitted to stay within the model context window. This tool call already completed; do not repeat it solely because its payload was omitted.]`,
      },
    ],
  };
}

function contextFallback(messages: AgentMessage[]): UserMessage {
  const timestamp = messages.reduce(
    (latest, message) =>
      "timestamp" in message && Number.isFinite(message.timestamp)
        ? Math.max(latest, message.timestamp)
        : latest,
    0,
  );
  return {
    role: "user",
    content: CONTEXT_FALLBACK_TEXT,
    timestamp: timestamp || Date.now(),
  };
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  const marker = `\n\n[... ${omitted.toLocaleString("en-US")} characters compacted ...]\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${marker}${tail ? text.slice(-tail) : ""}`;
}

function truncateToolResult(message: ToolResultMessage): {
  message: ToolResultMessage;
  truncated: boolean;
} {
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  if (text.length <= TOOL_RESULT_TEXT_LIMIT_CHARS) {
    return { message, truncated: false };
  }
  const images = message.content.filter((part) => part.type === "image");
  return {
    message: {
      ...message,
      content: [
        {
          type: "text",
          text: truncateText(text, TOOL_RESULT_TEXT_LIMIT_CHARS),
        },
        ...images,
      ],
    },
    truncated: true,
  };
}

function lastUserIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function removeOldHistoricalTurn(
  messages: AgentMessage[],
  preserveUserTurns: number,
): number {
  const currentUser = lastUserIndex(messages);
  if (currentUser <= 0) return 0;
  const userIndexes = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (userIndexes.length <= preserveUserTurns) return 0;
  const nextUser = userIndexes[1];
  if (nextUser === undefined || nextUser > currentUser) return 0;
  const firstUser = userIndexes[0];
  if (firstUser === undefined) return 0;
  const removed = nextUser - firstUser;
  messages.splice(firstUser, removed);
  return removed;
}

function replaceToolResult(messages: AgentMessage[], index: number): boolean {
  const message = messages[index];
  if (!message || !isToolResult(message)) return false;
  messages[index] = compactedToolResult(message);
  return true;
}

function currentTurnToolResultIndexes(messages: AgentMessage[]): number[] {
  const currentUser = lastUserIndex(messages);
  if (currentUser < 0) return [];
  const indexes: number[] = [];
  for (let index = currentUser + 1; index < messages.length; index += 1) {
    if (isToolResult(messages[index])) indexes.push(index);
  }
  return indexes;
}

function protectedRecentToolResults(
  messages: AgentMessage[],
  indexes: number[],
  budgetTokens: number,
): Set<number> {
  const protectedIndexes = new Set<number>();
  let tokens = 0;
  for (let position = indexes.length - 1; position >= 0; position -= 1) {
    const index = indexes[position];
    if (index === undefined) continue;
    const message = messages[index];
    if (!message || !isToolResult(message)) continue;
    const nextTokens = tokens + estimateTokens(message);
    if (
      protectedIndexes.size < MIN_RECENT_TOOL_RESULTS ||
      nextTokens <= budgetTokens
    ) {
      protectedIndexes.add(index);
      tokens = nextTokens;
      continue;
    }
    break;
  }
  return protectedIndexes;
}

function removeOldestCurrentTurnBatch(messages: AgentMessage[]): number {
  const currentUser = lastUserIndex(messages);
  if (currentUser < 0) return 0;
  const assistantIndexes: number[] = [];
  for (let index = currentUser + 1; index < messages.length; index += 1) {
    if (messages[index]?.role === "assistant") assistantIndexes.push(index);
  }
  if (assistantIndexes.length <= 1) return 0;
  const start = assistantIndexes[0];
  const end = assistantIndexes[1];
  if (start === undefined || end === undefined) return 0;
  messages.splice(start, end - start);
  return end - start;
}

interface GenerationContextLimits {
  contextWindow: number;
  reserveTokens: number;
  staticTokens: number;
  inputBudgetTokens: number;
}

function contextLimits(
  options: GenerationContextOptions,
): GenerationContextLimits {
  const contextWindow =
    Number.isFinite(options.contextWindow) && options.contextWindow > 0
      ? Math.max(1, Math.floor(options.contextWindow))
      : 1;
  const responseReserve = Math.min(
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    Math.max(
      MIN_RESERVE_TOKENS,
      Math.floor(contextWindow * RESPONSE_RESERVE_RATIO),
    ),
  );
  const safetyReserve = Math.max(
    MIN_RESERVE_TOKENS,
    Math.floor(contextWindow * SAFETY_RESERVE_RATIO),
  );
  const reserveTokens = Math.min(
    contextWindow - 1,
    responseReserve + safetyReserve,
  );
  return {
    contextWindow,
    reserveTokens,
    staticTokens: staticContextTokens(options),
    inputBudgetTokens: Math.max(0, contextWindow - reserveTokens),
  };
}

/**
 * A transform can remove messages, but it cannot change Pi's separately-owned
 * system prompt or tool schemas. Fail before provider I/O when even Aiden's
 * bounded recovery notice cannot fit beside that static context.
 */
export function assertGenerationContextCapacity(
  options: GenerationContextOptions,
): void {
  if (!Number.isFinite(options.contextWindow) || options.contextWindow <= 0) {
    throw new Error(
      "The selected model does not report a usable context window.",
    );
  }
  const limits = contextLimits(options);
  const fallbackTokens = estimateTokens(contextFallback([]));
  if (limits.staticTokens + fallbackTokens > limits.inputBudgetTokens) {
    throw new Error(
      `The selected model's ${limits.contextWindow.toLocaleString("en-US")}-token context window is too small for Aiden's active system prompt and tools. Choose a larger-context model or disable integrations that add tools.`,
    );
  }
}

export function compactGenerationContext(
  messages: AgentMessage[],
  options: GenerationContextOptions,
): GenerationContextCompaction {
  const retained = limitComputerUseImages(
    projectMessagesForModel(messages, options.supportsImages !== false),
  );
  const { contextWindow, reserveTokens, staticTokens, inputBudgetTokens } =
    contextLimits(options);
  const estimatedMessageTokensBefore = messageTokens(retained);
  const providerEstimate = estimateContextTokens(retained);
  const providerAwareTokens = providerEstimate.tokens;
  const estimatedTokensBefore = Math.max(
    providerAwareTokens,
    estimatedMessageTokensBefore + staticTokens,
  );
  const usageAnchor =
    providerEstimate.lastUsageIndex === null
      ? undefined
      : retained[providerEstimate.lastUsageIndex];
  const estimatedPrefixTokens =
    providerEstimate.lastUsageIndex === null
      ? 0
      : messageTokens(retained.slice(0, providerEstimate.lastUsageIndex + 1));
  const providerPrefixRatio =
    providerEstimate.usageTokens > 0 && estimatedPrefixTokens > 0
      ? Math.max(
          1,
          (providerEstimate.usageTokens - staticTokens) / estimatedPrefixTokens,
        )
      : 1;
  const estimatedTotalTokens = (candidate: AgentMessage[]) => {
    const estimatedMessages = messageTokens(candidate);
    const heuristicTotal = staticTokens + estimatedMessages;
    if (!usageAnchor) return Math.ceil(heuristicTotal);

    const anchorIndex = candidate.indexOf(usageAnchor);
    if (anchorIndex < 0) {
      // Once the complete usage-bearing prefix is gone, Pi's provider
      // measurement no longer describes this outbound request.
      return Math.ceil(heuristicTotal);
    }
    const retainedPrefixTokens = messageTokens(
      candidate.slice(0, anchorIndex + 1),
    );
    const trailingTokens = messageTokens(candidate.slice(anchorIndex + 1));
    return Math.ceil(
      Math.max(
        heuristicTotal,
        staticTokens +
          retainedPrefixTokens * providerPrefixRatio +
          trailingTokens,
      ),
    );
  };
  const messageBudgetTokens = Math.max(
    0,
    Math.floor((inputBudgetTokens - staticTokens) / providerPrefixRatio),
  );
  const settings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    reserveTokens,
  };

  if (!shouldCompact(estimatedTokensBefore, contextWindow, settings)) {
    return {
      messages: retained,
      compacted: false,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
      inputBudgetTokens,
      truncatedToolResults: 0,
      compactedToolResults: 0,
      removedHistoryMessages: 0,
      removedCurrentTurnMessages: 0,
      usedContextFallback: false,
    };
  }

  let truncatedToolResults = 0;
  const transformed = retained.map((message) => {
    if (!isToolResult(message)) return message;
    const truncated = truncateToolResult(message);
    if (truncated.truncated) truncatedToolResults += 1;
    return truncated.message;
  });
  const overBudget = () =>
    estimatedTotalTokens(transformed) > inputBudgetTokens;
  let removedHistoryMessages = 0;
  let compactedToolResults = 0;
  let removedCurrentTurnMessages = 0;
  let usedContextFallback = false;

  // Match OpenCode's preference for keeping the two newest user turns.
  while (overBudget()) {
    const removed = removeOldHistoricalTurn(transformed, 2);
    if (!removed) break;
    removedHistoryMessages += removed;
  }

  if (overBudget()) {
    const toolIndexes = currentTurnToolResultIndexes(transformed);
    const recentBudget = Math.min(
      RECENT_TOOL_OUTPUT_BUDGET_TOKENS,
      Math.max(MIN_RESERVE_TOKENS, Math.floor(messageBudgetTokens * 0.45)),
    );
    const protectedIndexes = protectedRecentToolResults(
      transformed,
      toolIndexes,
      recentBudget,
    );

    for (const index of toolIndexes) {
      if (!overBudget()) break;
      if (protectedIndexes.has(index)) continue;
      if (replaceToolResult(transformed, index)) compactedToolResults += 1;
    }

    const newestProtected = [...protectedIndexes].sort(
      (left, right) => left - right,
    );
    while (overBudget() && newestProtected.length > MIN_RECENT_TOOL_RESULTS) {
      const index = newestProtected.shift();
      if (index !== undefined && replaceToolResult(transformed, index)) {
        compactedToolResults += 1;
      }
    }
  }

  // If one older chat turn still prevents the current work from fitting, prefer
  // the active request and its evidence over rehydrated transcript history.
  if (overBudget()) {
    const currentUser = lastUserIndex(transformed);
    if (currentUser > 0) {
      let checkpointIndex = -1;
      for (let index = currentUser - 1; index >= 0; index -= 1) {
        if (transformed[index]?.role === "compactionSummary") {
          checkpointIndex = index;
          break;
        }
      }
      const start = checkpointIndex >= 0 ? checkpointIndex + 1 : 0;
      const removed = currentUser - start;
      transformed.splice(start, removed);
      removedHistoryMessages += removed;
    }
  }

  while (overBudget()) {
    const removed = removeOldestCurrentTurnBatch(transformed);
    if (!removed) break;
    removedCurrentTurnMessages += removed;
  }

  // This is an extreme fallback for small-context local models: keep the latest
  // tool-call protocol intact, but make even its result re-fetchable.
  if (overBudget()) {
    const toolIndexes = currentTurnToolResultIndexes(transformed);
    for (const index of toolIndexes) {
      if (!overBudget()) break;
      const message = transformed[index];
      if (
        message &&
        isToolResult(message) &&
        message.content[0]?.type === "text" &&
        !message.content[0].text.includes("payload omitted to stay within")
      ) {
        if (replaceToolResult(transformed, index)) compactedToolResults += 1;
      }
    }
  }

  // Never knowingly pass an over-window request to the provider. When the
  // active user message, attachment set, or final tool batch cannot fit without
  // breaking protocol, replace only the outbound context with a bounded notice
  // that cannot continue the tool loop. Persisted Agent/chat state is untouched.
  if (overBudget()) {
    removedCurrentTurnMessages += transformed.length;
    transformed.splice(0, transformed.length, contextFallback(retained));
    usedContextFallback = true;
  }

  return {
    messages: transformed,
    compacted: true,
    estimatedTokensBefore,
    estimatedTokensAfter: estimatedTotalTokens(transformed),
    inputBudgetTokens,
    truncatedToolResults,
    compactedToolResults,
    removedHistoryMessages,
    removedCurrentTurnMessages,
    usedContextFallback,
  };
}

export function createGenerationContextTransform(
  options: GenerationContextOptions,
  onCompacted?: CompactionListener,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  return async (messages) => {
    try {
      const result = compactGenerationContext(messages, options);
      if (result.compacted && onCompacted) {
        try {
          onCompacted(result);
        } catch {
          // Pi requires context transforms to resolve with a safe value.
        }
      }
      return result.messages;
    } catch {
      // Pi requires context transforms to never reject.
      return messages;
    }
  };
}
