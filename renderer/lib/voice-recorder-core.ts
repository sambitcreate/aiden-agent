// Shared microphone-capture → transcription helpers, consumed by both the
// composer mic button (use-voice-recorder) and the global dictation pill.
// Recording runs through MediaRecorder; the recorded blob is either sent to a
// cloud provider, or (for the on-device provider) decoded and resampled to
// 16 kHz mono PCM in the renderer and transcribed locally via sherpa-onnx.

import { voiceApi } from "./ipc";
import type { VoiceProvider } from "./types";

export interface TranscribeOptions {
  provider: VoiceProvider;
  /** Selected on-device model id — required when provider === "local". */
  localModel?: string;
}

export const MICROPHONE_PERMISSION_OFF_MESSAGE =
  "Microphone access is off. Enable it in System Settings → Privacy & Security → Microphone, then restart Aiden.";

export function microphoneCaptureErrorMessage(error: unknown): string {
  let name = "";
  try {
    const candidate =
      typeof error === "object" && error !== null
        ? (error as { name?: unknown }).name
        : undefined;
    if (typeof candidate === "string") name = candidate;
  } catch {
    // A hostile or cross-realm error object must not break recovery messaging.
  }
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return MICROPHONE_PERMISSION_OFF_MESSAGE;
    case "NotFoundError":
      return "No microphone was found. Connect or enable an input device, then try again.";
    case "NotReadableError":
      return "Aiden could not read from the microphone. Close other apps using it, check the selected input device, and try again.";
    case "AbortError":
      return "Microphone capture was interrupted. Try again.";
    default:
      return "Aiden could not start microphone capture. Check the input device and microphone permission, then try again.";
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function float32ToBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decode recorded audio and resample to 16 kHz mono Float32 PCM (base64) for the on-device engine. */
async function blobToPcm16k(blob: Blob): Promise<string> {
  const arrayBuf = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuf);
  } finally {
    void decodeCtx.close();
  }
  const targetRate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  // Copy into a standalone Float32Array so the base64 covers exactly the samples.
  return float32ToBase64(Float32Array.from(rendered.getChannelData(0)));
}

/** Native mic-permission gate; resolves true when capture may start. */
export async function ensureMicrophoneAccess(): Promise<boolean> {
  const status =
    await window.aidenAPI.systemPreferences.getMediaAccessStatus("microphone");
  if (status === "denied" || status === "restricted") return false;
  if (status === "not-determined") {
    return window.aidenAPI.systemPreferences.askForMediaAccess("microphone");
  }
  return true;
}

/**
 * Transcribe a recorded blob through the selected provider.
 * Resolves the trimmed transcript ("" when no speech was detected).
 */
export async function transcribeBlob(
  blob: Blob,
  options: TranscribeOptions,
): Promise<string> {
  if (options.provider === "local") {
    if (!options.localModel) {
      throw new Error(
        "Download and select an on-device model in Settings → Voice.",
      );
    }
    const pcm = await blobToPcm16k(blob);
    return (await voiceApi.transcribeLocal(pcm, options.localModel)).trim();
  }
  const base64 = await blobToBase64(blob);
  return (await voiceApi.transcribe(base64, blob.type)).trim();
}
