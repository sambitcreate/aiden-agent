// Isolated on-device transcription host. The recognizer runs in a utility
// process so decode work cannot stall Electron main.

import { fileURLToPath } from "node:url";
import type { UtilityProcess } from "electron";
import { pcmToFloat32 } from "../handlers/voice-codec.js";
import { decodeAidenRemotePcm16 } from "./aiden-remote-speech-codec.js";
import { isModelInstalled, modelDir } from "./local-models.js";
import {
  engineStatus as engineStatusInProcess,
  releaseRecognizer as releaseRecognizerInProcess,
  transcribePcm as transcribePcmInProcess,
} from "./parakeet-engine.js";
import { ParakeetProcessClient } from "./parakeet-process-core.js";
import { ParakeetTranscriptionLane } from "./parakeet-transcription-lane.js";

let client: ParakeetProcessClient | null = null;
let child: UtilityProcess | null = null;
let launching: Promise<ParakeetProcessClient> | null = null;
let processGeneration = 0;
const transcriptionLane = new ParakeetTranscriptionLane();

function attachUtilityProcess(processHandle: UtilityProcess): ParakeetProcessClient {
  return new ParakeetProcessClient({
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
  });
}

async function launchClient(generation: number): Promise<ParakeetProcessClient> {
  const { utilityProcess } = await import("electron");
  if (typeof utilityProcess?.fork !== "function") {
    throw new Error("Cannot find package 'electron'");
  }
  const entry = fileURLToPath(new URL("./parakeet-worker.js", import.meta.url));
  const launched = utilityProcess.fork(entry, [], {
    serviceName: "Aiden Voice Transcription",
    stdio: "ignore",
  });
  const created = attachUtilityProcess(launched);
  if (generation !== processGeneration) {
    created.dispose();
    throw new Error("Parakeet transcription host was replaced.");
  }
  launched.on("exit", () => {
    if (child === launched) child = null;
    if (client === created) client = null;
  });
  child = launched;
  client = created;
  return created;
}

async function getClient(): Promise<ParakeetProcessClient> {
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
  const message = error instanceof Error ? error.message : String(error);
  return /Cannot find package 'electron'|Cannot find module ['"]electron['"]/i.test(message);
}

function disposeClientIfCurrent(expected: ParakeetProcessClient): void {
  if (client !== expected) return;
  processGeneration += 1;
  client = null;
  launching = null;
  expected.dispose();
  child = null;
}

export async function engineStatus(): Promise<{ ready: boolean; error: string | null }> {
  try {
    return await (await getClient()).status();
  } catch (error) {
    if (isolationUnavailable(error)) return engineStatusInProcess();
    return { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function releaseRecognizer(modelId: string): Promise<void> {
  try {
    await (await getClient()).release(modelId);
  } catch (error) {
    if (isolationUnavailable(error)) {
      releaseRecognizerInProcess(modelId);
      return;
    }
    throw error;
  }
}

export async function transcribePcmBase64(
  pcmBase64: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<string> {
  const directory = modelDir(modelId);
  if (!directory || !isModelInstalled(modelId)) {
    throw new Error("The selected voice model isn't downloaded. Download it in Settings → Voice.");
  }
  let activeClient: ParakeetProcessClient | null = null;
  return transcriptionLane.run(
    async () => {
      try {
        activeClient = await getClient();
        if (signal?.aborted) {
          disposeClientIfCurrent(activeClient);
          signal.throwIfAborted();
        }
        return await activeClient.transcribe({
          modelId,
          modelDirectory: directory,
          pcmBase64,
          encoding: "float32le",
        });
      } catch (error) {
        if (isolationUnavailable(error)) {
          signal?.throwIfAborted();
          return transcribePcmInProcess(pcmToFloat32(pcmBase64), modelId, directory);
        }
        throw error;
      }
    },
    {
      signal,
      onCancelActive: () => {
        if (activeClient) disposeClientIfCurrent(activeClient);
      },
    },
  );
}

export async function transcribePcm16Base64(pcmBase64: string, modelId: string): Promise<string> {
  const directory = modelDir(modelId);
  if (!directory || !isModelInstalled(modelId)) {
    throw new Error("The selected voice model isn't downloaded. Download it in Settings → Voice.");
  }
  return transcriptionLane.run(async () => {
    try {
      return await (
        await getClient()
      ).transcribe({
        modelId,
        modelDirectory: directory,
        pcmBase64,
        encoding: "pcm_s16le",
      });
    } catch (error) {
      if (isolationUnavailable(error)) {
        return transcribePcmInProcess(decodeAidenRemotePcm16(pcmBase64), modelId, directory);
      }
      throw error;
    }
  });
}

export function disposeParakeet(): void {
  processGeneration += 1;
  const current = client;
  client = null;
  launching = null;
  current?.dispose();
  child = null;
}
