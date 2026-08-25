import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { unreportedUsageRecord } from "./usage-accounting.js";
import type { UsageRequestRecord } from "./usage-store-core.js";

interface AidenRemoteSpeechTranscriptionDependencies<TInput> {
  transcribe(input: TInput, modelId: string): string | Promise<string>;
  recordUsage(record: UsageRequestRecord): Promise<void>;
}

async function recordUsageBestEffort<TInput>(
  dependencies: AidenRemoteSpeechTranscriptionDependencies<TInput>,
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

export async function completeAidenRemoteSpeechTranscription<TInput>(
  input: TInput,
  modelId: string,
  dependencies: AidenRemoteSpeechTranscriptionDependencies<TInput>,
): Promise<{ text: string; modelId: string }> {
  try {
    const text = await dependencies.transcribe(input, modelId);
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
