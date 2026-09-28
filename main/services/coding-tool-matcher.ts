import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import {
  CODING_GLOB_WORKER_SOURCE,
  type CodingGlobRequest,
  type CodingGlobReply,
  type CodingGlobTask,
} from "./coding-tool-glob-worker.js";

// Fixed code, with all model input passed as data. Keeping this self-contained
// also works in the packaged Electron main bundle without a worker asset loader.
const SOURCE = (kind: "grep" | "glob") => `
const { parentPort, workerData } = require('node:worker_threads');
try {
${kind === "glob" ? CODING_GLOB_WORKER_SOURCE : "const regex = new RegExp(workerData.pattern);"}
  parentPort.on('message', request => {
    try {
      ${
        kind === "glob"
          ? "parentPort.postMessage({ result: globStep(request) });"
          : `
      const indices = [];
      for (let i = 0; i < request.values.length && indices.length < request.limit; i++) {
        if (regex.test(request.values[i])) indices.push(i);
      }
      parentPort.postMessage({ result: indices });`
      }
    } catch(error) { parentPort.postMessage({ error: error.message }); }
  });
  parentPort.postMessage({ result: ${kind === "glob" ? "seeds" : "[]"} });
} catch (error) { parentPort.postMessage({ error: error.message }); }
`;

export function withCodingToolMatcher<T>(
  kind: "grep",
  pattern: string,
  deadline: number,
  signal: AbortSignal | undefined,
  run: (match: (values: string[], limit: number) => Promise<number[]>) => Promise<T>,
): Promise<T> {
  return withWorker(kind, pattern, deadline, signal, (send) =>
    run((values, limit) => send({ values, limit }) as Promise<number[]>),
  );
}

export function withCodingToolGlob<T>(
  pattern: string,
  deadline: number,
  signal: AbortSignal | undefined,
  run: (
    seeds: CodingGlobTask[],
    step: (request: CodingGlobRequest) => Promise<CodingGlobReply>,
  ) => Promise<T>,
): Promise<T> {
  return withWorker("glob", pattern, deadline, signal, (send, ready) =>
    run(ready as CodingGlobTask[], (request) => send(request) as Promise<CodingGlobReply>),
  );
}

export class CodingToolMatchTimeout extends Error {}
let activeMatchers = 0;

/** One sequential matcher per search; terminated before its capacity is released. */
async function withWorker<T>(
  kind: "grep" | "glob",
  pattern: string,
  deadline: number,
  signal: AbortSignal | undefined,
  run: (send: (request?: unknown) => Promise<unknown>, ready: unknown) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (activeMatchers >= 4) throw new Error("File searches are busy; try again shortly.");
  const worker = new Worker(SOURCE(kind), {
    eval: true,
    execArgv: [],
    workerData: {
      kind,
      pattern,
      minimatchPath:
        kind === "glob" ? createRequire(import.meta.url).resolve("minimatch") : undefined,
    },
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
  const receive = (request?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (failure) return reject(failure);
      if (signal?.aborted) return reject(signal.reason ?? new Error("File search cancelled."));
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reject(new CodingToolMatchTimeout());
      const finish = (error?: Error, result?: unknown) => {
        clearTimeout(timer);
        worker.off("message", message);
        signal?.removeEventListener("abort", abort);
        rejectPending = undefined;
        if (error) reject(error);
        else resolve(result);
      };
      const abort = () => finish(signal?.reason ?? new Error("File search cancelled."));
      const message = (reply: { error?: string; result: unknown }) =>
        finish(
          reply.error
            ? new Error(
                `Invalid ${kind === "grep" ? "regular expression" : "glob"}: ${reply.error}`,
              )
            : undefined,
          reply.result,
        );
      const timer = setTimeout(() => finish(new CodingToolMatchTimeout()), remaining);
      rejectPending = (error) => finish(error);
      worker.once("message", message);
      signal?.addEventListener("abort", abort, { once: true });
      if (request) worker.postMessage(request);
    });
  try {
    const ready = await receive();
    return await run(receive, ready);
  } finally {
    await worker.terminate();
    activeMatchers--;
  }
}
