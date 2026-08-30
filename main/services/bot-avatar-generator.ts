import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { BotAvatarSuggestion, BotAvatarSuggestionInput } from "../../renderer/shared/bots.js";
import { isNonChatModel } from "../../renderer/shared/model-eligibility.js";
import { resolveModelRuntime } from "./model-runtime.js";
import { modelsCatalog } from "./models-catalog.js";
import {
  assistantUsageRecord,
  isLocalModelProvider,
  unreportedUsageRecord,
} from "./usage-accounting.js";
import { usageStore } from "./usage-store.js";
import {
  BOT_AVATAR_SYSTEM_PROMPT,
  botAvatarGenerationFailureMessage,
  boundedBotAvatarText,
  buildBotAvatarPrompt,
  consumeBoundedBotAvatarResult,
  fallbackBotAvatarSuggestion,
  finishBotAvatarAccounting,
  parseGeneratedBotAvatar,
  waitForBotAvatarBoundary,
} from "./bot-avatar-generator-core.js";

const AVATAR_GENERATION_TIMEOUT_MS = 30_000;

class PublicBotAvatarGenerationError extends Error {}

function publicFailure(kind: "cancelled" | "provider" | "timeout"): PublicBotAvatarGenerationError {
  return new PublicBotAvatarGenerationError(botAvatarGenerationFailureMessage(kind));
}

export async function generateBotAvatarSuggestion(
  input: BotAvatarSuggestionInput,
  callerSignal?: AbortSignal,
): Promise<BotAvatarSuggestion> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AVATAR_GENERATION_TIMEOUT_MS);

  try {
    controller.signal.throwIfAborted();
    const runtime = await waitForBotAvatarBoundary(
      resolveModelRuntime(input.providerId, input.model, controller.signal),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const catalogInfo = await waitForBotAvatarBoundary(
      modelsCatalog.bundledInfo(runtime.provider, input.model),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    if (
      isNonChatModel({
        model: input.model,
        metadataType: runtime.provider.modelMetadata?.[input.model]?.type,
        catalogType: catalogInfo.modelType,
      })
    ) {
      throw publicFailure("provider");
    }
    let result: AssistantMessage;
    try {
      controller.signal.throwIfAborted();
      const stream = runtime.streams.streamSimple(
        runtime.model,
        {
          systemPrompt: BOT_AVATAR_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildBotAvatarPrompt(input),
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: runtime.apiKey,
          headers: runtime.headers,
          signal: controller.signal,
          temperature: 0.45,
          maxTokens: Math.min(1_024, runtime.model.maxTokens),
          timeoutMs: AVATAR_GENERATION_TIMEOUT_MS,
          maxRetries: 0,
          cacheRetention: "none",
        },
      );
      result = await consumeBoundedBotAvatarResult(
        stream,
        () => controller.abort(),
        controller.signal,
      );
      controller.signal.throwIfAborted();
    } catch {
      await finishBotAvatarAccounting(
        usageStore.record(
          unreportedUsageRecord({
            source: "bot-avatar",
            providerId: runtime.provider.id,
            providerLabel: runtime.provider.label,
            modelId: runtime.model.id,
            modelLabel: runtime.model.name,
            local: isLocalModelProvider(runtime.provider),
            status: callerSignal?.aborted && !timedOut ? "cancelled" : "failed",
          }),
        ),
        controller.signal,
      );
      throw publicFailure(timedOut ? "timeout" : callerSignal?.aborted ? "cancelled" : "provider");
    }

    const text = boundedBotAvatarText(result.content);
    const usageRecord = assistantUsageRecord({
      // Avatar accounting is keyed to the selected runtime, never provider-authored metadata.
      message: { ...result, responseModel: undefined },
      provider: runtime.provider,
      model: runtime.model,
      source: "bot-avatar",
    });
    const usageFailed =
      timedOut || text === null || (result.stopReason === "aborted" && !callerSignal?.aborted);
    await finishBotAvatarAccounting(
      usageStore.record(usageFailed ? { ...usageRecord, status: "failed" } : usageRecord),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw publicFailure(timedOut ? "timeout" : callerSignal?.aborted ? "cancelled" : "provider");
    }
    if (text === null) throw publicFailure("provider");
    return (
      parseGeneratedBotAvatar(text, input.currentAvatar) ??
      fallbackBotAvatarSuggestion(input.prompt, input.currentAvatar, text)
    );
  } catch (error) {
    if (error instanceof PublicBotAvatarGenerationError) throw error;
    throw publicFailure(timedOut ? "timeout" : callerSignal?.aborted ? "cancelled" : "provider");
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abort);
  }
}
