// A worker that loads, then throws while linting, with text that must never be logged.
import { parentPort } from "node:worker_threads";

parentPort.postMessage({ ready: true });
parentPort.on("message", () => {
  throw new Error("SECRET thrown while linting");
});
