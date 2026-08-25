import { configStore } from "./config-store.js";
import {
  cancelDownload,
  deleteModel,
  downloadModel,
  listModels,
  localModelDownloadStates,
} from "./local-models.js";
import { engineStatus, releaseRecognizer, transcribePcm16Base64 } from "./parakeet.js";
import { usageStore } from "./usage-store.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { validateAidenRemotePcm16Base64 } from "./aiden-remote-speech-codec.js";
import { AidenRemoteSpeechLane } from "./aiden-remote-speech-lane.js";
import { completeAidenRemoteSpeechTranscription } from "./aiden-remote-speech-transcription.js";

const MAX_SPEECH_SECONDS = 60;
const SAMPLE_RATE = 16_000;

export interface AidenRemoteSpeechStatus {
  engine: { ready: boolean; error: string | null };
  selectedModelId: string | null;
  models: Array<ReturnType<typeof listModels>[number] & {
    download?: ReturnType<typeof localModelDownloadStates>[number];
  }>;
  input: {
    encoding: "pcm_s16le";
    sampleRate: typeof SAMPLE_RATE;
    channels: 1;
    maximumSeconds: typeof MAX_SPEECH_SECONDS;
    partialResults: false;
  };
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AidenRemoteServiceError("invalid_request", message, 400);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], message: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AidenRemoteServiceError("invalid_request", message, 400);
  }
}

function modelId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(value)) {
    throw new AidenRemoteServiceError("invalid_request", "The speech model identifier is invalid.", 400);
  }
  return value;
}

export class AidenRemoteSpeechService {
  private readonly transcriptionLane = new AidenRemoteSpeechLane(2);

  async status(): Promise<AidenRemoteSpeechStatus> {
    const settings = await configStore.getSettings();
    const downloads = new Map(localModelDownloadStates().map((value) => [value.id, value]));
    const engine = await engineStatus();
    return {
      engine: {
        ready: engine.ready,
        error: engine.ready ? null : "The Mac speech engine is unavailable. Restart Aiden Agent and try again.",
      },
      selectedModelId: settings.localVoiceModel || null,
      models: listModels().map((model) => ({
        ...model,
        ...(downloads.get(model.id)
          ? {
              download: {
                ...downloads.get(model.id)!,
                ...(downloads.get(model.id)?.error
                  ? { error: "The model download failed. Try again." }
                  : {}),
              },
            }
          : {}),
      })),
      input: {
        encoding: "pcm_s16le",
        sampleRate: SAMPLE_RATE,
        channels: 1,
        maximumSeconds: MAX_SPEECH_SECONDS,
        partialResults: false,
      },
    };
  }

  async select(input: unknown): Promise<AidenRemoteSpeechStatus> {
    const value = record(input, "A speech model selection is required.");
    exactKeys(value, ["modelId"], "A speech model selection must contain only modelId.");
    const id = modelId(value.modelId);
    const model = listModels().find((candidate) => candidate.id === id);
    if (!model) throw new AidenRemoteServiceError("not_found", "That speech model is unavailable.", 404);
    if (!model.installed) {
      throw new AidenRemoteServiceError("operation_stale", "Download the speech model before selecting it.", 409, true);
    }
    await configStore.setSettings({ localVoiceModel: id });
    return this.status();
  }

  async startDownload(idValue: unknown): Promise<AidenRemoteSpeechStatus> {
    const id = modelId(idValue);
    const model = listModels().find((candidate) => candidate.id === id);
    if (!model) throw new AidenRemoteServiceError("not_found", "That speech model is unavailable.", 404);
    if (!model.installed && !localModelDownloadStates().some((state) => state.id === id && state.status === "downloading")) {
      void downloadModel(id).catch(() => {
        // The bounded status projection exposes the failure for client polling.
      });
    }
    return this.status();
  }

  async cancelDownload(idValue: unknown): Promise<AidenRemoteSpeechStatus> {
    cancelDownload(modelId(idValue));
    return this.status();
  }

  async deleteModel(idValue: unknown): Promise<AidenRemoteSpeechStatus> {
    const id = modelId(idValue);
    return this.transcriptionLane.run(async () => {
      await releaseRecognizer(id);
      await deleteModel(id);
      const settings = await configStore.getSettings();
      if (settings.localVoiceModel === id) await configStore.setSettings({ localVoiceModel: "" });
      return this.status();
    });
  }

  async transcribe(input: unknown): Promise<{ text: string; modelId: string }> {
    const value = record(input, "A speech recording is required.");
    exactKeys(value, ["encoding", "sampleRate", "channels", "pcmBase64", "modelId"], "The speech recording contract is invalid.");
    if (value.encoding !== "pcm_s16le" || value.sampleRate !== SAMPLE_RATE || value.channels !== 1) {
      throw new AidenRemoteServiceError("invalid_request", "Speech audio must be 16 kHz mono signed 16-bit little-endian PCM.", 400);
    }
    const id = modelId(value.modelId);
    const installed = listModels().some((candidate) => candidate.id === id && candidate.installed);
    if (!installed) throw new AidenRemoteServiceError("operation_stale", "The selected speech model is not installed on the Mac.", 409, true);
    return this.transcriptionLane.run(async () => {
      // A queued request may wait while model management runs. Revalidate at
      // execution time so deletion cannot leave an admitted request pointing at
      // files that no longer exist. No await occurs between this fence and the
      // synchronous recognizer call below.
      const stillInstalled = listModels().some((candidate) => candidate.id === id && candidate.installed);
      if (!stillInstalled) {
        throw new AidenRemoteServiceError(
          "operation_stale",
          "The selected speech model is no longer installed on the Mac.",
          409,
          true,
        );
      }
      // Validate the bounded wire payload without allocating its decoded sample
      // buffer in Electron main. PCM16 conversion and inference stay isolated
      // inside the utility process.
      const pcmBase64 = validateAidenRemotePcm16Base64(value.pcmBase64);
      return completeAidenRemoteSpeechTranscription(pcmBase64, id, {
        transcribe: transcribePcm16Base64,
        recordUsage: (usage) => usageStore.record(usage),
      });
    });
  }
}
