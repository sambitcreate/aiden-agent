import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { createSpeechModelManager } from "../../../main/services/local-speech-downloads.js";
import { AidenRemoteSpeechServiceCore } from "../../../main/services/aiden-remote-speech-core.js";
import {
  LocalSpeechProcessClient,
  runWithCrashRetry,
  WorkerCrashError,
} from "../../../main/services/local-speech-process-core.js";
import { effectiveLanguage } from "../../../renderer/shared/voice-language.js";
import { voiceTrimSilenceEnabled } from "../../../renderer/shared/voice-preferences.js";
import type { AppSettings } from "../../../main/services/types.js";
import { JsonStore, acquireLease } from "./state.ts";
import { recordUsageRecord } from "./usage-ledger.ts";
import { readRegularFile } from "../../../main/services/regular-file-read.js";
import { AIDEN_REMOTE_MAX_PCM16_BYTES, decodeAidenRemotePcm16ToInt16 } from "../../../main/services/aiden-remote-speech-codec.js";

export function createCliSpeech(agentDir: string) {
  // Pre-1.0: the unverified Parakeet folder is removed, not migrated.
  // createCliSpeech is synchronous for its callers, so this uses rmSync.
  try { rmSync(join(agentDir, "parakeet-models"), { recursive: true, force: true }); } catch { /* best effort */ }
  const models = createSpeechModelManager({ root: () => join(agentDir, "voice-models") });
  const settings = new JsonStore<AppSettings>(join(agentDir, "speech.json"), {});
  let worker: Worker | undefined, client: LocalSpeechProcessClient | undefined;
  const cliDir = () => dirname(process.env.AIDEN_CLI_ENTRY!);
  const dropClient = (current: LocalSpeechProcessClient) => {
    if (client !== current) return;
    current.dispose(); client = undefined; worker = undefined;
  };
  const getClient = () => {
    if (client) return client;
    const launched = new Worker(join(cliDir(), "speech-worker.js"), { stderr: true, stdout: true });
    worker = launched;
    launched.on("error", () => {}); // The exit listener rejects pending protocol requests.
    launched.stdout.resume();
    const created: LocalSpeechProcessClient = new LocalSpeechProcessClient({
      postMessage: (value) => launched.postMessage(value),
      onMessage: (callback) => { launched.on("message", callback); return () => { launched.off("message", callback); }; },
      onExit: (callback) => { launched.on("exit", callback); return () => { launched.off("exit", callback); }; },
      kill: () => { void launched.terminate(); },
    }, { onHang: () => dropClient(created) });
    createInterface({ input: launched.stderr }).on("line", (line) => created.pushStderr(line));
    launched.once("exit", () => { if (worker === launched) { worker = undefined; client = undefined; } });
    client = created;
    return created;
  };
  const service = new AidenRemoteSpeechServiceCore({ ...models,
    configStore: { getSettings: () => settings.load(), setSettings: (patch) => settings.update((value) => { Object.assign(value, patch); return value; }) },
    engineStatus: () => getClient().status(),
    releaseRecognizer: async () => { if (client) await client.release(); },
    transcribePcm16Base64: async (pcmBase64, modelId) => {
      const modelDirectory = models.modelDir(modelId);
      const spec = models.specFor(modelId);
      if (!spec || !modelDirectory || !models.isModelInstalled(modelId)) throw new Error("The local speech model is not installed.");
      const prefs = await settings.load();
      const request = {
        modelId, modelDirectory, spec,
        audio: { kind: "pcm16" as const, pcm: decodeAidenRemotePcm16ToInt16(pcmBase64) },
        language: effectiveLanguage(spec, prefs.voiceLanguage).language,
        translate: prefs.voiceTranslateToEnglish === true,
        trimSilence: voiceTrimSilenceEnabled(prefs.voiceTrimSilence),
        vadModelPath: join(cliDir(), "speech", "silero_vad.onnx"),
      };
      let current: LocalSpeechProcessClient | undefined;
      const result = await runWithCrashRetry(async () => { current = getClient(); return current.transcribe(request); }, {
        isCancelled: () => false,
        isCrash: (error) => error instanceof WorkerCrashError,
        onCrash: (_error, attempt) => {
          if (!current) return;
          process.stderr.write(`[local-speech] worker crashed (attempt ${attempt})\n${current.stderrTail().join("\n")}\n`);
          dropClient(current);
        },
      });
      return result.text;
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
