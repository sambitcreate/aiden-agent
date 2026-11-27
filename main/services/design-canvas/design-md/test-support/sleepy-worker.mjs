/* global setTimeout */
// A worker that posts ready, then answers each request after a short sleep.
import { parentPort } from "node:worker_threads";

parentPort.postMessage({ ready: true });
parentPort.on("message", () => {
  setTimeout(() => {
    parentPort.postMessage({
      ok: true,
      result: { summary: { errors: 0, warnings: 0, infos: 0 }, findings: [], sections: [], omitted: [], symbols: [], tailwindConfig: null },
    });
  }, 120);
});
