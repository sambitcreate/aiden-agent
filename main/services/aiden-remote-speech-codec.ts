import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { crc32, inflateRaw } from "node:zlib";

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

/** Decode exactly one gzip member without allowing extra bytes or a second member. */
export async function decodeAidenRemoteSpeechGzip(input: Buffer): Promise<Buffer> {
  const invalid = () => new AidenRemoteServiceError(
    "invalid_request", "The speech request body must be a valid single-member gzip stream.", 400,
  );
  if (input.length < 18 || input[0] !== 0x1f || input[1] !== 0x8b || input[2] !== 8) throw invalid();
  const flags = input[3]!;
  if ((flags & 0xe0) !== 0) throw invalid();
  let offset = 10;
  if (flags & 0x04) {
    if (offset + 2 > input.length - 8) throw invalid();
    const extraLength = input.readUInt16LE(offset);
    offset += 2 + extraLength;
    if (offset > input.length - 8) throw invalid();
  }
  for (const flag of [0x08, 0x10]) {
    if (!(flags & flag)) continue;
    const terminator = input.indexOf(0, offset);
    if (terminator < 0 || terminator >= input.length - 8) throw invalid();
    offset = terminator + 1;
  }
  if (flags & 0x02) {
    if (offset + 2 > input.length - 8 || input.readUInt16LE(offset) !== (crc32(input.subarray(0, offset)) & 0xffff)) {
      throw invalid();
    }
    offset += 2;
  }
  if (offset >= input.length - 8) throw invalid();

  const decoded = await new Promise<{ buffer: Buffer; consumed: number }>((resolve, reject) => {
    inflateRaw(input.subarray(offset), {
      info: true,
      maxOutputLength: AIDEN_REMOTE_MAX_SPEECH_REQUEST_BYTES,
    }, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      // Node's zlib types model the legacy Buffer callback even with info:true.
      const info = result as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      resolve({ buffer: info.buffer, consumed: info.engine.bytesWritten });
    });
  }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
      throw new AidenRemoteServiceError("payload_too_large", "The speech request body is too large.", 413);
    }
    throw invalid();
  });
  const trailer = offset + decoded.consumed;
  if (trailer + 8 !== input.length) throw invalid();
  if (input.readUInt32LE(trailer) !== crc32(decoded.buffer) || input.readUInt32LE(trailer + 4) !== decoded.buffer.length) {
    throw invalid();
  }
  return decoded.buffer;
}

export function validateAidenRemotePcm16Base64(value: unknown): string {
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
  const bytesLength = Buffer.byteLength(value, "base64");
  if (
    bytesLength === 0
    || bytesLength > AIDEN_REMOTE_MAX_PCM16_BYTES
    || bytesLength % 2 !== 0
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The speech recording must be 16-bit mono PCM no longer than 60 seconds.", 400);
  }
  return value;
}

export function decodeAidenRemotePcm16ToInt16(value: unknown): Int16Array {
  const encoded = validateAidenRemotePcm16Base64(value);
  const bytes = Buffer.from(encoded, "base64");
  const samples = new Int16Array(bytes.length / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2);
  return samples;
}
