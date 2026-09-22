import { voiceApi } from "./ipc";

export interface LiveTranscriptSnapshot {
  committed: string;
  tentative: string;
}

const TARGET_SAMPLE_RATE = 16_000;
const TARGET_CHUNK_SAMPLES = 1_600;
const MAX_PENDING_CHUNKS = 32;
const WORKLET_FLUSH_TIMEOUT_MS = 1_000;

export class OrderedPcmSendQueue {
  private tail = Promise.resolve();
  private pending = 0;
  failure: Error | undefined;

  constructor(
    private readonly send: (base64: string) => Promise<void>,
    private readonly maxPending = MAX_PENDING_CHUNKS,
  ) {}

  enqueue(bytes: Uint8Array): void {
    if (this.failure) return;
    if (this.pending >= this.maxPending) {
      this.failure = new Error(
        "Gemini Live transcription could not keep up with microphone audio.",
      );
      return;
    }
    const base64 = bytesToBase64(bytes);
    this.pending += 1;
    this.tail = this.tail
      .then(() => this.send(base64))
      .catch((error) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        this.pending -= 1;
      });
  }

  async drain(): Promise<void> {
    if (this.failure) throw this.failure;
    await this.tail;
    if (this.failure) throw this.failure;
  }
}

function pcm16Bytes(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    const value = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(index * 2, value, true);
  });
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Continuous linear resampler that emits exact 100 ms PCM16 LE chunks. */
export class Pcm16ChunkEncoder {
  private source = new Float32Array(0);
  private position = 0;
  private readonly pending: number[] = [];

  constructor(private readonly sourceRate: number) {
    if (!Number.isFinite(sourceRate) || sourceRate <= 0) {
      throw new Error("Audio sample rate must be positive.");
    }
  }

  push(samples: Float32Array): Uint8Array[] {
    if (samples.length === 0) return [];
    const combined = new Float32Array(this.source.length + samples.length);
    combined.set(this.source);
    combined.set(samples, this.source.length);
    const step = this.sourceRate / TARGET_SAMPLE_RATE;
    while (this.position + 1 < combined.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      this.pending.push(combined[left] * (1 - fraction) + combined[left + 1] * fraction);
      this.position += step;
    }
    const consumed = Math.floor(this.position);
    this.source = combined.slice(consumed);
    this.position -= consumed;
    return this.takeWholeChunks();
  }

  flush(): Uint8Array[] {
    if (this.source.length > 0) this.pending.push(this.source[0]);
    this.source = new Float32Array(0);
    this.position = 0;
    const chunks = this.takeWholeChunks();
    if (this.pending.length > 0) chunks.push(pcm16Bytes(this.pending.splice(0)));
    return chunks;
  }

  private takeWholeChunks(): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    while (this.pending.length >= TARGET_CHUNK_SAMPLES) {
      chunks.push(pcm16Bytes(this.pending.splice(0, TARGET_CHUNK_SAMPLES)));
    }
    return chunks;
  }
}

export class GeminiLiveCapture {
  private failure: Error | undefined;
  private audioStopped = false;
  private settled = false;
  private finishPromise: Promise<string> | undefined;
  private latestSnapshot: LiveTranscriptSnapshot = { committed: "", tentative: "" };
  private resolveWorkletFlush: (() => void) | undefined;
  private rejectWorkletFlush: ((error: Error) => void) | undefined;
  private readonly encoder: Pcm16ChunkEncoder;
  private readonly unsubscribe: () => void;
  private readonly sendQueue: OrderedPcmSendQueue;

  private constructor(
    readonly sessionId: string,
    private readonly context: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly worklet: AudioWorkletNode,
    private readonly silentGain: GainNode,
    onTranscript: (snapshot: LiveTranscriptSnapshot) => void,
  ) {
    this.encoder = new Pcm16ChunkEncoder(context.sampleRate);
    this.sendQueue = new OrderedPcmSendQueue((base64) =>
      voiceApi.streamPush(this.sessionId, base64),
    );
    this.unsubscribe = voiceApi.onStreamText((payload) => {
      if (!this.settled && payload.sessionId === sessionId) {
        this.latestSnapshot = {
          committed: payload.committed,
          tentative: payload.tentative,
        };
        onTranscript(this.latestSnapshot);
      }
    });
    worklet.port.onmessage = (event: MessageEvent<Float32Array | { type?: string }>) => {
      if (event.data instanceof Float32Array) {
        this.enqueue(this.encoder.push(event.data));
      } else if (event.data?.type === "flushed") {
        this.resolveWorkletFlush?.();
      }
    };
    worklet.port.onmessageerror = () => {
      const error = new Error("Aiden could not read streaming microphone audio.");
      this.failure = error;
      this.rejectWorkletFlush?.(error);
    };
  }

  static async start(
    stream: MediaStream,
    onTranscript: (snapshot: LiveTranscriptSnapshot) => void,
  ): Promise<GeminiLiveCapture> {
    const { sessionId } = await voiceApi.streamStart();
    let context: AudioContext | undefined;
    try {
      context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      await context.audioWorklet.addModule(
        new URL("../worklets/gemini-live-pcm-worklet.js?no-inline", import.meta.url),
      );
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, "gemini-live-pcm");
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      source.connect(worklet).connect(silentGain).connect(context.destination);
      await context.resume();
      return new GeminiLiveCapture(sessionId, context, source, worklet, silentGain, onTranscript);
    } catch (error) {
      if (context) void context.close().catch(() => {});
      await voiceApi.streamCancel(sessionId).catch(() => {});
      throw error;
    }
  }

  async finish(): Promise<string> {
    if (this.finishPromise) return this.finishPromise;
    if (this.settled) throw new Error("Gemini Live transcription is no longer active.");
    this.finishPromise = this.finishOnce();
    return this.finishPromise;
  }

  snapshot(): LiveTranscriptSnapshot {
    return { ...this.latestSnapshot };
  }

  private async finishOnce(): Promise<string> {
    try {
      await this.flushWorklet();
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
    }
    if (this.settled) throw new Error("Gemini Live transcription was cancelled.");
    this.stopCapture();
    this.enqueue(this.encoder.flush());
    try {
      await this.sendQueue.drain();
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
    }
    if (this.failure || this.sendQueue.failure) {
      await voiceApi.streamCancel(this.sessionId).catch(() => {});
      this.settled = true;
      this.unsubscribe();
      throw this.failure ?? this.sendQueue.failure;
    }
    try {
      const text = (await voiceApi.streamFinish(this.sessionId)).trim();
      return text;
    } finally {
      this.settled = true;
      this.unsubscribe();
    }
  }

  async cancel(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.rejectWorkletFlush?.(new Error("Gemini Live transcription was cancelled."));
    this.stopCapture();
    this.unsubscribe();
    await voiceApi.streamCancel(this.sessionId).catch(() => {});
  }

  private enqueue(chunks: Uint8Array[]): void {
    for (const chunk of chunks) {
      if (this.failure) return;
      this.sendQueue.enqueue(chunk);
    }
  }

  private flushWorklet(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.resolveWorkletFlush = undefined;
        this.rejectWorkletFlush = undefined;
        reject(new Error("Aiden timed out while draining streaming microphone audio."));
      }, WORKLET_FLUSH_TIMEOUT_MS);
      this.resolveWorkletFlush = () => {
        window.clearTimeout(timer);
        this.resolveWorkletFlush = undefined;
        this.rejectWorkletFlush = undefined;
        resolve();
      };
      this.rejectWorkletFlush = (error) => {
        window.clearTimeout(timer);
        this.resolveWorkletFlush = undefined;
        this.rejectWorkletFlush = undefined;
        reject(error);
      };
      this.worklet.port.postMessage({ type: "flush" });
    });
  }

  private stopCapture(): void {
    if (this.audioStopped) return;
    this.audioStopped = true;
    this.worklet.port.onmessage = null;
    this.worklet.port.onmessageerror = null;
    this.source.disconnect();
    this.worklet.disconnect();
    this.silentGain.disconnect();
    void this.context.close().catch(() => {});
  }
}
