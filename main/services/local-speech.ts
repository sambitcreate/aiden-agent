// Isolated on-device transcription host. The recognizer runs in a utility
// process so decode work cannot stall Electron main; the parent supervises it
// with per-request deadlines and one retry in a fresh worker after a crash.

import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { UtilityProcess } from "electron";
import { localVoiceIdleUnloadMs } from "../../renderer/shared/dictation-preferences.js";
import { effectiveLanguage } from "../../renderer/shared/voice-language.js";
import { voiceTrimSilenceEnabled } from "../../renderer/shared/voice-preferences.js";
import { decodeAidenRemotePcm16ToInt16 } from "./aiden-remote-speech-codec.js";
import type { SpeechModelSpec } from "./local-speech-catalog.js";
import { speechEngine } from "./local-speech-engine.js";
import { LocalSpeechIdleUnloader } from "./local-speech-idle-unload.js";
import { LocalSpeechLane } from "./local-speech-lane.js";
import { isModelInstalled, modelDir, specFor } from "./local-speech-models.js";
import {
  LocalSpeechProcessClient,
  LocalSpeechWorkerError,
  runWithCrashRetry,
  WorkerCrashError,
  type LocalSpeechTranscribeInput,
} from "./local-speech-process-core.js";
import { LOCAL_SPEECH_PROTOCOL_VERSION, type LocalSpeechAudio } from "./local-speech-protocol.js";
import { handleLocalSpeechMessage } from "./local-speech-worker-core.js";

export interface LocalSpeechState {
  modelId: string;
  state: "loading" | "ready" | "failed" | "unloaded";
  error?: string;
}

const MODEL_MISSING_MESSAGE = "The selected voice model isn't downloaded. Download it in Settings → Voice.";

let client: LocalSpeechProcessClient | null = null;
let child: UtilityProcess | null = null;
let launching: Promise<LocalSpeechProcessClient> | null = null;
let processGeneration = 0;
/** The model the worker (or the in-process fallback) currently holds. */
let loadedModelId: string | null = null;
const lane = new LocalSpeechLane();
const stateListeners = new Set<(state: LocalSpeechState) => void>();

export function onLocalSpeechState(listener: (state: LocalSpeechState) => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

function emitState(state: LocalSpeechState): void {
  for (const listener of stateListeners) {
    try {
      listener(state);
    } catch {
      // A listener failure must not break transcription.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function markUnloaded(): void {
  const previous = loadedModelId;
  loadedModelId = null;
  if (previous) emitState({ modelId: previous, state: "unloaded" });
}

// Terminating the utility process is the only way to return the native
// sherpa-onnx allocations to the OS, so idle unload disposes the worker.
const idleUnloader = new LocalSpeechIdleUnloader({
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer),
  idleMs: async () => {
    const { configStore } = await import("./config-store.js");
    return localVoiceIdleUnloadMs((await configStore.getSettings()).localVoiceIdleUnloadMinutes);
  },
  unload: () => unloadIdleModel(),
});

function shutDownWorker(): void {
  processGeneration += 1;
  const current = client;
  client = null;
  launching = null;
  current?.dispose();
  child = null;
}

function unloadIdleModel(): void {
  shutDownWorker();
  speechEngine.release();
  markUnloaded();
}

/** Hold the model loaded for the duration of `operation`, then restart the idle countdown. */
async function withModelLease<T>(operation: () => Promise<T>): Promise<T> {
  const end = idleUnloader.begin();
  try {
    return await operation();
  } finally {
    end();
  }
}

async function warn(event: string, details: Record<string, unknown>): Promise<void> {
  try {
    const { logger } = await import("../platform.js");
    logger.warn("local-speech", event, details);
  } catch {
    process.stderr.write(`[local-speech] ${event} ${JSON.stringify(details)}\n`);
  }
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
    },
    { onHang },
  );
}

async function launchClient(generation: number): Promise<LocalSpeechProcessClient> {
  const { utilityProcess } = await import("electron");
  if (typeof utilityProcess?.fork !== "function") {
    throw new Error("Cannot find package 'electron'");
  }
  const entry = fileURLToPath(new URL("./local-speech-worker.js", import.meta.url));
  const launched = utilityProcess.fork(entry, [], {
    serviceName: "Aiden Voice Transcription",
    stdio: "pipe",
  });
  // A hung request: terminate this worker so the retry forks a fresh one.
  const created: LocalSpeechProcessClient = attachUtilityProcess(launched, () => disposeClientIfCurrent(created));
  if (launched.stderr) {
    createInterface({ input: launched.stderr }).on("line", (line) => created.pushStderr(line));
  }
  launched.stdout?.resume();
  if (generation !== processGeneration) {
    created.dispose();
    throw new Error("Local speech host was replaced.");
  }
  launched.on("exit", () => {
    if (child === launched) child = null;
    if (client === created) {
      client = null;
      loadedModelId = null;
      if (idleUnloader.inFlight === 0) idleUnloader.forget();
    }
  });
  child = launched;
  client = created;
  return created;
}

async function getClient(): Promise<LocalSpeechProcessClient> {
  if (client) return client;
  if (!launching) {
    const pending = launchClient(processGeneration);
    const tracked = pending.finally(() => {
      if (launching === tracked) launching = null;
    });
    launching = tracked;
  }
  return launching;
}

function isolationUnavailable(error: unknown): boolean {
  return /Cannot find package 'electron'|Cannot find module ['"]electron['"]/i.test(errorMessage(error));
}

function disposeClientIfCurrent(expected: LocalSpeechProcessClient): void {
  if (client !== expected) return;
  shutDownWorker();
  loadedModelId = null;
}

async function vadModelPath(): Promise<string> {
  try {
    const { app } = await import("electron");
    if (app?.isPackaged) return path.join(process.resourcesPath, "speech", "silero_vad.onnx");
  } catch {
    // Not running under Electron: use the repository copy.
  }
  return fileURLToPath(new URL("../../resources/speech/silero_vad.onnx", import.meta.url));
}

/** Runs one protocol request on the in-process engine (non-Electron hosts). */
async function inProcess(
  message: Parameters<typeof handleLocalSpeechMessage>[0],
): Promise<{ text: string; language: string | null; decodeMs: number }> {
  const reply = await handleLocalSpeechMessage(message);
  if (reply.kind === "failure") throw new LocalSpeechWorkerError(reply.message, reply.code);
  return { text: reply.text ?? "", language: reply.language ?? null, decodeMs: reply.decodeMs ?? 0 };
}

// Whether the native engine loads is fixed for the life of the app, so the
// first answer from the engine is reused. Settings polls this, and asking
// again would fork the speech worker (and hold a model lease) every time.
let knownEngineStatus: { ready: boolean; error: string | null } | null = null;

export async function engineStatus(): Promise<{ ready: boolean; error: string | null }> {
  if (knownEngineStatus) return knownEngineStatus;
  return withModelLease(async () => {
    try {
      knownEngineStatus = await (await getClient()).status();
      return knownEngineStatus;
    } catch (error) {
      if (isolationUnavailable(error)) {
        knownEngineStatus = speechEngine.status();
        return knownEngineStatus;
      }
      // A failed launch may be transient; do not remember it.
      return { ready: false, error: errorMessage(error) };
    }
  });
}

function installedModel(modelId: string): { spec: SpeechModelSpec; directory: string } | null {
  const spec = specFor(modelId);
  const directory = modelDir(modelId);
  if (!spec || !directory || !isModelInstalled(modelId)) return null;
  return { spec, directory };
}

/**
 * Preload the recognizer so the first transcription after a hotkey press or
 * microphone start does not pay the model-load cost. Best effort: a missing
 * model or failed load is reported to the caller, which should ignore it —
 * the real transcription reports the actionable error.
 */
export async function warmLocalVoice(modelId: string): Promise<void> {
  const model = installedModel(modelId);
  if (!model) return;
  await lane.run(() =>
    withModelLease(async () => {
      if (loadedModelId === modelId && client) return;
      emitState({ modelId, state: "loading" });
      try {
        try {
          await (await getClient()).load(modelId, model.directory, model.spec);
        } catch (error) {
          if (!isolationUnavailable(error)) throw error;
          speechEngine.load(model.spec, model.directory);
        }
        loadedModelId = modelId;
        emitState({ modelId, state: "ready" });
      } catch (error) {
        emitState({ modelId, state: "failed", error: errorMessage(error) });
        throw error;
      }
    }),
  );
}

/** Settings changed the idle period: restart the countdown with the new value. */
export function reconfigureLocalSpeechIdleUnload(): Promise<void> {
  return idleUnloader.reconfigure();
}

export async function releaseRecognizer(modelId: string): Promise<void> {
  await lane.run(async () => {
    if (loadedModelId !== modelId) return;
    if (client) await client.release();
    else speechEngine.release();
    markUnloaded();
  });
}

async function transcribeAudio(audio: LocalSpeechAudio, modelId: string, signal?: AbortSignal): Promise<string> {
  const model = installedModel(modelId);
  if (!model) throw new Error(MODEL_MISSING_MESSAGE);
  const { configStore } = await import("./config-store.js");
  const settings = await configStore.getSettings();
  const request: LocalSpeechTranscribeInput = {
    modelId,
    modelDirectory: model.directory,
    spec: model.spec,
    audio,
    language: effectiveLanguage(model.spec, settings.voiceLanguage).language,
    translate: settings.voiceTranslateToEnglish === true,
    trimSilence: voiceTrimSilenceEnabled(settings.voiceTrimSilence),
    vadModelPath: await vadModelPath(),
  };

  let activeClient: LocalSpeechProcessClient | null = null;
  return lane.run(
    () =>
      withModelLease(async () => {
        const willLoad = loadedModelId !== modelId;
        if (willLoad) emitState({ modelId, state: "loading" });
        try {
          const result = await runWithCrashRetry(
            async () => {
              activeClient = await getClient();
              if (signal?.aborted) {
                disposeClientIfCurrent(activeClient);
                signal.throwIfAborted();
              }
              return activeClient.transcribe(request);
            },
            {
              isCancelled: () => signal?.aborted === true,
              isCrash: (error) => error instanceof WorkerCrashError,
              onCrash: (_error, attempt) => {
                const crashed = activeClient;
                void warn("worker crashed", { attempt, stderr: crashed?.stderrTail().join("\n") ?? "" });
                if (crashed) disposeClientIfCurrent(crashed);
              },
            },
          ).catch(async (error: unknown) => {
            if (!isolationUnavailable(error)) throw error;
            signal?.throwIfAborted();
            return inProcess({ ...request, kind: "transcribe", version: LOCAL_SPEECH_PROTOCOL_VERSION, requestId: "in-process" });
          });
          loadedModelId = modelId;
          if (willLoad) emitState({ modelId, state: "ready" });
          return result.text;
        } catch (error) {
          // Only a pending load has a visible state to settle.
          if (willLoad) emitState({ modelId, state: "failed", error: errorMessage(error) });
          throw error;
        }
      }),
    {
      signal,
      onCancelActive: () => {
        if (activeClient) disposeClientIfCurrent(activeClient);
      },
    },
  );
}

export function transcribeLocalPcm16(pcm: Int16Array, modelId: string, signal?: AbortSignal): Promise<string> {
  return transcribeAudio({ kind: "pcm16", pcm }, modelId, signal);
}

/** Ogg/Opus voice notes (Telegram). The worker rejects them until the decoder ships. */
export function transcribeLocalOggOpus(bytes: Uint8Array, modelId: string, signal?: AbortSignal): Promise<string> {
  return transcribeAudio({ kind: "ogg-opus", bytes }, modelId, signal);
}

/** Aiden Remote sends base64 PCM16; decode it once and transcribe. */
export function transcribePcm16Base64(pcmBase64: string, modelId: string): Promise<string> {
  return transcribeLocalPcm16(decodeAidenRemotePcm16ToInt16(pcmBase64), modelId);
}

export function disposeLocalSpeech(): void {
  idleUnloader.forget();
  shutDownWorker();
  markUnloaded();
}
