import { pcmToFloat32 } from "../handlers/voice-codec.js";
import { decodeAidenRemotePcm16 } from "./aiden-remote-speech-codec.js";
import { engineStatus, releaseRecognizer, transcribePcm } from "./parakeet-engine.js";
import {
  isParakeetParentMessage,
  PARAKEET_PROTOCOL_VERSION,
} from "./parakeet-protocol.js";

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
      const status = engineStatus();
      post({
        version: PARAKEET_PROTOCOL_VERSION,
        kind: "result",
        requestId: message.requestId,
        ready: status.ready,
        error: status.error,
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
