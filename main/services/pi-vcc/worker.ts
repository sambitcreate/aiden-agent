import { recallVcc, type VccRecallInput } from "./recall-core.js";
import { parentPort, workerData } from "node:worker_threads";
import { compileVcc, type VccCompileInput } from "./compiler.js";
try {
  parentPort?.postMessage({
    ok: true,
    result:
      workerData.kind === "recall"
        ? recallVcc(workerData as VccRecallInput)
        : compileVcc(workerData as VccCompileInput),
  });
} catch {
  parentPort?.postMessage({ ok: false });
}
