// Pure codec/validation helpers for the local-voice IPC handlers, extracted so
// they can be unit-tested without importing Electron. See handlers/local-voice.ts.

export function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

/** Base64 of a raw little-endian Float32 PCM buffer → Float32Array. */
export function pcmToFloat32(base64: string): Float32Array {
  const buf = Buffer.from(base64, "base64");
  const out = new Float32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
