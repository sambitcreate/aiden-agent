// Owns the on-device speech utility process. sherpa-onnx frees a recognizer
// only when its native handle is garbage-collected, so the only deterministic
// way to return a model's memory is to replace the process that holds it. This
// module retires the worker and waits for its exit before the replacement forks.
// Electron-free: the caller supplies the fork function.

import { createInterface } from "node:readline";
import type { UtilityProcess } from "electron";
import type { SpeechModelFamily } from "./local-speech-catalog.js";
import { LocalSpeechProcessClient, type LocalSpeechProcessPort } from "./local-speech-process-core.js";

const DEFAULT_EXIT_WAIT_MS = 2_000;

export interface SpeechWorkerTarget {
  modelId: string;
  family: SpeechModelFamily;
  /** The language the request names; null lets the model detect it. */
  language: string | null;
}

export interface LoadedSpeechModel {
  modelId: string;
  /** Only SenseVoice bakes its language into the recognizer; other families carry null. */
  languageKey: string | null;
}

/** The language a recognizer was built for. Null-language SenseVoice builds as "auto". */
export function speechLanguageKey(family: SpeechModelFamily, language: string | null): string | null {
  return family === "sense-voice" ? (language ?? "auto") : null;
}

/**
 * Whether a request needs a new worker. A different model always does. A
 * SenseVoice recognizer is rebuilt in place for a language change, which keeps
 * the old native model allocated, so it also needs a new worker.
 */
export function needsFreshWorker(loaded: LoadedSpeechModel | null, request: SpeechWorkerTarget): boolean {
  if (!loaded) return false;
  if (loaded.modelId !== request.modelId) return true;
  return request.family === "sense-voice" && loaded.languageKey !== speechLanguageKey(request.family, request.language);
}

export interface LocalSpeechWorkerHostOptions {
  /** Starts a worker process. Rejects when the Electron runtime is unavailable. */
  fork: () => Promise<UtilityProcess>;
  /** The worker no longer holds a model: it exited, hung, or was retired. */
  onUnloaded: () => void;
  /** How long a retired worker may take to exit before it is killed again. */
  exitWaitMs?: number;
}

interface LiveWorker {
  process: UtilityProcess;
  exited: Promise<void>;
}

function settlesWithin(promise: Promise<void>, waitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function attachUtilityProcess(processHandle: UtilityProcess, onHang: () => void): LocalSpeechProcessClient {
  return new LocalSpeechProcessClient(
    {
      postMessage: (message) => processHandle.postMessage(message),
      onMessage: (handler) => {
        const listener = (message: unknown) => handler(message);
        processHandle.on("message", listener);
        return () => {
          processHandle.removeListener("message", listener);
        };
      },
      onExit: (handler) => {
        const listener = (code: number) => handler(code);
        processHandle.on("exit", listener);
        return () => {
          processHandle.removeListener("exit", listener);
        };
      },
      kill: () => {
        processHandle.kill();
      },
    } satisfies LocalSpeechProcessPort,
    { onHang },
  );
}

export class LocalSpeechWorkerHost {
  private client: LocalSpeechProcessClient | null = null;
  private live: LiveWorker | null = null;
  private launching: Promise<LocalSpeechProcessClient> | null = null;
  private generation = 0;
  private loaded: LoadedSpeechModel | null = null;

  constructor(private readonly options: LocalSpeechWorkerHostOptions) {}

  /** The running worker's client, or null when no worker is running. */
  current(): LocalSpeechProcessClient | null {
    return this.client;
  }

  /** The worker, launched when needed. */
  acquire(): Promise<LocalSpeechProcessClient> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.launching) {
      const pending = this.launch(this.generation);
      const tracked = pending.finally(() => {
        if (this.launching === tracked) this.launching = null;
      });
      this.launching = tracked;
    }
    return this.launching;
  }

  /**
   * The worker to run `target` on. A worker that holds a different model, or a
   * SenseVoice recognizer for another language, is retired (and awaited) first.
   * The target is recorded as held before the caller sends its load or
   * transcribe: a load that then fails can leave the native model partly built,
   * so the next request must not reuse this worker for another model.
   */
  async prepare(target: SpeechWorkerTarget): Promise<LocalSpeechProcessClient> {
    if (needsFreshWorker(this.loaded, target)) await this.retire();
    const client = await this.acquire();
    this.loaded = { modelId: target.modelId, languageKey: speechLanguageKey(target.family, target.language) };
    return client;
  }

  /**
   * Disposes the worker and waits for its process to exit, so the native model
   * is freed before anything else loads. A worker that ignores its kill gets a
   * second kill; the wait is bounded so a stuck process cannot wedge the lane.
   */
  async retire(): Promise<void> {
    const exiting = this.live;
    this.shutDown();
    this.options.onUnloaded();
    if (!exiting) return;
    const waitMs = this.options.exitWaitMs ?? DEFAULT_EXIT_WAIT_MS;
    if (await settlesWithin(exiting.exited, waitMs)) return;
    exiting.process.kill();
    await settlesWithin(exiting.exited, waitMs);
  }

  /** Disposes the worker only when it is still the current one (a hang, crash or cancel). */
  disposeIfCurrent(expected: LocalSpeechProcessClient): void {
    if (this.client !== expected) return;
    this.shutDown();
    this.options.onUnloaded();
  }

  /** Synchronous teardown for app shutdown. Does not wait for the exit. */
  shutDown(): void {
    this.generation += 1;
    const current = this.client;
    this.client = null;
    this.launching = null;
    this.loaded = null;
    current?.dispose();
    this.live = null;
  }

  private async launch(generation: number): Promise<LocalSpeechProcessClient> {
    const launched = await this.options.fork();
    const created: LocalSpeechProcessClient = attachUtilityProcess(launched, () => this.disposeIfCurrent(created));
    if (launched.stderr) {
      createInterface({ input: launched.stderr }).on("line", (line) => created.pushStderr(line));
    }
    launched.stdout?.resume();
    if (generation !== this.generation) {
      created.dispose();
      throw new Error("Local speech host was replaced.");
    }
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    launched.on("exit", () => {
      markExited();
      if (this.live?.process === launched) this.live = null;
      if (this.client === created) {
        // A crash exit drops the model; the owner says so before any retry reloads it.
        this.client = null;
        this.loaded = null;
        this.options.onUnloaded();
      }
    });
    this.live = { process: launched, exited };
    this.client = created;
    return created;
  }
}
