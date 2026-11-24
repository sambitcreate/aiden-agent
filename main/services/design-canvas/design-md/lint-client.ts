/**
 * Runs the DESIGN.md linter off the main thread (spec S44).
 *
 * One worker per request, started from `build/main/design-md-lint-worker.js`
 * (or `lint-worker.ts` under `tsx`). The worker posts `ready` once the linter
 * has loaded; loading has its own limit, and the lint deadline counts from
 * `ready`, so a slow import never eats into it. At most two workers run at
 * once and sixteen wait; the next request is `busy`. The worker's environment
 * drops the switches that make the bundled `debug` and `yaml` print content.
 */
import { Worker } from "node:worker_threads";

export const DESIGN_MD_LINT_DEADLINE_MS = 2_000;
export const DESIGN_MD_WORKER_LOAD_TIMEOUT_MS = 10_000;
const MAX_RUNNING = 2;
const MAX_WAITING = 16;
const SCRUBBED_ENV = ["DEBUG", "LOG_STREAM", "LOG_TOKENS"] as const;

export type DesignMdExportFormat = "css-tailwind" | "json-tailwind" | "dtcg" | "css-vars";

export type DesignMdWorkerRequest =
  | { op: "lint"; content: string }
  | { op: "export"; content: string; format: DesignMdExportFormat };

export type DesignMdSeverity = "error" | "warning" | "info";
export type DesignMdFinding = { severity: DesignMdSeverity; message: string; rule?: string; path?: string };
export type DesignMdSymbolValue =
  | { kind: "color" | "dimension" | "typography" | "value"; text: string }
  | { unresolved: string };

export type DesignMdLintResult = {
  summary: { errors: number; warnings: number; infos: number };
  findings: DesignMdFinding[];
  sections: string[];
  omitted: { section: string; reason?: string }[];
  symbols: [string, DesignMdSymbolValue][];
  tailwindConfig: unknown;
};

export type DesignMdExportResult = { success: boolean; text?: string; errors?: string[] };

export type LintFailureStatus = "timed-out" | "lint-failed" | "linter-unavailable" | "busy";
/** `cause: "load-timeout"`: the linter didn't load in time, so this run shouldn't try again. */
export type LintOutcome<T = DesignMdLintResult> =
  | { ok: true; result: T }
  | { ok: false; status: LintFailureStatus; cause?: "load-timeout" };

export type RunDesignMdWorkerOptions = {
  deadlineMs?: number;
  loadTimeoutMs?: number;
  signal?: AbortSignal;
  workerUrl?: URL;
  env?: NodeJS.ProcessEnv;
  execArgv?: string[];
  /** Test hooks: when the worker posted `ready`, and anything it printed. */
  onReady?: () => void;
  onOutput?: (text: string) => void;
  /** Where to log that the linter couldn't load, once per run. */
  log?: (message: string) => void;
};

let running = 0;
const waiting: Array<() => void> = [];
let unavailableLogged = false;

const abortError = () => new DOMException("The DESIGN.md check was cancelled.", "AbortError");

/** Waits for one of the two worker slots; `null` means the queue is full. */
function acquire(signal?: AbortSignal): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    const release = () => {
      running--;
      waiting.shift()?.();
    };
    const start = () => {
      signal?.removeEventListener("abort", abort);
      running++;
      resolve(release);
    };
    const abort = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      reject(abortError());
    };
    if (signal?.aborted) return abort();
    if (running < MAX_RUNNING) return start();
    if (waiting.length >= MAX_WAITING) return resolve(null);
    waiting.push(start);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const isTsxImport = (value: string | undefined) =>
  value === "tsx" || (value !== undefined && /[\\/]tsx[\\/]dist[\\/](loader|esm\/index)\.m?js$/.test(value));

/** The parent's own flags, plus `--import tsx` only when no tsx preload is there yet. */
export function withTsx(execArgv: readonly string[]): string[] {
  const present = execArgv.some(
    (arg, index) =>
      (arg === "--import" && isTsxImport(execArgv[index + 1])) ||
      (arg.startsWith("--import=") && isTsxImport(arg.slice("--import=".length))),
  );
  return present ? [...execArgv] : [...execArgv, "--import", "tsx"];
}

function scrubbedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of SCRUBBED_ENV) delete env[name];
  return env;
}

/** What a request's worker answers: lint findings, or an export. */
export type DesignMdWorkerResult<R extends DesignMdWorkerRequest> = R extends { op: "export" }
  ? DesignMdExportResult
  : DesignMdLintResult;

export async function runDesignMdWorker<R extends DesignMdWorkerRequest>(
  request: R,
  options: RunDesignMdWorkerOptions = {},
): Promise<LintOutcome<DesignMdWorkerResult<R>>> {
  const release = await acquire(options.signal);
  if (!release) return { ok: false, status: "busy" };
  try {
    if (options.signal?.aborted) throw abortError();
    return (await executeWorker(request, options)) as LintOutcome<DesignMdWorkerResult<R>>;
  } finally {
    release();
  }
}

function logUnavailableOnce(log: ((message: string) => void) | undefined): void {
  if (unavailableLogged || !log) return;
  unavailableLogged = true;
  log("The DESIGN.md linter couldn't load; DESIGN.md checks are unavailable this run.");
}

function executeWorker(
  request: DesignMdWorkerRequest,
  options: RunDesignMdWorkerOptions,
): Promise<LintOutcome<DesignMdLintResult | DesignMdExportResult>> {
  return new Promise((resolve, reject) => {
    const fromSource = import.meta.url.endsWith(".ts");
    const url =
      options.workerUrl ??
      new URL(fromSource ? "./lint-worker.ts" : "./design-md-lint-worker.js", import.meta.url);
    const execArgv = options.execArgv ?? (fromSource ? withTsx(process.execArgv) : undefined);
    let worker: Worker;
    try {
      worker = new Worker(url, {
        env: scrubbedEnv(options.env ?? process.env),
        resourceLimits: { maxOldGenerationSizeMb: 128 },
        stdout: true,
        stderr: true,
        ...(execArgv ? { execArgv } : {}),
      });
    } catch {
      logUnavailableOnce(options.log);
      resolve({ ok: false, status: "linter-unavailable" });
      return;
    }
    for (const stream of [worker.stdout, worker.stderr]) {
      if (options.onOutput) stream.on("data", (chunk: Buffer) => options.onOutput?.(chunk.toString("utf8")));
      else stream.resume();
    }

    let ready = false;
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (outcome: LintOutcome<DesignMdLintResult | DesignMdExportResult> | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimer);
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      if (!(outcome instanceof Error) && !outcome.ok && outcome.status === "linter-unavailable") {
        logUnavailableOnce(options.log);
      }
      // Free the slot only once the worker has really stopped.
      void worker.terminate().then(
        () => (outcome instanceof Error ? reject(outcome) : resolve(outcome)),
        () => (outcome instanceof Error ? reject(outcome) : resolve(outcome)),
      );
    };
    const abort = () => finish(abortError());
    const loadTimer = setTimeout(
      () => finish({ ok: false, status: "linter-unavailable", cause: "load-timeout" }),
      options.loadTimeoutMs ?? DESIGN_MD_WORKER_LOAD_TIMEOUT_MS,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    worker.on("message", (message: unknown) => {
      if (settled) return;
      const data = message as { ready?: unknown; ok?: unknown; result?: unknown; code?: unknown } | null;
      if (!ready) {
        if (data?.ready !== true) return finish({ ok: false, status: "linter-unavailable" });
        ready = true;
        clearTimeout(loadTimer);
        options.onReady?.();
        deadline = setTimeout(
          () => finish({ ok: false, status: "timed-out" }),
          options.deadlineMs ?? DESIGN_MD_LINT_DEADLINE_MS,
        );
        worker.postMessage(request);
        return;
      }
      if (data?.ok === true && data.result && typeof data.result === "object") {
        finish({ ok: true, result: data.result as DesignMdLintResult | DesignMdExportResult });
      } else {
        finish({ ok: false, status: "lint-failed" });
      }
    });
    worker.on("error", () =>
      finish({ ok: false, status: ready ? "lint-failed" : "linter-unavailable" }),
    );
    worker.on("exit", () => finish({ ok: false, status: "linter-unavailable" }));
  });
}
