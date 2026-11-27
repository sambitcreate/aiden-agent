// A worker that tries http.request before it posts ready, then answers like
// the real one. The offline test's positive control: the trap must log it.
import http from "node:http";
import { parentPort } from "node:worker_threads";

try {
  http.request("http://127.0.0.1:9/").end();
} catch {
  // The trap throws; the worker carries on.
}
parentPort.postMessage({ ready: true });
parentPort.on("message", () => {
  parentPort.postMessage({
    ok: true,
    result: { summary: { errors: 0, warnings: 0, infos: 0 }, findings: [], sections: [], omitted: [], symbols: [], tailwindConfig: null },
  });
});
