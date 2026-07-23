// Voice transcription via OpenAI (Whisper / gpt-4o-transcribe) or Google Gemini.
// Reuses the API keys already configured for those providers.

import { configStore } from "./config-store.js";
import { secrets } from "./secrets.js";
import {
  geminiTranscriptionTokens,
  isLocalModelProvider,
  openAITranscriptionTokens,
  unreportedUsageRecord,
} from "./usage-accounting.js";
import { usageStore } from "./usage-store.js";
import type { StoredProvider, UsageTokenBreakdown } from "./types.js";

interface TranscribeInput {
  audioBase64: string;
  mimeType: string;
  signal?: AbortSignal;
}

async function recordTranscription(input: {
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
  const key = await secrets.getKey("openai");
  if (!key) throw new Error("Add an OpenAI API key (Settings → Providers) to use voice input.");
  const provider = await configStore.getProvider("openai");
  if (!provider) throw new Error("OpenAI provider settings are unavailable.");
  const baseUrl = (provider?.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const settings = await configStore.getSettings();
  const model = settings.voiceModel || "whisper-1";

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
  const key = await secrets.getKey("gemini");
  if (!key)
    throw new Error("Add a Google Gemini API key (Settings → Providers) to use voice input.");
  const settings = await configStore.getSettings();
  const model = settings.voiceModel || "gemini-2.0-flash";
  const provider = await configStore.getProvider("gemini");
  if (!provider) throw new Error("Google Gemini provider settings are unavailable.");

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: "Transcribe the following audio verbatim. Output only the transcript text, nothing else.",
                },
                {
                  inline_data: {
                    mime_type: input.mimeType || "audio/webm",
                    data: input.audioBase64,
                  },
                },
              ],
            },
          ],
        }),
        signal: input.signal,
      },
    );
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
        ? (decoded as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
            usageMetadata?: unknown;
          })
        : {};
    const parts = data.candidates?.[0]?.content?.parts;
    const text = (Array.isArray(parts) ? parts : [])
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    await recordTranscription({
      provider,
      model,
      status: "completed",
      tokens: geminiTranscriptionTokens(data.usageMetadata),
    });
    return text;
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
