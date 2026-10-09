import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeOggOpusToPcm16k } from "./local-speech-opus.js";

// 1 s of a 440 Hz sine (ffmpeg default amplitude 1/8) on the left channel of a
// 48 kHz stereo Ogg/Opus file; the right channel is silent.
const fixture = new URL("./fixtures/voice-note-440hz-left.ogg", import.meta.url);

function rms(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += samples[index]! ** 2;
  return Math.sqrt(sum / (to - from));
}

function zeroCrossings(samples: Float32Array, from: number, to: number): number {
  let count = 0;
  for (let index = from + 1; index < to; index += 1) {
    if (samples[index - 1]! < 0 !== samples[index]! < 0) count += 1;
  }
  return count;
}

test("Ogg/Opus decodes to 16 kHz mono with channels averaged", async () => {
  const samples = await decodeOggOpusToPcm16k(new Uint8Array(await readFile(fixture)));
  // Exactly one second: the decoder drops pre-skip and the final granule trims padding.
  assert.equal(samples.length, 16_000);
  // Steady-state window away from codec warm-up at the edges.
  const from = 2_000;
  const to = 14_000;
  const seconds = (to - from) / 16_000;
  const frequency = zeroCrossings(samples, from, to) / 2 / seconds;
  assert.ok(Math.abs(frequency - 440) < 10, `frequency ${frequency}`);
  // A full-scale-1/8 sine has RMS ≈ 0.088; averaging with a silent channel halves it.
  const level = rms(samples, from, to);
  assert.ok(level > 0.035 && level < 0.055, `rms ${level}`);
});

test("a chained file decodes each stream to its exact length", async () => {
  const first = new Uint8Array(await readFile(fixture));
  // 0.5 s of 880 Hz, mono, its own stream serial.
  const second = new Uint8Array(await readFile(new URL("./fixtures/voice-note-880hz-half-second.ogg", import.meta.url)));
  const chained = new Uint8Array(first.length + second.length);
  chained.set(first);
  chained.set(second, first.length);
  const samples = await decodeOggOpusToPcm16k(chained);
  // Pre-skip and end padding are trimmed per stream, so the lengths add up exactly.
  assert.equal(samples.length, 16_000 + 8_000);
  const secondHz = zeroCrossings(samples, 18_000, 23_000) / 2 / (5_000 / 16_000);
  assert.ok(Math.abs(secondHz - 880) < 20, `second stream frequency ${secondHz}`);
});

test("bytes that are not Ogg/Opus are rejected", async () => {
  await assert.rejects(decodeOggOpusToPcm16k(new Uint8Array(4_096).fill(7)), /Ogg\/Opus/);
});

// Builds Ogg/Opus in the test so the over-limit case does not depend on a
// checked-in multi-megabyte fixture. Every packet is a 20 ms mono CELT silence
// frame (TOC 0xF8 plus a two-byte silence payload).
const SILENCE_PACKET = new Uint8Array([0xf8, 0xff, 0xfe]);
const PACKET_48K_SAMPLES = 960;
const PRE_SKIP_48K = 312;
const PACKETS_PER_PAGE = 200;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let register = index << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      register = register & 0x80000000 ? (register << 1) ^ 0x04c11db7 : register << 1;
    }
    table[index] = register >>> 0;
  }
  return table;
})();

function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function oggPage(packets: readonly Uint8Array[], page: { serial: number; sequence: number; granule: bigint; headerType: number }): Uint8Array {
  const segments: number[] = [];
  for (const packet of packets) {
    let remaining = packet.length;
    while (remaining >= 255) {
      segments.push(255);
      remaining -= 255;
    }
    segments.push(remaining);
  }
  const headerLength = 27 + segments.length;
  const body = concatBytes(packets);
  const bytes = new Uint8Array(headerLength + body.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4f, 0x67, 0x67, 0x53], 0);
  bytes[5] = page.headerType;
  view.setBigInt64(6, page.granule, true);
  view.setUint32(14, page.serial, true);
  view.setUint32(18, page.sequence, true);
  bytes[26] = segments.length;
  bytes.set(segments, 27);
  bytes.set(body, headerLength);
  view.setUint32(22, oggCrc(bytes), true);
  return bytes;
}

function opusHead(channels: number, preSkip: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1;
  head[9] = channels;
  new DataView(head.buffer).setUint16(10, preSkip, true);
  new DataView(head.buffer).setUint32(12, 48_000, true);
  return head;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("aiden-test");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode("OpusTags"), 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  return tags;
}

/**
 * One mono Ogg/Opus logical stream of `packetCount` silence packets. With
 * `declareGranules` false every page carries granule -1 (unknown), so the
 * decoder cannot learn the length from the container.
 */
function silenceOggOpus({ packetCount, serial = 1, declareGranules = true }: { packetCount: number; serial?: number; declareGranules?: boolean }): Uint8Array {
  const pages: Uint8Array[] = [];
  pages.push(oggPage([opusHead(1, PRE_SKIP_48K)], { serial, sequence: 0, granule: 0n, headerType: 0x02 }));
  pages.push(oggPage([opusTags()], { serial, sequence: 1, granule: 0n, headerType: 0x00 }));
  let sequence = 2;
  for (let first = 0; first < packetCount; first += PACKETS_PER_PAGE) {
    const count = Math.min(PACKETS_PER_PAGE, packetCount - first);
    const last = first + count === packetCount;
    // Ogg Opus granules count every sample from the start, pre-skip included.
    const granule = declareGranules ? BigInt((first + count) * PACKET_48K_SAMPLES) : -1n;
    pages.push(
      oggPage(Array.from({ length: count }, () => SILENCE_PACKET), {
        serial,
        sequence,
        granule,
        headerType: last ? 0x04 : 0x00,
      }),
    );
    sequence += 1;
  }
  return concatBytes(pages);
}

test("a note declared past the cap is rejected before its PCM is allocated", async () => {
  // 90,001 packets is 1,800.02 s, just over the 30-minute cap. A 384 KB-class
  // compressed note of this length previously allocated the full PCM first.
  const bytes = silenceOggOpus({ packetCount: 90_001 });
  const before = process.memoryUsage().arrayBuffers;
  await assert.rejects(decodeOggOpusToPcm16k(bytes, { maxSamples: 16_000 * 60 * 30 }), /too long/);
  const growth = process.memoryUsage().arrayBuffers - before;
  // The full decoded stream would be about 115 MB of Float32 samples.
  assert.ok(growth < 64 * 1024 * 1024, `arrayBuffers grew by ${growth} bytes`);
});

test("decoding stops once the running total passes the cap, even without declared granules", async () => {
  // 1.2 s of silence with no granule positions: the container gives no length,
  // so only the running decoded total can reject it.
  const bytes = silenceOggOpus({ packetCount: 60, declareGranules: false });
  await assert.rejects(decodeOggOpusToPcm16k(bytes, { maxSamples: 16_000 / 2 }), /too long/);
});

test("the cap is inclusive: a one-second note decodes at exactly the cap and fails one sample below it", async () => {
  const bytes = new Uint8Array(await readFile(fixture));
  assert.equal((await decodeOggOpusToPcm16k(bytes, { maxSamples: 16_000 })).length, 16_000);
  await assert.rejects(decodeOggOpusToPcm16k(bytes, { maxSamples: 15_999 }), /too long/);
});

test("a short silence note declared by granule decodes to its exact length", async () => {
  const samples = await decodeOggOpusToPcm16k(silenceOggOpus({ packetCount: 50 }));
  // 50 packets are 50 * 960 granule samples; dropping the 312-sample pre-skip at 48 kHz leaves 15,896 at 16 kHz.
  assert.equal(samples.length, Math.round(((50 * 960 - 312) * 16_000) / 48_000));
});
