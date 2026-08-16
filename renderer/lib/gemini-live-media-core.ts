export const GEMINI_LIVE_PCM_WORKLET_NAME = "aiden-gemini-live-pcm";
export const GEMINI_LIVE_PCM_WORKLET_PATH = "./gemini-live-pcm-worklet.js";
export const GEMINI_LIVE_WORKLET_SAMPLE_RATE = 16_000;
export const GEMINI_LIVE_WORKLET_CHUNK_MS = 20;
export const GEMINI_LIVE_PLAYBACK_SAMPLE_RATE = 24_000;
export const GEMINI_LIVE_MAX_PLAYBACK_BYTES = GEMINI_LIVE_PLAYBACK_SAMPLE_RATE * 2 * 2;

const TARGET_SAMPLES_PER_CHUNK =
  (GEMINI_LIVE_WORKLET_SAMPLE_RATE * GEMINI_LIVE_WORKLET_CHUNK_MS) / 1_000;

/** Local-only normalized RMS used to render truthful microphone activity. */
export function measureGeminiLivePcmLevel(pcm: Uint8Array): number {
  if (!(pcm instanceof Uint8Array) || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0)
    return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let squareSum = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true) / 32_768;
    squareSum += sample * sample;
  }
  const rms = Math.sqrt(squareSum / (pcm.byteLength / 2));
  return Math.min(1, rms * 4);
}

export interface DisplayMediaTrack {
  readonly readyState?: string;
  addEventListener(type: "ended", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "ended", listener: () => void): void;
  stop(): void;
}

export interface DisplayMediaStream {
  getTracks(): DisplayMediaTrack[];
}

export type DisplayCaptureStopReason = "aborted" | "ended" | "stopped";

export function resolveGeminiLivePcmWorkletUrl(baseUrl: string): string {
  return new URL(GEMINI_LIVE_PCM_WORKLET_PATH, baseUrl).href;
}

export async function loadGeminiLivePcmWorklet(
  audioContext: Pick<BaseAudioContext, "audioWorklet">,
  baseUrl: string,
): Promise<void> {
  await audioContext.audioWorklet.addModule(resolveGeminiLivePcmWorkletUrl(baseUrl));
}

/** Stops every display track exactly once on explicit stop, abort, or track end. */
export function bindDisplayCaptureLifecycle(
  stream: DisplayMediaStream,
  options: {
    signal?: AbortSignal;
    onStopped: (reason: DisplayCaptureStopReason) => void;
  },
): (reason?: Exclude<DisplayCaptureStopReason, "aborted" | "ended">) => void {
  const tracks = stream.getTracks();
  let active = true;
  const finish = (reason: DisplayCaptureStopReason): void => {
    if (!active) return;
    active = false;
    options.signal?.removeEventListener("abort", onAbort);
    for (const track of tracks) track.removeEventListener("ended", onEnded);
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        // Teardown continues for the remaining tracks.
      }
    }
    options.onStopped(reason);
  };
  const onAbort = () => finish("aborted");
  const onEnded = () => finish("ended");

  for (const track of tracks) track.addEventListener("ended", onEnded, { once: true });
  if (options.signal?.aborted) finish("aborted");
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  if (tracks.some((track) => track.readyState === "ended")) finish("ended");

  return (reason = "stopped") => finish(reason);
}

function pcm16le(samples: readonly number[]): Uint8Array {
  const output = new Uint8Array(samples.length * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const integer = sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767);
    view.setInt16(index * 2, integer, true);
  }
  return output;
}

function resampleChunk(samples: readonly number[], targetLength: number): number[] {
  if (samples.length === targetLength) return Array.from(samples);
  const result = new Array<number>(targetLength);
  const ratio = samples.length / targetLength;
  for (let target = 0; target < targetLength; target += 1) {
    const start = target * ratio;
    const end = (target + 1) * ratio;
    const first = Math.floor(start);
    const last = Math.min(samples.length - 1, Math.ceil(end) - 1);
    let sum = 0;
    let weight = 0;
    for (let source = first; source <= last; source += 1) {
      const overlap = Math.max(0, Math.min(end, source + 1) - Math.max(start, source));
      sum += (samples[source] ?? 0) * overlap;
      weight += overlap;
    }
    result[target] = weight > 0 ? sum / weight : 0;
  }
  return result;
}

/** Pure counterpart of the packaged AudioWorklet's bounded 20 ms chunker. */
export class GeminiLivePcmChunker {
  private readonly sourceSamplesPerChunk: number;
  private pending: number[] = [];

  constructor(readonly sourceSampleRate: number) {
    if (!Number.isFinite(sourceSampleRate) || sourceSampleRate < GEMINI_LIVE_WORKLET_SAMPLE_RATE) {
      throw new Error("Live microphone sample rate is unsupported.");
    }
    this.sourceSamplesPerChunk = Math.round(
      (sourceSampleRate * GEMINI_LIVE_WORKLET_CHUNK_MS) / 1_000,
    );
  }

  push(samples: Float32Array): Uint8Array[] {
    if (!(samples instanceof Float32Array)) throw new Error("Live microphone input is invalid.");
    for (const sample of samples) this.pending.push(Number.isFinite(sample) ? sample : 0);
    const chunks: Uint8Array[] = [];
    while (this.pending.length >= this.sourceSamplesPerChunk) {
      const source = this.pending.slice(0, this.sourceSamplesPerChunk);
      this.pending = this.pending.slice(this.sourceSamplesPerChunk);
      chunks.push(pcm16le(resampleChunk(source, TARGET_SAMPLES_PER_CHUNK)));
    }
    return chunks;
  }

  reset(): void {
    this.pending = [];
  }
}
/** Bounded raw 24 kHz PCM queue; interruption discards every buffered byte. */
export class GeminiLivePcmPlaybackQueue {
  private chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(readonly maxBytes = GEMINI_LIVE_MAX_PLAYBACK_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes % 2 !== 0) {
      throw new Error("Live playback queue limit is invalid.");
    }
  }

  get queuedBytes(): number {
    return this.bytes;
  }

  get queuedChunks(): number {
    return this.chunks.length;
  }

  enqueue(pcm: Uint8Array): number {
    if (!(pcm instanceof Uint8Array) || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
      throw new Error("Live playback requires signed 16-bit PCM.");
    }
    if (pcm.byteLength > this.maxBytes) throw new Error("Live playback chunk exceeds its limit.");
    let dropped = 0;
    while (this.bytes + pcm.byteLength > this.maxBytes) {
      const oldest = this.chunks.shift();
      if (!oldest) break;
      this.bytes -= oldest.byteLength;
      dropped += 1;
    }
    const copy = Uint8Array.from(pcm);
    this.chunks.push(copy);
    this.bytes += copy.byteLength;
    return dropped;
  }

  dequeue(): Uint8Array | undefined {
    const chunk = this.chunks.shift();
    if (chunk) this.bytes -= chunk.byteLength;
    return chunk;
  }

  flush(): number {
    const discarded = this.chunks.length;
    this.chunks = [];
    this.bytes = 0;
    return discarded;
  }
}
