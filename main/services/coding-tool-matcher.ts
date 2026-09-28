import { Worker } from "node:worker_threads";

// Fixed code, with all model input passed as data. Keeping this self-contained
// also works in the packaged Electron main bundle without a worker asset loader.
const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { matchesGlob } = require('node:path');
try {
  const regex = workerData.kind === 'grep' ? new RegExp(workerData.pattern) : null;
  parentPort.on('message', ({ values, limit }) => {
    const indices = [];
    for (let i = 0; i < values.length && indices.length < limit; i++) {
      if (regex ? regex.test(values[i]) : matchesGlob(values[i], workerData.pattern)) indices.push(i);
    }
    parentPort.postMessage({ indices });
  });
  parentPort.postMessage({ indices: [] });
} catch (error) { parentPort.postMessage({ error: error.message }); }
`;

export class CodingToolMatchTimeout extends Error {}
let activeMatchers = 0;

/** One sequential matcher per search; terminated before its capacity is released. */
export async function withCodingToolMatcher<T>(
  kind: "grep" | "glob",
  pattern: string,
  deadline: number,
  signal: AbortSignal | undefined,
  run: (match: (values: string[], limit: number) => Promise<number[]>) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (activeMatchers >= 4) throw new Error("File searches are busy; try again shortly.");
  const worker = new Worker(SOURCE, {
    eval: true,
    execArgv: [],
    workerData: { kind, pattern },
    resourceLimits: { maxOldGenerationSizeMb: 32 },
  });
  activeMatchers++;
  let failure: Error | undefined;
  let rejectPending: ((error: Error) => void) | undefined;
  const failed = (error: Error) => {
    failure = error;
    rejectPending?.(error);
  };
  worker.on("error", failed);
  worker.on("exit", () => failed(new Error("File search matcher exited.")));
  const receive = (values?: string[], limit = 0) =>
    new Promise<number[]>((resolve, reject) => {
      if (failure) return reject(failure);
      if (signal?.aborted) return reject(signal.reason ?? new Error("File search cancelled."));
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reject(new CodingToolMatchTimeout());
      const finish = (error?: Error, indices?: number[]) => {
        clearTimeout(timer);
        worker.off("message", message);
        signal?.removeEventListener("abort", abort);
        rejectPending = undefined;
        if (error) reject(error);
        else resolve(indices!);
      };
      const abort = () => finish(signal?.reason ?? new Error("File search cancelled."));
      const message = (reply: { error?: string; indices: number[] }) =>
        finish(
          reply.error
            ? new Error(
                `Invalid ${kind === "grep" ? "regular expression" : "glob"}: ${reply.error}`,
              )
            : undefined,
          reply.indices,
        );
      const timer = setTimeout(() => finish(new CodingToolMatchTimeout()), remaining);
      rejectPending = (error) => finish(error);
      worker.once("message", message);
      signal?.addEventListener("abort", abort, { once: true });
      if (values) worker.postMessage({ values, limit });
    });
  try {
    await receive();
    return await run(receive);
  } finally {
    try {
      await worker.terminate();
    } finally {
      activeMatchers--;
    }
  }
}
