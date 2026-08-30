import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { isLocalProviderDeployment } from "../../renderer/shared/provider-deployment.js";
import type { StoredProvider, UsageTokenBreakdown } from "./types.js";
import type {
  UsageRequestRecord,
  UsageRequestSource,
  UsageRequestStatus,
} from "./usage-store-core.js";

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function openAITranscriptionTokens(value: unknown): UsageTokenBreakdown | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  if (usage.type === "duration") return null;
  const input = positiveInteger(usage.input_tokens);
  const output = positiveInteger(usage.output_tokens);
  const total = positiveInteger(usage.total_tokens) || input + output;
  if (total === 0 && input === 0 && output === 0) return null;
  return { input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, total };
}

export function geminiTranscriptionTokens(value: unknown): UsageTokenBreakdown | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const count = (camelCase: string, snakeCase: string) =>
    positiveInteger(usage[camelCase]) || positiveInteger(usage[snakeCase]);
  // Gemini's prompt count already includes cached content. Keep the same
  // mutually-exclusive input/cache buckets as Pi's chat usage accounting.
  const prompt = count("promptTokenCount", "total_input_tokens");
  const cacheRead = count("cachedContentTokenCount", "total_cached_tokens");
  const input = Math.max(0, prompt - cacheRead);
  const reasoning = count("thoughtsTokenCount", "total_thought_tokens");
  const output =
    (positiveInteger(usage.candidatesTokenCount) ||
      positiveInteger(usage.responseTokenCount) ||
      positiveInteger(usage.total_output_tokens)) + reasoning;
  const total = count("totalTokenCount", "total_tokens") || prompt + output;
  if (total === 0 && prompt === 0 && output === 0 && cacheRead === 0) return null;
  return { input, output, cacheRead, cacheWrite: 0, reasoning, total };
}

export function reportedTokens(
  usage: Partial<Usage> | null | undefined,
): UsageTokenBreakdown | null {
  if (!usage) return null;
  const cacheWrite1h = positiveInteger(usage.cacheWrite1h);
  const tokens: UsageTokenBreakdown = {
    input: positiveInteger(usage.input),
    output: positiveInteger(usage.output),
    cacheRead: positiveInteger(usage.cacheRead),
    cacheWrite: positiveInteger(usage.cacheWrite),
    ...(cacheWrite1h > 0 ? { cacheWrite1h } : {}),
    reasoning: positiveInteger(usage.reasoning),
    total: positiveInteger(usage.totalTokens),
  };
  const reported =
    tokens.total > 0 ||
    tokens.input > 0 ||
    tokens.output > 0 ||
    tokens.cacheRead > 0 ||
    tokens.cacheWrite > 0 ||
    tokens.reasoning > 0;
  if (!reported) return null;
  if (tokens.total === 0) {
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  }
  return tokens;
}

export function isLocalModelProvider(
  provider: Pick<StoredProvider, "id" | "label" | "baseUrl" | "needsKey" | "deployment">,
): boolean {
  return isLocalProviderDeployment(provider);
}

function modelHasPricing(model: Model<Api>): boolean {
  return [model.cost, ...(model.cost.tiers ?? [])].some((rates) =>
    [rates.input, rates.output, rates.cacheRead, rates.cacheWrite].some(
      (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
    ),
  );
}

function statusFor(message: AssistantMessage): UsageRequestStatus {
  if (message.stopReason === "aborted") return "cancelled";
  if (message.stopReason === "error" || message.stopReason === "length") return "failed";
  return "completed";
}

/**
 * Tracks the one provider request currently represented by Pi's assistant
 * message lifecycle. A transport abort can end a request before Pi emits
 * `message_end`; callers consume that open request exactly once for fallback
 * cancellation accounting.
 */
export class AssistantRequestUsageTracker {
  private open = false;

  started(): void {
    this.open = true;
  }

  ended(): void {
    this.open = false;
  }

  takeUnreportedCancellation(): boolean {
    if (!this.open) return false;
    this.open = false;
    return true;
  }
}

export function assistantUsageRecord(input: {
  message: AssistantMessage;
  provider: StoredProvider;
  model: Model<Api>;
  source: UsageRequestSource;
}): UsageRequestRecord {
  const local = isLocalModelProvider(input.provider);
  const responseModel = input.message.responseModel?.trim();
  const usageCost = input.message.usage.cost;
  const costUsd =
    typeof usageCost?.total === "number" && Number.isFinite(usageCost.total)
      ? Math.max(0, usageCost.total)
      : 0;
  return {
    timestamp: input.message.timestamp,
    source: input.source,
    providerId: input.provider.id,
    providerLabel: input.provider.label,
    modelId: responseModel || input.model.id,
    modelLabel: responseModel || input.model.name || input.model.id,
    local,
    status: statusFor(input.message),
    tokens: reportedTokens(input.message.usage),
    costStatus: local
      ? "not-applicable"
      : costUsd > 0 || modelHasPricing(input.model)
        ? "reported"
        : "unavailable",
    costUsd,
  };
}

export function unreportedUsageRecord(input: {
  source: UsageRequestSource;
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel?: string;
  local: boolean;
  status: UsageRequestStatus;
  timestamp?: number;
}): UsageRequestRecord {
  return {
    timestamp: input.timestamp,
    source: input.source,
    providerId: input.providerId,
    providerLabel: input.providerLabel,
    modelId: input.modelId,
    modelLabel: input.modelLabel || input.modelId,
    local: input.local,
    status: input.status,
    tokens: null,
    costStatus: input.local ? "not-applicable" : "unavailable",
  };
}
