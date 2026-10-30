// Records the microphone as 16 kHz mono PCM16 for on-device transcription.
// MediaRecorder produces WebM/Opus that has to be decoded and resampled after
// the user stops; capturing raw samples through an AudioWorklet means the
// audio is ready the moment the last chunk lands, and the stop tail only has
// to cover the worklet's buffer, not an encoder flush.

import { Pcm16ChunkEncoder } from "./live-pcm-capture";
import { RECORDING_TAIL_FLUSH_MS } from "./media-recorder-stop";
import type { VoiceProvider } from "./types";

export const PCM_SAMPLE_RATE = 16_000;
/** Hangover after the user stops, so the last syllable reaches the worklet. */
export const PCM_RECORDING_TAIL_MS = 80;
const FLUSH_TIMEOUT_MS = 500;
/**
 * The longest recording kept, in samples: main's on-device limit (30 minutes at
 * 16 kHz). A recording that reaches it stops taking audio and reports `onlimit`
 * so the caller can stop and transcribe what was kept instead of losing it all.
 */
export const PCM_MAX_RECORDING_SAMPLES = PCM_SAMPLE_RATE * 60 * 30;

/**
 * Shaped like the parts of MediaRecorder that capture code drives (`state`,
 * `start`, `stop`, `onstop`), so one stop path serves both recorders.
 */
export class PcmRecorder {
  state: "inactive" | "recording" = "inactive";
  onstop: (() => void) | null = null;
  /** Each 100 ms PCM16 LE chunk as it is captured, for live dictation text. */
  onchunk: ((chunk: Uint8Array) => void) | null = null;
  /** Fires once when the recording reaches its sample limit; later audio is dropped. */
  onlimit: (() => void) | null = null;
  private readonly chunks: Uint8Array[] = [];
  private keptBytes = 0;
  private limitReported = false;
  private readonly encoder: Pcm16ChunkEncoder;
  private finished = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly context: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly worklet: AudioWorkletNode,
    private readonly silentGain: GainNode,
    private readonly maxSamples: number,
  ) {
    this.encoder = new Pcm16ChunkEncoder(context.sampleRate);
    worklet.port.onmessage = (event: MessageEvent<Float32Array | { type?: string }>) => {
      if (this.finished) return;
      if (event.data instanceof Float32Array) {
        const chunks = this.keep(this.encoder.push(event.data));
        if (this.state === "recording") for (const chunk of chunks) this.onchunk?.(chunk);
        if (this.keptBytes >= this.maxSamples * 2 && !this.limitReported) {
          this.limitReported = true;
          this.onlimit?.();
        }
      } else if (event.data?.type === "flushed") this.finish();
    };
  }

  /**
   * Wire the stream into the capture worklet. Audio is kept from this moment,
   * since the user is already speaking once the microphone is open.
   */
  static async create(
    stream: MediaStream,
    maxSamples: number = PCM_MAX_RECORDING_SAMPLES,
  ): Promise<PcmRecorder> {
    const context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
    try {
      await context.audioWorklet.addModule(
        new URL("../worklets/gemini-live-pcm-worklet.js?no-inline", import.meta.url),
      );
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, "gemini-live-pcm");
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      source.connect(worklet).connect(silentGain).connect(context.destination);
      void context.resume().catch(() => {});
      return new PcmRecorder(context, source, worklet, silentGain, maxSamples);
    } catch (error) {
      void context.close().catch(() => {});
      throw error;
    }
  }

  start(): void {
    if (this.state === "inactive" && !this.finished) this.state = "recording";
  }

  /** Like MediaRecorder: state turns inactive now, `onstop` fires once the worklet drains. */
  stop(): void {
    if (this.state !== "recording") return;
    this.state = "inactive";
    // A suspended or stalled audio thread never answers; keep what arrived.
    this.flushTimer = setTimeout(() => this.finish(), FLUSH_TIMEOUT_MS);
    this.worklet.port.postMessage({ type: "flush" });
  }

  /** The recording as 16 kHz mono PCM16, sized exactly to its samples. */
  takePcm(): Int16Array<ArrayBuffer> {
    return pcm16FromChunks(this.chunks);
  }

  /** Stop capturing without delivering anything. Safe to call more than once. */
  dispose(): void {
    this.state = "inactive";
    this.onstop = null;
    this.onchunk = null;
    this.onlimit = null;
    this.release();
  }

  /** Stores encoded chunks up to the sample limit, trimming the one that crosses it. */
  private keep(chunks: readonly Uint8Array[]): Uint8Array[] {
    const kept: Uint8Array[] = [];
    for (const chunk of chunks) {
      const room = this.maxSamples * 2 - this.keptBytes;
      if (room <= 0) break;
      const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(part);
      this.keptBytes += part.byteLength;
      kept.push(part);
    }
    return kept;
  }

  private finish(): void {
    if (this.finished) return;
    this.keep(this.encoder.flush());
    this.release();
    const onstop = this.onstop;
    this.onstop = null;
    onstop?.();
  }

  private release(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.finished) return;
    this.finished = true;
    this.worklet.port.onmessage = null;
    this.source.disconnect();
    this.worklet.disconnect();
    this.silentGain.disconnect();
    void this.context.close().catch(() => {});
  }
}

/** Joins PCM16 LE chunks into native-order samples, as main's on-device IPC expects. */
export function pcm16FromChunks(chunks: readonly Uint8Array[]): Int16Array<ArrayBuffer> {
  const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const pcm = new Int16Array(bytes / 2);
  let sample = 0;
  for (const chunk of chunks) {
    // The encoder writes little-endian; read it back as such on any host.
    const source = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (let index = 0; index < chunk.byteLength; index += 2) {
      pcm[sample] = source.getInt16(index, true);
      sample += 1;
    }
  }
  return pcm;
}

/** The stop hangover a recorder needs: the worklet buffer for PCM, the encoder flush otherwise. */
export function recorderStopTailMs(recorder: object): number {
  return recorder instanceof PcmRecorder ? PCM_RECORDING_TAIL_MS : RECORDING_TAIL_FLUSH_MS;
}

/**
 * On-device voice records raw PCM. Cloud voice, or a renderer whose capture
 * worklet fails to load, records a MediaRecorder file (decoded after stop).
 */
export async function createVoiceRecorder(
  stream: MediaStream,
  provider: VoiceProvider,
  maxPcmSamples: number = PCM_MAX_RECORDING_SAMPLES,
): Promise<MediaRecorder | PcmRecorder> {
  if (provider === "local") {
    try {
      return await PcmRecorder.create(stream, maxPcmSamples);
    } catch {
      // The file recorder still works; it only costs a decode after stop.
    }
  }
  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
  return new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
}
