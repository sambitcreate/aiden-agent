// Voice transcription via OpenAI (Whisper / gpt-4o-transcribe) or Google Gemini.
// Reuses the API keys already configured for those providers.

import { configStore } from "./config-store.js";
import { secrets } from "./secrets.js";

interface TranscribeInput {
  audioBase64: string;
  mimeType: string;
}

async function transcribeOpenAI(input: TranscribeInput): Promise<string> {
  const key = await secrets.getKey("openai");
  if (!key) throw new Error("Add an OpenAI API key (Settings → Providers) to use voice input.");
  const provider = await configStore.getProvider("openai");
  const baseUrl = (provider?.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const settings = await configStore.getSettings();
  const model = settings.voiceModel || "whisper-1";

  const bytes = Buffer.from(input.audioBase64, "base64");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: input.mimeType || "audio/webm" }), "audio.webm");
  form.append("model", model);

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Transcription failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  const data = (await response.json()) as { text?: string };
  return (data.text ?? "").trim();
}

async function transcribeGemini(input: TranscribeInput): Promise<string> {
  const key = await secrets.getKey("gemini");
  if (!key) throw new Error("Add a Google Gemini API key (Settings → Providers) to use voice input.");
  const settings = await configStore.getSettings();
  const model = settings.voiceModel || "gemini-2.0-flash";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: "Transcribe the following audio verbatim. Output only the transcript text, nothing else." },
              { inline_data: { mime_type: input.mimeType || "audio/webm", data: input.audioBase64 } },
            ],
          },
        ],
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Transcription failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text)
    .filter((t): t is string => Boolean(t))
    .join(" ");
  return text.trim();
}

export async function transcribe(input: TranscribeInput): Promise<string> {
  const settings = await configStore.getSettings();
  const provider = settings.voiceProvider ?? "openai";
  return provider === "gemini" ? transcribeGemini(input) : transcribeOpenAI(input);
}
