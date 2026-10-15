import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { Usage } from "@earendil-works/pi-ai";

import { emptyUsage } from "./pi-events.js";

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Token usage for one ACP turn. Subscription-backed agents report no price,
 * so cost stays zero. Some agents report counts under `_meta.quota` instead
 * of the standard `usage` field (pi-antigravity-acp-provider usage.ts, MIT).
 */
export function usageFromPrompt(response: PromptResponse): Usage {
  const usage = emptyUsage();
  const standard = record(response.usage);
  const tokens = record(record(record(response._meta)?.quota)?.token_count);
  usage.cacheRead = count(standard?.cachedReadTokens) ?? 0;
  usage.cacheWrite = count(standard?.cachedWriteTokens) ?? 0;
  const input = count(tokens?.input_tokens) ?? count(standard?.inputTokens) ?? 0;
  usage.input = Math.max(0, input - usage.cacheRead);
  usage.output = count(tokens?.output_tokens) ?? count(standard?.outputTokens) ?? 0;
  const reasoning = count(standard?.thoughtTokens);
  if (reasoning !== undefined) usage.reasoning = reasoning;
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return usage;
}
