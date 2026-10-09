import { parentPort } from "node:worker_threads";
import { replyToWorkerFrame } from "../../../main/services/local-speech-worker-core.js";

if (!parentPort) throw new Error("Speech worker requires a parent port.");
const port = parentPort;
port.on("message", (message: unknown) => {
  void replyToWorkerFrame(message).then((reply) => {
    if (reply) port.postMessage(reply);
  });
});
