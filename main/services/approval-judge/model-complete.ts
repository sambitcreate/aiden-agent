// The judge's one model call, on a resolved model runtime: no tools, a short
// reply, no retries, no prompt cache. Every response is accounted as
// "approval-judge" usage and its cost counts toward the run's spending limit.

import { normalizeContext } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model, Models, ProviderHeaders, TextContent } from "@earendil-works/pi-ai";
import type { StoredProvider } from "../types.js";
import type { UsageRequestRecord } from "../usage-store-core.js";
import { assistantUsageRecord, isLocalModelProvider, unreportedUsageRecord } from "../usage-accounting.js";
import type { ApprovalJudgeComplete } from "./judge.js";

export interface ApprovalJudgeRuntime {
  model: Model<Api>;
  provider: StoredProvider;
  apiKey?: string;
  headers?: ProviderHeaders;
  streams: Pick<Models, "streamSimple">;
}

export interface ApprovalJudgeAccounting {
  /** Usage → the usage list ("approval-judge"). */
  recordUsage(record: UsageRequestRecord): Promise<void> | void;
  /** The response's cost → the run's spending limit. */
  countSpend(message: AssistantMessage): void;
}

function replyText(message: AssistantMessage): string {
  return message.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export function approvalJudgeComplete(runtime: ApprovalJudgeRuntime, accounting: ApprovalJudgeAccounting): ApprovalJudgeComplete {
  return async (request, signal) => {
    let message: AssistantMessage;
    try {
      message = await runtime.streams
        .streamSimple(
          runtime.model,
          normalizeContext({
            systemPrompt: request.systemPrompt,
            messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }],
          }),
          {
            apiKey: runtime.apiKey,
            headers: runtime.headers,
            signal,
            temperature: 0,
            maxTokens: request.maxTokens,
            timeoutMs: request.timeoutMs,
            maxRetries: 0,
            cacheRetention: "none",
          },
        )
        .result();
    } catch (error) {
      await accounting.recordUsage(
        unreportedUsageRecord({
          source: "approval-judge",
          providerId: runtime.provider.id,
          providerLabel: runtime.provider.label,
          modelId: runtime.model.id,
          modelLabel: runtime.model.name,
          local: isLocalModelProvider(runtime.provider),
          status: signal.aborted ? "cancelled" : "failed",
        }),
      );
      throw error;
    }
    accounting.countSpend(message);
    await accounting.recordUsage(
      assistantUsageRecord({ message, provider: runtime.provider, model: runtime.model, source: "approval-judge" }),
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage || `The approval judge ${message.stopReason}.`);
    }
    return replyText(message);
  };
}
