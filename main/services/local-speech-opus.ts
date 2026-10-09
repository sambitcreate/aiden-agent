// Ogg/Opus → 16 kHz mono float samples for the on-device recognizer (Telegram
// voice notes). codec-parser demuxes the Ogg pages and opus-decoder (libopus
// WASM) decodes straight to 16 kHz, one of Opus's native output rates, so no
// separate resampler is needed. Runs inside the speech worker.

import type { OpusDecoder as OpusDecoderInstance } from "opus-decoder";
import { MAX_PCM_SAMPLES } from "./local-speech-protocol.js";

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
  /** Largest accepted note, in 16 kHz samples after end trimming. Defaults to the 30-minute cap. */
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
const OGG_CAPTURE_PATTERN = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const OPUS_HEAD_PATTERN = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"
const OGG_HEADER_BYTES = 27;
const OGG_END_OF_STREAM = 0x04;

/** 16 kHz samples a stream keeps when its final granule is `granule` (pre-skip removed). */
function trimmedLength(granule: number, preSkip: number): number {
  return Math.round(((granule - preSkip) * OUTPUT_RATE) / OPUS_GRANULE_RATE);
}

/**
 * The declared length of the file, read from Ogg page headers alone. No packets
 * are touched, so a note that declares an over-long stream is refused without
 * any decoding. It is only a fast path: the streaming decoder enforces the cap
 * whatever the headers say.
 */
function declaredSamplesFromHeaders(bytes: Uint8Array): number {
  let total = 0;
  let preSkip: number | null = null;
  let offset = 0;
  const matches = (at: number, pattern: readonly number[]) => pattern.every((byte, index) => bytes[at + index] === byte);
  while (offset + OGG_HEADER_BYTES <= bytes.length && matches(offset, OGG_CAPTURE_PATTERN)) {
    const segmentCount = bytes[offset + 26]!;
    const bodyStart = offset + OGG_HEADER_BYTES + segmentCount;
    if (bodyStart > bytes.length) break;
    let bodyLength = 0;
    for (let index = 0; index < segmentCount; index += 1) bodyLength += bytes[offset + OGG_HEADER_BYTES + index]!;
    const bodyEnd = bodyStart + bodyLength;
    if (bodyEnd > bytes.length) break;
    if (preSkip === null && bodyLength >= 12 && matches(bodyStart, OPUS_HEAD_PATTERN)) {
      preSkip = bytes[bodyStart + 10]! | (bytes[bodyStart + 11]! << 8);
    }
    if ((bytes[offset + 5]! & OGG_END_OF_STREAM) !== 0) {
      const granule = Number(new DataView(bytes.buffer, bytes.byteOffset + offset + 6, 8).getBigInt64(0, true));
      if (preSkip !== null && granule >= preSkip) total += trimmedLength(granule, preSkip);
      preSkip = null;
    }
    offset = bodyEnd;
  }
  return total;
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

/** Lets timers and the parent's port messages run between decode batches. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

interface OpenStream {
  decoder: OpusDecoderInstance<typeof OUTPUT_RATE>;
  preSkip: number;
  /** Frames waiting for the next decodeFrames call. */
  batch: Uint8Array[];
  chunks: Float32Array[];
  /** Untrimmed samples this stream has decoded so far. */
  decoded: number;
}

/**
 * Decodes an Ogg/Opus file to 16 kHz mono. Pages are read as they are parsed and
 * their packets go straight into bounded decode batches, so the parser never
 * holds the whole file's frames. The running total of decoded samples is checked
 * before each batch is kept, and the trimmed total is checked against the cap
 * before returning.
 */
export async function decodeOggOpusToPcm16k(bytes: Uint8Array, options: DecodeOggOpusOptions = {}): Promise<Float32Array> {
  const maxSamples = options.maxSamples ?? MAX_PCM_SAMPLES;
  // Loaded on first use so the main bundle does not pay for libopus at startup.
  const [{ default: CodecParser }, { OpusDecoder }] = await Promise.all([
    import("codec-parser"),
    import("opus-decoder"),
  ]);
  let codec: string | undefined;
  let pages: Iterator<OggPageLike>;
  try {
    const parser = new CodecParser("audio/ogg", {
      onCodec: (value) => {
        codec = value;
      },
      enableFrameCRC32: false,
    });
    pages = (function* () {
      yield* parser.parseChunk(bytes) as unknown as Iterable<OggPageLike>;
      yield* parser.flush() as unknown as Iterable<OggPageLike>;
    })();
  } catch {
    throw new Error(INVALID);
  }

  const declared = declaredSamplesFromHeaders(bytes);
  if (declared > maxSamples) throw new OggOpusTooLongError();

  const output: Float32Array[] = [];
  // Untrimmed decoded samples held across finished and in-flight streams.
  let retained = 0;
  let open: OpenStream | null = null;

  const openStream = async (header: OpusStreamHeader): Promise<OpenStream> => {
    const decoder: OpusDecoderInstance<typeof OUTPUT_RATE> = new OpusDecoder({
      sampleRate: OUTPUT_RATE,
      channels: header.channels,
      streamCount: header.streamCount,
      coupledStreamCount: header.coupledStreamCount,
      channelMappingTable: header.channelMappingTable,
      preSkip: Math.round((header.preSkip / OPUS_GRANULE_RATE) * OUTPUT_RATE),
    });
    try {
      await decoder.ready;
    } catch (error) {
      decoder.free();
      throw error;
    }
    return { decoder, preSkip: header.preSkip, batch: [], chunks: [], decoded: 0 };
  };

  const decodeBatch = (stream: OpenStream): void => {
    if (stream.batch.length === 0) return;
    const decoded = stream.decoder.decodeFrames(stream.batch);
    stream.batch = [];
    const length = decoded.samplesDecoded;
    if (retained + length > maxSamples + RUNNING_SLACK_SAMPLES) throw new OggOpusTooLongError();
    retained += length;
    stream.decoded += length;
    if (length > 0) stream.chunks.push(downmix(decoded.channelData, length));
  };

  const closeStream = (stream: OpenStream, granule: bigint | number | undefined): void => {
    try {
      decodeBatch(stream);
      if (granule !== undefined && Number(granule) >= stream.preSkip) {
        // Ogg Opus: the final granule minus pre-skip is the stream's true length at
        // 48 kHz. The decoder already dropped pre-skip; drop the end padding.
        const excess = stream.decoded - trimmedLength(Number(granule), stream.preSkip);
        if (excess > 0) {
          trimTail(stream.chunks, excess);
          retained -= excess;
        }
      }
      output.push(...stream.chunks);
    } finally {
      stream.decoder.free();
    }
  };

  try {
    for (;;) {
      let step: IteratorResult<OggPageLike>;
      try {
        step = pages.next();
      } catch {
        throw new Error(INVALID);
      }
      if (step.done) break;
      const page = step.value;
      // A chained file starts a new logical stream with its own header; a non-Opus file is refused at its first page.
      if (codec !== undefined && codec !== "opus") throw new Error(INVALID);
      const frames = page.codecFrames ?? [];
      if (open === null && frames.length > 0) open = await openStream(frames[0]!.header);
      if (open === null) continue;
      for (const frame of frames) {
        open.batch.push(frame.data);
        if (open.batch.length >= DECODE_BATCH_FRAMES) {
          decodeBatch(open);
          await yieldToEventLoop();
        }
      }
      if (page.isLastPage) {
        const finished = open;
        open = null;
        closeStream(finished, page.absoluteGranulePosition);
      }
    }
    if (open !== null) {
      const finished = open;
      open = null;
      closeStream(finished, undefined);
    }
  } finally {
    open?.decoder.free();
  }
  if (output.length === 0) throw new Error(INVALID);
  const joined = concat(output);
  if (joined.length > maxSamples) throw new OggOpusTooLongError();
  return joined;
}
