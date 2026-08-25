// Optional dictation polish via the user's current chat model. Failures return
// the original transcript so paste still succeeds.

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { logger } from "../platform.js";
import { configStore } from "./config-store.js";
import {
  buildDictationCleanupUserPrompt,
  DICTATION_CLEANUP_SYSTEM_PROMPT,
  DICTATION_CLEANUP_TIMEOUT_MS,
  dictationCleanupUsageIsLocal,
  sanitizeDictationCleanupOutput,
} from "./dictation-cleanup-core.js";
import { resolveModelRuntime } from "./model-runtime.js";
import {
  assistantUsageRecord,
  unreportedUsageRecord,
} from "./usage-accounting.js";
import { usageStore } from "./usage-store.js";

function assistantText(content: AssistantMessage["content"]): string {
  return content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export async function cleanupDictationTranscript(transcript: string): Promise<string> {
  const original = transcript.trim();
  if (!original) return transcript;
  const settings = await configStore.getSettings();
  const providerId = settings.lastProviderId;
  const modelId = settings.lastModel;
  if (!providerId || !modelId) return original;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DICTATION_CLEANUP_TIMEOUT_MS);
  try {
    const runtime = await resolveModelRuntime(providerId, modelId, controller.signal);
    const result = await runtime.streams
      .streamSimple(
        runtime.model,
        {
          systemPrompt: DICTATION_CLEANUP_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: buildDictationCleanupUserPrompt(original) }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: runtime.apiKey,
          headers: runtime.headers,
          signal: controller.signal,
          temperature: 0.1,
          maxTokens: 1_024,
          timeoutMs: DICTATION_CLEANUP_TIMEOUT_MS,
          maxRetries: 0,
          cacheRetention: "none",
        },
      )
      .result();
    await usageStore.record(
      assistantUsageRecord({
        message: result,
        provider: runtime.provider,
        model: runtime.model,
        source: "voice-transcription",
      }),
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      return original;
    }
    return sanitizeDictationCleanupOutput(assistantText(result.content), original);
  } catch (error) {
    logger.warn("dictation", "Transcript cleanup skipped.", error);
    try {
      const settingsAfter = await configStore.getSettings();
      if (settingsAfter.lastProviderId && settingsAfter.lastModel) {
        await usageStore.record(
          unreportedUsageRecord({
            source: "voice-transcription",
            providerId: settingsAfter.lastProviderId,
            providerLabel: settingsAfter.lastProviderId,
            modelId: settingsAfter.lastModel,
            local: dictationCleanupUsageIsLocal(
              await configStore.getProvider(settingsAfter.lastProviderId),
              settingsAfter.lastProviderId,
            ),
            status: controller.signal.aborted ? "cancelled" : "failed",
          }),
        );
      }
    } catch {
      // Usage is best-effort.
    }
    return original;
  } finally {
    clearTimeout(timer);
  }
}
