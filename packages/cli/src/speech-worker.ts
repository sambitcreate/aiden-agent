import { parentPort } from "node:worker_threads";
import { isLocalSpeechParentMessage } from "../../../main/services/local-speech-protocol.js";
import { handleLocalSpeechMessage } from "../../../main/services/local-speech-worker-core.js";

if (!parentPort) throw new Error("Speech worker requires a parent port.");
const port = parentPort;
port.on("message", (message: unknown) => {
  if (!isLocalSpeechParentMessage(message)) return;
  void handleLocalSpeechMessage(message).then((reply) => port.postMessage(reply));
});
