// Voice transcription via OpenAI (Whisper / gpt-4o-transcribe) or Google Gemini.
// Reuses the API keys already configured for those providers.

import { GOOGLE_PROVIDER_ID } from "./google-provider.js";
import { configStore } from "./config-store.js";
import { providerRegistry } from "./provider-registry.js";
import {
  geminiTranscriptionTokens,
  isLocalModelProvider,
  openAITranscriptionTokens,
  unreportedUsageRecord,
} from "./usage-accounting.js";
import { usageStore } from "./usage-store.js";
import type { StoredProvider, UsageTokenBreakdown } from "./types.js";
import { listProvidersWithLegacyPiCredentialMigration } from "./legacy-pi-credential-migration.js";
import {
  buildGeminiTranscriptionRequest,
  GEMINI_INTERACTIONS_ENDPOINT,
  parseGeminiTranscriptionResponse,
} from "./transcription-core.js";
import {
  resolveCloudVoiceModel,
  resolveGeminiBatchTranscriptionModel,
} from "../../renderer/shared/voice-models.js";

interface TranscribeInput {
  audioBase64: string;
  mimeType: string;
  model?: string;
  signal?: AbortSignal;
}

export async function recordTranscription(input: {
  provider: StoredProvider;
  model: string;
  status: "completed" | "failed";
  tokens?: UsageTokenBreakdown | null;
}): Promise<void> {
  const local = isLocalModelProvider(input.provider);
  if (input.tokens) {
    await usageStore.record({
      source: "voice-transcription",
      providerId: input.provider.id,
      providerLabel: input.provider.label,
      modelId: input.model,
      modelLabel: input.model,
      local,
      status: input.status,
      tokens: input.tokens,
      costStatus: local ? "not-applicable" : "unavailable",
    });
    return;
  }
  await usageStore.record(
    unreportedUsageRecord({
      source: "voice-transcription",
      providerId: input.provider.id,
      providerLabel: input.provider.label,
      modelId: input.model,
      local,
      status: input.status,
    }),
  );
}

async function transcribeOpenAI(input: TranscribeInput): Promise<string> {
  await listProvidersWithLegacyPiCredentialMigration();
  const auth = await providerRegistry.getBuiltinRequestAuth("openai");
  const key = auth?.auth.apiKey;
  if (!key) throw new Error("Set up OpenAI in Settings → Providers to use voice input.");
  const provider = await providerRegistry.selectionProvider("openai");
  if (!provider) throw new Error("OpenAI provider settings are unavailable.");
  const baseUrl = (auth.auth.baseUrl ?? provider.baseUrl ?? "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const settings = await configStore.getSettings();
  const model = resolveCloudVoiceModel("openai", input.model ?? settings.voiceModel);

  const bytes = Buffer.from(input.audioBase64, "base64");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: input.mimeType || "audio/webm" }), "audio.webm");
  form.append("model", model);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: input.signal,
    });
  } catch (error) {
    await recordTranscription({ provider, model, status: "failed" });
    throw error;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    await recordTranscription({ provider, model, status: "failed" });
    throw new Error(
      `Transcription failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
  }
  try {
    const decoded: unknown = await response.json();
    const data =
      decoded && typeof decoded === "object"
        ? (decoded as { text?: unknown; usage?: unknown })
        : {};
    const text = typeof data.text === "string" ? data.text.trim() : "";
    await recordTranscription({
      provider,
      model,
      status: "completed",
      tokens: openAITranscriptionTokens(data.usage),
    });
    return text;
  } catch (error) {
    await recordTranscription({ provider, model, status: "failed" });
    throw error;
  }
}

async function transcribeGemini(input: TranscribeInput): Promise<string> {
  await listProvidersWithLegacyPiCredentialMigration();
  const auth = await providerRegistry.getBuiltinRequestAuth(GOOGLE_PROVIDER_ID);
  const key = auth?.auth.apiKey;
  if (!key) throw new Error("Set up Google Gemini in Settings → Providers to use voice input.");
  const settings = await configStore.getSettings();
  const model = resolveGeminiBatchTranscriptionModel(input.model ?? settings.voiceModel);
  const provider = await providerRegistry.selectionProvider(GOOGLE_PROVIDER_ID);
  if (!provider) throw new Error("Google Gemini provider settings are unavailable.");

  let response: Response;
  try {
    response = await fetch(GEMINI_INTERACTIONS_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify(
        buildGeminiTranscriptionRequest({
          audioBase64: input.audioBase64,
          mimeType: input.mimeType,
          model,
        }),
      ),
      signal: input.signal,
    });
  } catch (error) {
    await recordTranscription({ provider, model, status: "failed" });
    throw error;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    await recordTranscription({ provider, model, status: "failed" });
    throw new Error(
      `Transcription failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
  }
  try {
    const data = parseGeminiTranscriptionResponse(await response.json());
    await recordTranscription({
      provider,
      model,
      status: "completed",
      tokens: geminiTranscriptionTokens(data.usage),
    });
    return data.text;
  } catch (error) {
    await recordTranscription({ provider, model, status: "failed" });
    throw error;
  }
}

export async function transcribe(input: TranscribeInput): Promise<string> {
  const settings = await configStore.getSettings();
  const provider = settings.voiceProvider ?? "openai";
  return provider === "gemini" ? transcribeGemini(input) : transcribeOpenAI(input);
}
