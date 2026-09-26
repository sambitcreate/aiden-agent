import { parentPort } from "node:worker_threads";
import { engineStatus, releaseRecognizer, transcribePcm } from "../../../main/services/parakeet-engine.js";
import { decodeAidenRemotePcm16 } from "../../../main/services/aiden-remote-speech-codec.js";
import { isParakeetParentMessage, PARAKEET_PROTOCOL_VERSION } from "../../../main/services/parakeet-protocol.js";

if (!parentPort) throw new Error("Speech worker requires a parent port.");
parentPort.on("message", (message: unknown) => {
  if (!isParakeetParentMessage(message)) return;
  try {
    let result: object = {};
    if (message.kind === "status") result = engineStatus();
    else if (message.kind === "release") releaseRecognizer(message.modelId);
    else {
      if (message.encoding !== "pcm_s16le") throw new Error("CLI speech accepts PCM16 only.");
      result = { text: transcribePcm(decodeAidenRemotePcm16(message.pcmBase64), message.modelId, message.modelDirectory) };
    }
    parentPort!.postMessage({ version: PARAKEET_PROTOCOL_VERSION, kind: "result", requestId: message.requestId, ...result });
  } catch (error) {
    parentPort!.postMessage({ version: PARAKEET_PROTOCOL_VERSION, kind: "failure", requestId: message.requestId, message: error instanceof Error ? error.message : String(error) });
  }
});
