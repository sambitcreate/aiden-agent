// Pure codec/validation helpers for the local-voice IPC handlers, extracted so
// they can be unit-tested without importing Electron. See handlers/local-voice.ts.

export function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Base64 of a raw little-endian Float32 PCM buffer → Float32Array. */
export function pcmToFloat32(base64: string): Float32Array {
  const buf = Buffer.from(base64, "base64");
  const length = Math.floor(buf.length / 4);
  if (!LITTLE_ENDIAN) {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
  }
  // One bulk copy into an aligned buffer instead of a call per sample.
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + length * 4));
}
