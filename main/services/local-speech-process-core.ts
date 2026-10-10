// Electron-free client for the on-device speech worker: request/response
// correlation, per-request deadlines, crash detection and a stderr tail.

import { randomUUID } from "node:crypto";
import { voiceSetupMessage } from "../../renderer/shared/voice-provider.js";
import type { SpeechModelSpec } from "./local-speech-catalog.js";
import {
  isLocalSpeechWorkerMessage,
  LOCAL_SPEECH_PROTOCOL_VERSION,
  MAX_PCM_SAMPLES,
  type LocalSpeechAudio,
  type LocalSpeechFailureCode,
  type LocalSpeechParentMessage,
  type LocalSpeechWorkerMessage,
} from "./local-speech-protocol.js";

export const LOAD_DEADLINE_MS = 180_000;
export const STATUS_DEADLINE_MS = 30_000;
const STDERR_TAIL_LINES = 64;
const SAMPLE_RATE = 16_000;
/** Rough Opus bytes per second of speech, used only to size a deadline. */
const OGG_OPUS_BYTES_PER_SECOND = 2_000;

/** Transcription gets at least two minutes, and 20× real time for long clips. */
export function transcribeDeadlineMs(audioSeconds: number): number {
  return Math.max(120_000, Math.ceil(20_000 * audioSeconds));
}

/**
 * Audio length used to size the transcribe deadline. The Ogg/Opus estimate is
 * capped at the worker's 30-minute bound: a longer note is rejected after
 * decoding, so it never needs a longer deadline.
 */
export function audioSeconds(audio: LocalSpeechAudio): number {
  if (audio.kind === "pcm16") return audio.pcm.length / SAMPLE_RATE;
  return Math.min(audio.bytes.length / OGG_OPUS_BYTES_PER_SECOND, MAX_PCM_SAMPLES / SAMPLE_RATE);
}

/** The worker exited or stopped answering; the request may be retried in a fresh worker. */
export class WorkerCrashError extends Error {
  override name = "WorkerCrashError";
}

/**
 * The worker answered with a failure frame. An engine that cannot start gets
 * stable restart advice in place of the native loader's wording, which stays
 * available as `detail` for diagnostics.
 */
export class LocalSpeechWorkerError extends Error {
  override name = "LocalSpeechWorkerError";
  readonly detail: string;
  constructor(
    message: string,
    readonly code?: LocalSpeechFailureCode,
  ) {
    super(code === "engine-unavailable" ? voiceSetupMessage("local-engine-unavailable") : message);
    this.detail = message;
  }
}

export interface LocalSpeechProcessPort {
  postMessage: (message: LocalSpeechParentMessage) => void;
  onMessage: (handler: (message: unknown) => void) => () => void;
  onExit: (handler: (code: number) => void) => () => void;
  kill: () => void;
}

export interface LocalSpeechProcessClientOptions {
  /** A request outlived its deadline; the owner should terminate the worker. */
  onHang?: () => void;
  /** Test seam for deadlines. */
  deadlines?: { status: number; load: number; transcribe: (audioSeconds: number) => number };
}

export interface LocalSpeechTranscribeInput {
  modelId: string;
  modelDirectory: string;
  spec: SpeechModelSpec;
  audio: LocalSpeechAudio;
  language: string | null;
  translate: boolean;
  trimSilence: boolean;
  vadModelPath: string;
}

type Outgoing = LocalSpeechParentMessage extends infer M
  ? M extends LocalSpeechParentMessage
    ? Omit<M, "version" | "requestId">
    : never
  : never;

export class LocalSpeechProcessClient {
  private readonly pending = new Map<
    string,
    { resolve: (message: LocalSpeechWorkerMessage) => void; reject: (error: Error) => void }
  >();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeExit: () => void;
  private readonly stderr: string[] = [];
  private readonly deadlines: NonNullable<LocalSpeechProcessClientOptions["deadlines"]>;
  private closed = false;

  constructor(
    private readonly port: LocalSpeechProcessPort,
    private readonly options: LocalSpeechProcessClientOptions = {},
  ) {
    this.deadlines = options.deadlines ?? {
      status: STATUS_DEADLINE_MS,
      load: LOAD_DEADLINE_MS,
      transcribe: transcribeDeadlineMs,
    };
    this.unsubscribeMessage = port.onMessage((raw) => {
      if (!isLocalSpeechWorkerMessage(raw)) return;
      const pending = this.pending.get(raw.requestId);
      if (!pending) return;
      this.pending.delete(raw.requestId);
      pending.resolve(raw);
    });
    this.unsubscribeExit = port.onExit((code) => {
      this.failAll(new WorkerCrashError(`exit ${code}`));
    });
  }

  pushStderr(line: string): void {
    this.stderr.push(line);
    if (this.stderr.length > STDERR_TAIL_LINES) this.stderr.splice(0, this.stderr.length - STDERR_TAIL_LINES);
  }

  stderrTail(): string[] {
    return [...this.stderr];
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private request(message: Outgoing, deadlineMs: number): Promise<LocalSpeechWorkerMessage> {
    if (this.closed) return Promise.reject(new Error("On-device transcription process is closed."));
    const requestId = randomUUID();
    const payload = { ...message, requestId, version: LOCAL_SPEECH_PROTOCOL_VERSION } as LocalSpeechParentMessage;
    return new Promise<LocalSpeechWorkerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new WorkerCrashError("hang"));
        this.options.onHang?.();
      }, deadlineMs);
      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.port.postMessage(payload);
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private static unwrap(result: LocalSpeechWorkerMessage): Extract<LocalSpeechWorkerMessage, { kind: "result" }> {
    if (result.kind === "failure") throw new LocalSpeechWorkerError(result.message, result.code);
    return result;
  }

  async status(): Promise<{ ready: boolean; error: string | null }> {
    const result = LocalSpeechProcessClient.unwrap(await this.request({ kind: "status" }, this.deadlines.status));
    return { ready: result.ready === true, error: result.error ?? null };
  }

  async load(modelId: string, modelDirectory: string, spec: SpeechModelSpec): Promise<{ loadMs: number }> {
    const result = LocalSpeechProcessClient.unwrap(
      await this.request({ kind: "load", modelId, modelDirectory, spec }, this.deadlines.load),
    );
    return { loadMs: result.loadMs ?? 0 };
  }

  async transcribe(
    input: LocalSpeechTranscribeInput,
  ): Promise<{ text: string; language: string | null; decodeMs: number }> {
    const result = LocalSpeechProcessClient.unwrap(
      await this.request({ kind: "transcribe", ...input }, this.deadlines.transcribe(audioSeconds(input.audio))),
    );
    return { text: result.text ?? "", language: result.language ?? null, decodeMs: result.decodeMs ?? 0 };
  }

  async release(): Promise<void> {
    LocalSpeechProcessClient.unwrap(await this.request({ kind: "release" }, this.deadlines.status));
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeMessage();
    this.unsubscribeExit();
    this.failAll(new Error("On-device transcription process closed."));
    this.port.kill();
  }
}

export const LOCAL_SPEECH_CRASH_MESSAGE = "On-device transcription couldn't finish (decode-failed). Try again.";

/**
 * Runs `attempt` once, and once more in a fresh worker when the first attempt
 * crashed. Cancelled requests and ordinary failures are never retried.
 */
export async function runWithCrashRetry<T>(
  attempt: (n: 1 | 2) => Promise<T>,
  opts: { isCancelled(): boolean; isCrash(error: unknown): boolean; onCrash(error: unknown, n: 1 | 2): void },
): Promise<T> {
  try {
    return await attempt(1);
  } catch (error) {
    if (opts.isCancelled() || !opts.isCrash(error)) throw error;
    opts.onCrash(error, 1);
  }
  try {
    return await attempt(2);
  } catch (error) {
    if (opts.isCancelled() || !opts.isCrash(error)) throw error;
    opts.onCrash(error, 2);
    throw new Error(LOCAL_SPEECH_CRASH_MESSAGE);
  }
}
