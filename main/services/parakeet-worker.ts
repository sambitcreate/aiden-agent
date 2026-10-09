import { pcmToFloat32 } from "../handlers/voice-codec.js";
import { decodeAidenRemotePcm16 } from "./aiden-remote-speech-codec.js";
import { speechModel, type SpeechModelSpec } from "./local-speech-catalog.js";
import { speechEngine } from "./local-speech-engine.js";
import {
  isParakeetParentMessage,
  PARAKEET_PROTOCOL_VERSION,
} from "./parakeet-protocol.js";

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

const parentPort = (
  process as NodeJS.Process & {
    parentPort?: {
      postMessage: (message: unknown) => void;
      on: (event: "message", listener: (event: { data: unknown }) => void) => void;
    };
  }
).parentPort;
if (!parentPort) throw new Error("On-device transcription worker requires an Electron parent port.");

function post(message: unknown): void {
  parentPort.postMessage(message);
}

parentPort.on("message", (event) => {
  const message = event.data;
  if (!isParakeetParentMessage(message)) return;
  try {
    if (message.kind === "status") {
      const status = speechEngine.status();
      post({
        version: PARAKEET_PROTOCOL_VERSION,
        kind: "result",
        requestId: message.requestId,
        ready: status.ready,
        error: status.error,
      });
      return;
    }
    if (message.kind === "warm") {
      warmRecognizer(message.modelId, message.modelDirectory);
      post({
        version: PARAKEET_PROTOCOL_VERSION,
        kind: "result",
        requestId: message.requestId,
      });
      return;
    }
    if (message.kind === "release") {
      releaseRecognizer(message.modelId);
      post({
        version: PARAKEET_PROTOCOL_VERSION,
        kind: "result",
        requestId: message.requestId,
      });
      return;
    }
    const text = transcribePcm(
      message.encoding === "pcm_s16le"
        ? decodeAidenRemotePcm16(message.pcmBase64)
        : pcmToFloat32(message.pcmBase64),
      message.modelId,
      message.modelDirectory,
    );
    post({
      version: PARAKEET_PROTOCOL_VERSION,
      kind: "result",
      requestId: message.requestId,
      text,
    });
  } catch (error) {
    post({
      version: PARAKEET_PROTOCOL_VERSION,
      kind: "failure",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
