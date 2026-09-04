import { Worker } from "node:worker_threads";
import type { VccRecallInput } from "./recall-core.js";
import type { compileVcc, VccCompileInput } from "./compiler.js";

type WorkerInput = VccCompileInput | VccRecallInput;
type WorkerOutput = ReturnType<typeof compileVcc> | string;
let activeWorkers = 0;
const waiting: Array<() => void> = [];

/** Bound memory across concurrent chats and children; queued work is cancellable. */
function acquireWorker(signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      reject(new DOMException("Compaction cancelled.", "AbortError"));
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
    if (waiting.length >= 32)
      return reject(new Error("Local compaction is busy. Try again shortly."));
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
  const release = await acquireWorker(signal);
  try {
    if (signal?.aborted) throw new DOMException("Compaction cancelled.", "AbortError");
    return await executeWorker(input, signal);
  } finally {
    release();
  }
}

/** Packaged as a separate module; no synchronous compiler fallback on main. */
function executeWorker(input: WorkerInput, signal?: AbortSignal): Promise<WorkerOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
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
        () => reject(new Error("VCC worker cleanup failed.")),
      );
    };
    const abort = () => finish(new DOMException("Compaction cancelled.", "AbortError"));
    const timer = setTimeout(() => finish(new Error("VCC compilation timed out.")), 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.once("message", (message) =>
      message?.ok && message.result
        ? finish(undefined, message.result)
        : finish(
            new Error(
              "VCC could not reduce context safely. Try /compact-LLM or a larger-context model.",
            ),
          ),
    );
    worker.once("error", () => finish(new Error("VCC compilation worker failed.")));
    worker.once("exit", () => {
      if (!settled) finish(new Error("VCC compilation worker exited."));
    });
  });
}
