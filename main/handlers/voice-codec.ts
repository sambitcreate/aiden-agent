// Pure codec/validation helpers for the local-voice IPC handlers, extracted so
// they can be unit-tested without importing Electron. See handlers/local-voice.ts.

import { MAX_PCM_SAMPLES } from "../services/local-speech-protocol.js";

export function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

/**
 * Renderer PCM16 audio for `voice:transcribeLocal`: an ArrayBuffer (or a
 * Uint8Array, if a hop re-wraps it) of native-endian Int16 samples. Always
 * returns a fresh, aligned Int16Array.
 */
export function pcm16FromIpc(value: unknown, maxSamples: number = MAX_PCM_SAMPLES): Int16Array {
  const bytes =
    value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : null;
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    throw new Error("Invalid on-device audio.");
  }
  if (bytes.byteLength > maxSamples * 2) {
    throw new Error("The recording is too long for on-device transcription.");
  }
  const samples = new Int16Array(bytes.byteLength / 2);
  new Uint8Array(samples.buffer).set(bytes);
  return samples;
}
