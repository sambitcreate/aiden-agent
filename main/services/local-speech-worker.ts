// Electron utility-process entry for on-device speech recognition.

import { isLocalSpeechParentMessage } from "./local-speech-protocol.js";
import { handleLocalSpeechMessage } from "./local-speech-worker-core.js";

const parentPort = (
  process as NodeJS.Process & {
    parentPort?: {
      postMessage: (message: unknown) => void;
      on: (event: "message", listener: (event: { data: unknown }) => void) => void;
    };
  }
).parentPort;
if (!parentPort) throw new Error("On-device transcription worker requires an Electron parent port.");

parentPort.on("message", (event) => {
  const message = event.data;
  if (!isLocalSpeechParentMessage(message)) return;
  void handleLocalSpeechMessage(message).then((reply) => parentPort.postMessage(reply));
});
