import { parentPort } from "node:worker_threads";
import { speechModel, type SpeechModelSpec } from "../../../main/services/local-speech-catalog.js";
import { speechEngine } from "../../../main/services/local-speech-engine.js";
import { decodeAidenRemotePcm16 } from "../../../main/services/aiden-remote-speech-codec.js";
import {
  isParakeetParentMessage,
  PARAKEET_PROTOCOL_VERSION,
} from "../../../main/services/parakeet-protocol.js";

// Interim bridge until Task 6 moves the worker protocol onto the speech engine.
function engineSpec(modelId: string): SpeechModelSpec {
  const spec = speechModel(modelId);
  if (!spec) throw new Error(`Unknown voice model: ${modelId}`);
  return spec;
}
function transcribePcm(samples: Float32Array, modelId: string, modelDirectory: string): string {
  return speechEngine.transcribe({
    spec: engineSpec(modelId), modelDirectory, samples,
    language: null, task: "transcribe", trimSilence: false, vadModelPath: "",
  }).text;
}
function warmRecognizer(modelId: string, modelDirectory: string): void {
  speechEngine.load(engineSpec(modelId), modelDirectory);
}
function releaseRecognizer(modelId: string): void {
  if (speechEngine.loadedModelId() === modelId) speechEngine.release();
}

if (!parentPort) throw new Error("Speech worker requires a parent port.");
parentPort.on("message", (message: unknown) => {
  if (!isParakeetParentMessage(message)) return;
  try {
    let result: object = {};
    if (message.kind === "status") result = speechEngine.status();
    else if (message.kind === "release") releaseRecognizer(message.modelId);
    else if (message.kind === "warm") warmRecognizer(message.modelId, message.modelDirectory);
    else {
      if (message.encoding !== "pcm_s16le") throw new Error("CLI speech accepts PCM16 only.");
      result = {
        text: transcribePcm(
          decodeAidenRemotePcm16(message.pcmBase64),
          message.modelId,
          message.modelDirectory,
        ),
      };
    }
    parentPort!.postMessage({
      version: PARAKEET_PROTOCOL_VERSION,
      kind: "result",
      requestId: message.requestId,
      ...result,
    });
  } catch (error) {
    parentPort!.postMessage({
      version: PARAKEET_PROTOCOL_VERSION,
      kind: "failure",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
