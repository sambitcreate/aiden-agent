import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { unreportedUsageRecord } from "./usage-accounting.js";
import type { UsageRequestRecord } from "./usage-store-core.js";

interface AidenRemoteSpeechTranscriptionDependencies {
  transcribePcm(samples: Float32Array, modelId: string): string;
  recordUsage(record: UsageRequestRecord): Promise<void>;
}

async function recordUsageBestEffort(
  dependencies: AidenRemoteSpeechTranscriptionDependencies,
  record: UsageRequestRecord,
): Promise<void> {
  try {
    await dependencies.recordUsage(record);
  } catch {
    // The transcript is the primary operation. Local usage persistence is
    // observational and must never replace its success or original error.
  }
}

function speechUsage(modelId: string, status: "completed" | "failed"): UsageRequestRecord {
  return unreportedUsageRecord({
    source: "voice-transcription",
    providerId: "local-voice",
    providerLabel: "Paired Mac voice",
    modelId,
    local: true,
    status,
  });
}

export async function completeAidenRemoteSpeechTranscription(
  samples: Float32Array,
  modelId: string,
  dependencies: AidenRemoteSpeechTranscriptionDependencies,
): Promise<{ text: string; modelId: string }> {
  try {
    const text = dependencies.transcribePcm(samples, modelId);
    if ([...text].length > 200_000) {
      throw new AidenRemoteServiceError(
        "internal_error",
        "The speech transcript exceeded the supported limit.",
        500,
      );
    }
    await recordUsageBestEffort(dependencies, speechUsage(modelId, "completed"));
    return { text, modelId };
  } catch (error) {
    await recordUsageBestEffort(dependencies, speechUsage(modelId, "failed"));
    throw error;
  }
}
