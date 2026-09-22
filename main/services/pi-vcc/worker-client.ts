import { vccErrorMessage, type VccOperation } from "./errors.js";
import { Worker } from "node:worker_threads";
import type { VccRecallInput } from "./recall-core.js";
import type { compileVcc, VccCompileInput } from "./compiler.js";

type WorkerInput = VccCompileInput | VccRecallInput;
type WorkerOutput = ReturnType<typeof compileVcc> | string;
let activeWorkers = 0;
const waiting: Array<() => void> = [];

/** Bound memory across concurrent chats and children; queued work is cancellable. */
function acquireWorker(operation: VccOperation, signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      reject(new DOMException(vccErrorMessage(operation, "cancelled"), "AbortError"));
    };
    const start = () => {
      signal?.removeEventListener("abort", abort);
      activeWorkers++;
      resolve(() => {
        activeWorkers--;
        waiting.shift()?.();
      });
    };
    if (signal?.aborted) return abort();
    if (activeWorkers < 2) return start();
    if (waiting.length >= 32) return reject(new Error(vccErrorMessage(operation, "busy")));
    waiting.push(start);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function compileVccInWorker(
  input: VccCompileInput,
  signal?: AbortSignal,
): Promise<ReturnType<typeof compileVcc>> {
  return runVccWorker(input, signal) as Promise<ReturnType<typeof compileVcc>>;
}

export async function runVccWorker(
  input: WorkerInput,
  signal?: AbortSignal,
): Promise<WorkerOutput> {
  const operation: VccOperation = "kind" in input && input.kind === "recall" ? "recall" : "compile";
  const release = await acquireWorker(operation, signal);
  try {
    if (signal?.aborted)
      throw new DOMException(vccErrorMessage(operation, "cancelled"), "AbortError");
    return await executeWorker(input, operation, signal);
  } finally {
    release();
  }
}

/** Packaged as a separate module; no synchronous compiler fallback on main. */
function executeWorker(
  input: WorkerInput,
  operation: VccOperation,
  signal?: AbortSignal,
): Promise<WorkerOutput> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "../../../build/main/pi-vcc-worker.js"
            : "./pi-vcc-worker.js",
          import.meta.url,
        ),
        {
          workerData: input,
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        },
      );
    } catch {
      reject(new Error(vccErrorMessage(operation, "worker_failed")));
      return;
    }
    let settled = false;
    const finish = (error?: Error, result?: WorkerOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Do not release the slot while a cancelled worker is still running.
      void worker.terminate().then(
        () => {
          if (error) reject(error);
          else resolve(result!);
        },
        () => reject(new Error(vccErrorMessage(operation, "cleanup_failed"))),
      );
    };
    const abort = () =>
      finish(new DOMException(vccErrorMessage(operation, "cancelled"), "AbortError"));
    const timer = setTimeout(
      () => finish(new Error(vccErrorMessage(operation, "timeout"))),
      15_000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.once("message", (message) =>
      message?.ok && message.result
        ? finish(undefined, message.result)
        : finish(new Error(vccErrorMessage(operation, message?.code))),
    );
    worker.once("error", () => finish(new Error(vccErrorMessage(operation, "worker_failed"))));
    worker.once("exit", () => {
      if (!settled) finish(new Error(vccErrorMessage(operation, "worker_exited")));
    });
  });
}
