import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { createLocalModelManager } from "../../../main/services/local-models-core.js";
import { AidenRemoteSpeechServiceCore } from "../../../main/services/aiden-remote-speech-core.js";
import { ParakeetProcessClient } from "../../../main/services/parakeet-process-core.js";
import type { AppSettings } from "../../../main/services/types.js";
import { JsonStore, acquireLease } from "./state.ts";
import { recordUsageRecord } from "./usage-ledger.ts";
import { readRegularFile } from "../../../main/services/regular-file-read.js";
import { AIDEN_REMOTE_MAX_PCM16_BYTES } from "../../../main/services/aiden-remote-speech-codec.js";

export function createCliSpeech(agentDir: string) {
  const models = createLocalModelManager({ root: () => join(agentDir, "parakeet-models") });
  const settings = new JsonStore<AppSettings>(join(agentDir, "speech.json"), {});
  let worker: Worker | undefined, client: ParakeetProcessClient | undefined;
  const getClient = () => {
    if (client) return client;
    const launched = new Worker(join(dirname(process.env.AIDEN_CLI_ENTRY!), "speech-worker.js"));
    worker = launched;
    launched.on("error", () => {}); // The exit listener rejects pending protocol requests.
    launched.once("exit", () => { if (worker === launched) { worker = undefined; client = undefined; } });
    client = new ParakeetProcessClient({
      postMessage: (value) => launched.postMessage(value),
      onMessage: (callback) => { launched.on("message", callback); return () => { launched.off("message", callback); }; },
      onExit: (callback) => { launched.on("exit", callback); return () => { launched.off("exit", callback); }; },
      kill: () => { void launched.terminate(); },
    });
    return client;
  };
  const service = new AidenRemoteSpeechServiceCore({ ...models,
    configStore: { getSettings: () => settings.load(), setSettings: (patch) => settings.update((value) => { Object.assign(value, patch); return value; }) },
    engineStatus: () => getClient().status(),
    releaseRecognizer: async (id) => { if (client) await client.release(id); },
    transcribePcm16Base64: async (pcmBase64, modelId) => {
      const modelDirectory = models.modelDir(modelId);
      if (!modelDirectory || !models.isModelInstalled(modelId)) throw new Error("The local speech model is not installed.");
      const current = getClient();
      try { return await current.transcribe({ pcmBase64, modelId, modelDirectory, encoding: "pcm_s16le" }); }
      catch (error) { current.dispose(); if (client === current) { client = undefined; worker = undefined; } throw error; }
    },
    recordUsage: (record) => recordUsageRecord(agentDir, record),
  });
  return { service, models, async stop() {
    await models.stopDownloads();
    const stopping = worker; client?.dispose(); client = undefined; worker = undefined;
    if (stopping) await stopping.terminate();
  } };
}

export async function speechCommand(agentDir: string, args: string[]) {
  const release = acquireLease(join(agentDir, "serve"));
  const runtime = createCliSpeech(agentDir);
  try {
    const [action = "status", value] = args;
    if (action === "status") return runtime.service.status();
    if (action === "download" && value) { await runtime.models.downloadModel(value); return runtime.service.status(); }
    if (action === "select" && value) return runtime.service.select({ modelId: value });
    if (action === "delete" && value) return runtime.service.deleteModel(value);
    if (action === "transcribe" && value && args[2]) return runtime.service.transcribe({ encoding: "pcm_s16le", sampleRate: 16000, channels: 1, pcmBase64: (await readRegularFile(value, AIDEN_REMOTE_MAX_PCM16_BYTES)).toString("base64"), modelId: args[2] });
    throw new Error("Usage: speech status|download <id>|select <id>|delete <id>|transcribe <pcm16-file> <model-id>");
  } finally { await runtime.stop(); release(); }
}
