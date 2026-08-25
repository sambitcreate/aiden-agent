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

let client: ParakeetProcessClient | null = null;
let child: UtilityProcess | null = null;
let launching: Promise<ParakeetProcessClient> | null = null;

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

async function launchClient(): Promise<ParakeetProcessClient> {
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
    launching = launchClient().finally(() => {
      launching = null;
    });
  }
  return launching;
}

function isolationUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Cannot find package 'electron'|Cannot find module ['"]electron['"]/i.test(message);
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

export async function transcribePcmBase64(pcmBase64: string, modelId: string): Promise<string> {
  const directory = modelDir(modelId);
  if (!directory || !isModelInstalled(modelId)) {
    throw new Error("The selected voice model isn't downloaded. Download it in Settings → Voice.");
  }
  try {
    return await (
      await getClient()
    ).transcribe({
      modelId,
      modelDirectory: directory,
      pcmBase64,
      encoding: "float32le",
    });
  } catch (error) {
    if (isolationUnavailable(error)) {
      return transcribePcmInProcess(pcmToFloat32(pcmBase64), modelId, directory);
    }
    throw error;
  }
}

export async function transcribePcm16Base64(
  pcmBase64: string,
  modelId: string,
): Promise<string> {
  const directory = modelDir(modelId);
  if (!directory || !isModelInstalled(modelId)) {
    throw new Error("The selected voice model isn't downloaded. Download it in Settings → Voice.");
  }
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
}

export function disposeParakeet(): void {
  const current = client;
  client = null;
  current?.dispose();
  child = null;
}
