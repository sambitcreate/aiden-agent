// Ogg/Opus → 16 kHz mono float samples for the on-device recognizer (Telegram
// voice notes). codec-parser demuxes the Ogg pages and opus-decoder (libopus
// WASM) decodes straight to 16 kHz, one of Opus's native output rates, so no
// separate resampler is needed. Runs inside the speech worker.

import type { OpusDecoder as OpusDecoderInstance } from "opus-decoder";

const OUTPUT_RATE = 16_000;
const OPUS_GRANULE_RATE = 48_000;

const INVALID = "The audio isn't valid Ogg/Opus.";

interface OpusStreamHeader {
  channels: number;
  streamCount: number;
  coupledStreamCount: number;
  channelMappingTable: number[];
  preSkip: number;
}

interface OggPageLike {
  codecFrames: Array<{ data: Uint8Array; header: OpusStreamHeader }>;
  isLastPage: boolean;
  totalSamples: number;
}

function downmix(channelData: readonly Float32Array[], length: number): Float32Array {
  if (channelData.length === 1) return channelData[0]!.subarray(0, length);
  const mono = new Float32Array(length);
  for (const channel of channelData) {
    for (let index = 0; index < length; index += 1) mono[index]! += channel[index]!;
  }
  const scale = 1 / channelData.length;
  for (let index = 0; index < length; index += 1) mono[index]! *= scale;
  return mono;
}

function concat(parts: readonly Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

export async function decodeOggOpusToPcm16k(bytes: Uint8Array): Promise<Float32Array> {
  // Loaded on first use so the main bundle does not pay for libopus at startup.
  const [{ default: CodecParser }, { OpusDecoder }] = await Promise.all([
    import("codec-parser"),
    import("opus-decoder"),
  ]);
  let codec: string | undefined;
  let pages: OggPageLike[];
  try {
    const parser = new CodecParser("audio/ogg", {
      onCodec: (value) => {
        codec = value;
      },
      enableFrameCRC32: false,
    });
    pages = parser.parseAll(bytes) as unknown as OggPageLike[];
  } catch {
    throw new Error(INVALID);
  }
  if (codec !== undefined && codec !== "opus") throw new Error(INVALID);

  const output: Float32Array[] = [];
  let decoder: OpusDecoderInstance<typeof OUTPUT_RATE> | null = null;
  let streamFrames: Uint8Array[] = [];
  let streamDecoded = 0;
  const flush = (lastPage?: OggPageLike) => {
    if (!decoder || streamFrames.length === 0) return;
    const decoded = decoder.decodeFrames(streamFrames);
    streamFrames = [];
    let length = decoded.samplesDecoded;
    streamDecoded += length;
    if (lastPage) {
      // The final granule position marks the true end; drop Opus padding past it.
      const excess = Math.round(
        ((streamDecoded / OUTPUT_RATE) * OPUS_GRANULE_RATE - lastPage.totalSamples) *
          (OUTPUT_RATE / OPUS_GRANULE_RATE),
      );
      if (excess > 0) length = Math.max(0, length - excess);
    }
    if (length > 0) output.push(downmix(decoded.channelData, length));
  };

  try {
    for (const page of pages) {
      const frames = page.codecFrames ?? [];
      if (frames.length > 0 && !decoder) {
        const header = frames[0]!.header;
        decoder = new OpusDecoder({
          sampleRate: OUTPUT_RATE,
          channels: header.channels,
          streamCount: header.streamCount,
          coupledStreamCount: header.coupledStreamCount,
          channelMappingTable: header.channelMappingTable,
          preSkip: Math.round((header.preSkip / OPUS_GRANULE_RATE) * OUTPUT_RATE),
        });
        await decoder.ready;
        streamDecoded = 0;
      }
      for (const frame of frames) streamFrames.push(frame.data);
      if (page.isLastPage) {
        flush(page);
        // A chained file starts a new logical stream with its own header.
        decoder?.free();
        decoder = null;
      }
    }
    flush();
  } finally {
    decoder?.free();
  }
  if (output.length === 0) throw new Error(INVALID);
  return concat(output);
}
