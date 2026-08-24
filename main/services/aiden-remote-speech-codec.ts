import { AidenRemoteServiceError } from "./aiden-remote-errors.js";

export const AIDEN_REMOTE_MAX_SPEECH_SECONDS = 60;
export const AIDEN_REMOTE_SPEECH_SAMPLE_RATE = 16_000;
export const AIDEN_REMOTE_MAX_PCM16_BYTES =
  AIDEN_REMOTE_MAX_SPEECH_SECONDS * AIDEN_REMOTE_SPEECH_SAMPLE_RATE * 2;
export const AIDEN_REMOTE_MAX_PCM16_BASE64_LENGTH =
  Math.ceil(AIDEN_REMOTE_MAX_PCM16_BYTES / 3) * 4;
// A canonical 60-second request currently uses 95 bytes beyond pcmBase64.
// Keep a small, fixed allowance for the closed JSON envelope without widening
// the audio cap, and derive it from the same PCM limit so the layers cannot
// silently drift apart again.
const AIDEN_REMOTE_SPEECH_JSON_ENVELOPE_ALLOWANCE = 1_024;
export const AIDEN_REMOTE_MAX_SPEECH_REQUEST_BYTES =
  AIDEN_REMOTE_MAX_PCM16_BASE64_LENGTH + AIDEN_REMOTE_SPEECH_JSON_ENVELOPE_ALLOWANCE;

export function decodeAidenRemotePcm16(value: unknown): Float32Array {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > AIDEN_REMOTE_MAX_PCM16_BASE64_LENGTH
  ) {
    throw new AidenRemoteServiceError("payload_too_large", "The speech recording is empty or too large.", 413);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new AidenRemoteServiceError("invalid_request", "The speech recording must be valid base64 PCM.", 400);
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0
    || bytes.length > AIDEN_REMOTE_MAX_PCM16_BYTES
    || bytes.length % 2 !== 0
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The speech recording must be 16-bit mono PCM no longer than 60 seconds.", 400);
  }
  const samples = new Float32Array(bytes.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = bytes.readInt16LE(index * 2) / 32_768;
  }
  return samples;
}
