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
  /** Per-stream 48 kHz granule; counts pre-skip. Negative or absent when unknown. */
  absoluteGranulePosition?: bigint | number;
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

export const OGG_OPUS_TOO_LONG_MESSAGE = "This voice note is too long for on-device transcription.";

/** Thrown when a note decodes past the caller's sample cap. */
export class OggOpusTooLongError extends Error {
  override name = "OggOpusTooLongError";

  constructor() {
    super(OGG_OPUS_TOO_LONG_MESSAGE);
  }
}

export interface DecodeOggOpusOptions {
  /** Largest accepted note, in 16 kHz samples after end trimming. Required to stop early. */
  maxSamples?: number;
}

/** Frames handed to the decoder per call; keeps each decoded batch small. */
const DECODE_BATCH_FRAMES = 256;
/**
 * Slack above the cap for untrimmed decoded audio. The final granule can trim up
 * to one maximum-length Opus packet (120 ms) of end padding; the exact cap is
 * enforced on the trimmed total before returning.
 */
const RUNNING_SLACK_SAMPLES = (OUTPUT_RATE * 120) / 1000;

interface LogicalStream {
  header: OpusStreamHeader;
  pages: OggPageLike[];
  /** Granule of the page that ends the stream; undefined when the file does not declare one. */
  endGranule?: bigint | number;
}

/** Stream length at 16 kHz implied by the final granule, or undefined when unknown. */
function declaredSamples(stream: LogicalStream): number | undefined {
  if (stream.endGranule === undefined) return undefined;
  const granule = Number(stream.endGranule);
  if (!Number.isFinite(granule) || granule < stream.header.preSkip) return undefined;
  return Math.round(((granule - stream.header.preSkip) * OUTPUT_RATE) / OPUS_GRANULE_RATE);
}

function splitLogicalStreams(pages: readonly OggPageLike[]): LogicalStream[] {
  const streams: LogicalStream[] = [];
  let current: LogicalStream | null = null;
  for (const page of pages) {
    const frames = page.codecFrames ?? [];
    if (!current && frames.length > 0) {
      // A chained file starts a new logical stream with its own header.
      current = { header: frames[0]!.header, pages: [] };
      streams.push(current);
    }
    if (!current) continue;
    current.pages.push(page);
    if (page.isLastPage) {
      current.endGranule = page.absoluteGranulePosition;
      current = null;
    }
  }
  return streams;
}

/** Drops `count` samples from the end of a stream's chunks, across chunk boundaries. */
function trimTail(chunks: Float32Array[], count: number): void {
  let remaining = count;
  while (remaining > 0 && chunks.length > 0) {
    const last = chunks[chunks.length - 1]!;
    if (last.length <= remaining) {
      remaining -= last.length;
      chunks.pop();
    } else {
      chunks[chunks.length - 1] = last.subarray(0, last.length - remaining);
      remaining = 0;
    }
  }
}

export async function decodeOggOpusToPcm16k(bytes: Uint8Array, options: DecodeOggOpusOptions = {}): Promise<Float32Array> {
  const maxSamples = options.maxSamples ?? Number.POSITIVE_INFINITY;
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

  const streams = splitLogicalStreams(pages);
  // Reject from the container's declared lengths before any PCM is allocated.
  let declaredTotal = 0;
  for (const stream of streams) declaredTotal += declaredSamples(stream) ?? 0;
  if (declaredTotal > maxSamples) throw new OggOpusTooLongError();

  const output: Float32Array[] = [];
  // Untrimmed decoded samples currently held, across finished and in-flight streams.
  let retained = 0;
  for (const stream of streams) {
    const decoder: OpusDecoderInstance<typeof OUTPUT_RATE> = new OpusDecoder({
      sampleRate: OUTPUT_RATE,
      channels: stream.header.channels,
      streamCount: stream.header.streamCount,
      coupledStreamCount: stream.header.coupledStreamCount,
      channelMappingTable: stream.header.channelMappingTable,
      preSkip: Math.round((stream.header.preSkip / OPUS_GRANULE_RATE) * OUTPUT_RATE),
    });
    try {
      await decoder.ready;
      const chunks: Float32Array[] = [];
      let streamDecoded = 0;
      let batch: Uint8Array[] = [];
      const decodeBatch = () => {
        if (batch.length === 0) return;
        const decoded = decoder.decodeFrames(batch);
        batch = [];
        const length = decoded.samplesDecoded;
        if (retained + length > maxSamples + RUNNING_SLACK_SAMPLES) throw new OggOpusTooLongError();
        retained += length;
        streamDecoded += length;
        if (length > 0) chunks.push(downmix(decoded.channelData, length));
      };
      for (const page of stream.pages) {
        for (const frame of page.codecFrames ?? []) {
          batch.push(frame.data);
          if (batch.length >= DECODE_BATCH_FRAMES) decodeBatch();
        }
      }
      decodeBatch();
      const declared = declaredSamples(stream);
      if (declared !== undefined && streamDecoded > declared) {
        // Ogg Opus: the final granule minus pre-skip is the stream's true length at
        // 48 kHz. The decoder already dropped pre-skip; drop the end padding.
        const excess = streamDecoded - declared;
        trimTail(chunks, excess);
        retained -= excess;
      }
      output.push(...chunks);
    } finally {
      decoder.free();
    }
  }
  if (output.length === 0) throw new Error(INVALID);
  const joined = concat(output);
  if (joined.length > maxSamples) throw new OggOpusTooLongError();
  return joined;
}
