/**
 * Cache breakpoints Pi does not place, added through the provider payload hook.
 *
 * - Anthropic Messages: Pi marks the last tool, the one system block and the
 *   last user message, three of the four breakpoints the wire allows. The
 *   fourth goes at the end of the stable head: the system text is split where
 *   the frozen-state tail (memory and canvas) starts, and the stable part gets
 *   its own block with the same marker, so a change in the tail leaves the
 *   tools and the stable system prompt cached.
 * - Bedrock Converse: Pi puts cachePoints after the system prompt and on the
 *   last user message only. A cachePoint after the tools caches the tool list
 *   on its own.
 *
 * Both are pure payload rewrites: nothing is added when the request carries no
 * cache marker (caching off, or a provider without caching), when the wire
 * already holds four markers, or when the system text does not start with the
 * stable head the chat registered. The stable head is registered per chat
 * (the request's `sessionId`), so foreground requests, cache warming and side
 * calls that replay the chat's request place the same breakpoints.
 */
import type { ProviderStreams } from "@earendil-works/pi-ai";

type StreamSimple = ProviderStreams["streamSimple"];

/** Anthropic allows four cache_control markers per request. */
export const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;
/** Bedrock Converse allows four cachePoints per request. */
export const MAX_BEDROCK_CACHE_POINTS = 4;
const MAX_REGISTERED_CHATS = 256;

const stableHeads = new Map<string, string>();

/**
 * Remember the chat's stable head: the system prompt before its frozen-state
 * tail. Empty or undefined forgets it. Holds the most recent chats only.
 */
export function rememberStableHead(chatId: string, stableHead: string | undefined): void {
  stableHeads.delete(chatId);
  if (!stableHead) return;
  stableHeads.set(chatId, stableHead);
  while (stableHeads.size > MAX_REGISTERED_CHATS) {
    const oldest = stableHeads.keys().next().value;
    if (oldest === undefined) break;
    stableHeads.delete(oldest);
  }
}

/** The stable head registered for a chat, if any. */
export function stableHeadFor(chatId: string | undefined): string | undefined {
  return chatId === undefined ? undefined : stableHeads.get(chatId);
}

/**
 * The part of a composed system prompt before its frozen-state tail, or
 * undefined when the prompt has no tail or does not end with it.
 */
export function stableHeadOf(systemPrompt: string, frozenStateTail: string): string | undefined {
  if (!frozenStateTail || !systemPrompt.endsWith(`\n\n${frozenStateTail}`)) return undefined;
  const head = systemPrompt.slice(0, systemPrompt.length - frozenStateTail.length - 2);
  return head.trim() ? head : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countKey(value: unknown, key: string): number {
  if (Array.isArray(value)) return value.reduce<number>((total, item) => total + countKey(item, key), 0);
  if (!isRecord(value)) return 0;
  let total = key in value ? 1 : 0;
  for (const [name, child] of Object.entries(value)) {
    if (name !== key) total += countKey(child, key);
  }
  return total;
}

/** Every `cache_control` marker in an Anthropic Messages payload. */
export function anthropicCacheBreakpoints(payload: unknown): number {
  return countKey(payload, "cache_control");
}

/** Every `cachePoint` block in a Bedrock Converse payload. */
export function bedrockCachePoints(payload: unknown): number {
  return countKey(payload, "cachePoint");
}

/**
 * The payload with the stable head in its own cached system block, or
 * undefined when nothing changes.
 */
export function withStableHeadBreakpoint(payload: unknown, stableHead: string | undefined): Record<string, unknown> | undefined {
  if (!stableHead || !isRecord(payload) || !Array.isArray(payload.system) || payload.system.length !== 1) return undefined;
  const [block] = payload.system as unknown[];
  if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string" || !isRecord(block.cache_control)) return undefined;
  if (anthropicCacheBreakpoints(payload) >= MAX_ANTHROPIC_CACHE_BREAKPOINTS) return undefined;
  const boundary = `${stableHead}\n\n`;
  if (!block.text.startsWith(boundary) || block.text.length === boundary.length) return undefined;
  return {
    ...payload,
    system: [
      { type: "text", text: stableHead, cache_control: { ...block.cache_control } },
      { ...block, text: block.text.slice(boundary.length) },
    ],
  };
}

/**
 * The payload with a cachePoint after the declared tools, or undefined when
 * nothing changes. Shaped like the system cachePoint, so both share a TTL.
 */
export function withBedrockToolsCachePoint(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload) || !isRecord(payload.toolConfig) || !Array.isArray(payload.toolConfig.tools)) return undefined;
  const tools = payload.toolConfig.tools as unknown[];
  if (!tools.some((tool) => isRecord(tool) && "toolSpec" in tool)) return undefined;
  if (tools.some((tool) => isRecord(tool) && "cachePoint" in tool)) return undefined;
  const system = Array.isArray(payload.system) ? (payload.system as unknown[]) : [];
  const systemPoint = system.find((block): block is { cachePoint: Record<string, unknown> } =>
    isRecord(block) && isRecord(block.cachePoint));
  const anyPoint = bedrockCachePoints(payload) > 0;
  if (!anyPoint || bedrockCachePoints(payload) >= MAX_BEDROCK_CACHE_POINTS) return undefined;
  const cachePoint = systemPoint ? { ...systemPoint.cachePoint } : { type: "default" };
  return { ...payload, toolConfig: { ...payload.toolConfig, tools: [...tools, { cachePoint }] } };
}

/** The payload rewrite for one request, or undefined when nothing changes. */
export function withPromptCacheBreakpointsPayload(
  payload: unknown,
  api: string,
  stableHead: string | undefined,
): Record<string, unknown> | undefined {
  if (api === "anthropic-messages") return withStableHeadBreakpoint(payload, stableHead);
  if (api === "bedrock-converse-stream") return withBedrockToolsCachePoint(payload);
  return undefined;
}

/**
 * Add the breakpoints on every request through `streamFn`. Runs before any
 * payload hook the caller passed, which then sees the final payload.
 */
export function withPromptCacheBreakpoints(streamFn: StreamSimple): StreamSimple {
  return (model, context, options) => {
    if (model.api !== "anthropic-messages" && model.api !== "bedrock-converse-stream") {
      return streamFn(model, context, options);
    }
    const stableHead = stableHeadFor(options?.sessionId);
    const hostOnPayload = options?.onPayload;
    return streamFn(model, context, {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const rewritten = withPromptCacheBreakpointsPayload(payload, payloadModel.api, stableHead);
        const current = rewritten ?? payload;
        const hostReplacement = await hostOnPayload?.(current, payloadModel);
        return hostReplacement ?? rewritten;
      },
    });
  };
}
