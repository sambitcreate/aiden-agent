import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Wire contract shared with native/cua-s1-forms Protocol.swift. */
export const FORM_FILL_HELPER_PROTOCOL_VERSION = 1;
export const FORM_FILL_HELPER_APP_NAME = "Aiden CUA-S1 Forms Helper.app";
export const FORM_FILL_HELPER_EXECUTABLE = "aiden-cua-s1-forms-helper";

export const FORM_FILL_MAX_REQUEST_BYTES = 262_144;
export const FORM_FILL_MAX_RESPONSE_BYTES = 262_144;
export const FORM_FILL_MAX_TEXT_BYTES = 8_192;
export const FORM_FILL_MAX_OPTIONS = 32;
export const FORM_FILL_MIN_OPTIONS = 2;

export const FORM_FILL_LOAD_TIMEOUT_MS = 120_000;
export const FORM_FILL_COMPILE_TIMEOUT_MS = 180_000;
export const FORM_FILL_SCORE_TIMEOUT_MS = 30_000;

export type FormFillHelperErrorCode =
  | "invalid_request"
  | "unsupported_protocol"
  | "model_not_loaded"
  | "invalid_model"
  | "invalid_output"
  | "artifact_unavailable"
  | "cancelled"
  | "internal_failure"
  | "unavailable"
  | "timeout"
  | "transport";

export class FormFillHelperError extends Error {
  constructor(
    readonly code: FormFillHelperErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FormFillHelperError";
  }
}

export interface FormFillScoreResult {
  selectedIndex: number;
  probabilities: number[];
  rawProbabilities: number[];
  logits: number[];
  contextWasTruncated: boolean;
  truncatedOptionIndices: number[];
}

export interface FormFillHelperPaths {
  /** `.app` bundle containing the executable. */
  appBundle: string;
  /** Executable inside the bundle. */
  executable: string;
}

export function formFillHelperPaths(helpersDir: string): FormFillHelperPaths {
  const appBundle = path.join(helpersDir, FORM_FILL_HELPER_APP_NAME);
  return {
    appBundle,
    executable: path.join(appBundle, "Contents", "MacOS", FORM_FILL_HELPER_EXECUTABLE),
  };
}

const ERROR_CODES: ReadonlySet<string> = new Set<FormFillHelperErrorCode>([
  "invalid_request",
  "unsupported_protocol",
  "model_not_loaded",
  "invalid_model",
  "invalid_output",
  "artifact_unavailable",
  "cancelled",
  "internal_failure",
]);

const METHODS = new Set(["load", "score", "compile", "shutdown"]);

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Warm persistent client for the CUA-S1 forms helper: one spawned process with
 * a JSON-lines stdin/stdout protocol. A crashed or malformed transport poisons
 * the client; callers retry once via `withRestart`.
 */
export class FormFillHelperClient {
  private process: ChildProcess | null = null;
  private stdout = "";
  private pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private poisoned = false;
  private loadedModel: string | null = null;

  constructor(
    private readonly deps: {
      paths?: FormFillHelperPaths;
      pathsResolver?: () => FormFillHelperPaths;
      spawnImpl?: typeof spawn;
      now?: () => number;
    } = {},
  ) {}

  get loadedPath(): string | null {
    return this.loadedModel;
  }

  /** Eagerly spawn if needed; returns immediately (load happens via request). */
  private ensureProcess(): ChildProcess {
    if (this.process && !this.poisoned) return this.process;
    this.teardownProcess();
    const paths = this.deps.paths ?? this.deps.pathsResolver?.();
    if (!paths) {
      throw new FormFillHelperError(
        "unavailable",
        "The on-device form-fill helper path is not configured.",
      );
    }
    if (!fs.existsSync(paths.executable)) {
      throw new FormFillHelperError(
        "unavailable",
        "The on-device form-fill helper is not installed.",
      );
    }
    const spawnImpl = this.deps.spawnImpl ?? spawn;
    const child = spawnImpl(paths.executable, [], {
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME ?? "",
        LANG: process.env.LANG ?? "en_US.UTF-8",
        TMPDIR: process.env.TMPDIR ?? "",
        __CF_USER_TEXT_ENCODING: process.env.__CF_USER_TEXT_ENCODING ?? "",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.on("error", () => this.failTransport("The form-fill helper could not start."));
    child.on("exit", () => this.failTransport("The form-fill helper exited unexpectedly."));
    this.process = child;
    return child;
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    if (this.stdout.length > FORM_FILL_MAX_RESPONSE_BYTES) {
      this.failTransport("The form-fill helper produced an oversized response.");
      return;
    }
    let index = this.stdout.indexOf("\n");
    while (index >= 0) {
      const line = this.stdout.slice(0, index);
      this.stdout = this.stdout.slice(index + 1);
      index = this.stdout.indexOf("\n");
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.failTransport("The form-fill helper produced malformed output.");
        return;
      }
      this.deliver(parsed);
    }
  }

  private deliver(message: unknown): void {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { version?: unknown }).version !== FORM_FILL_HELPER_PROTOCOL_VERSION ||
      typeof (message as { id?: unknown }).id !== "string"
    ) {
      this.failTransport("The form-fill helper produced an invalid response.");
      return;
    }
    const response = message as {
      id: string;
      ok?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    const pending = this.pending.get(response.id);
    if (!pending) return; // stale/unknown id — ignore, do not poison
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok === true && typeof response.result === "object" && response.result !== null) {
      pending.resolve(response.result as Record<string, unknown>);
      return;
    }
    const code = response.error?.code;
    const safeCode = (
      typeof code === "string" && ERROR_CODES.has(code) ? code : "internal_failure"
    ) as FormFillHelperErrorCode;
    pending.reject(
      new FormFillHelperError(
        safeCode,
        typeof response.error?.message === "string"
          ? response.error.message.slice(0, 500)
          : "The form-fill helper failed.",
      ),
    );
  }

  private failTransport(message: string): void {
    if (this.poisoned) return;
    this.poisoned = true;
    const error = new FormFillHelperError("transport", message);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.teardownProcess();
  }

  private teardownProcess(): void {
    const child = this.process;
    this.process = null;
    this.loadedModel = null;
    if (child) {
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stdin?.destroy();
      if (!child.killed) child.kill("SIGKILL");
    }
  }

  private request(
    method: "load" | "score" | "compile" | "shutdown",
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
      return Promise.reject(new FormFillHelperError("cancelled", "Request cancelled."));
    }
    let child: ChildProcess;
    try {
      child = this.ensureProcess();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!METHODS.has(method)) {
      return Promise.reject(new FormFillHelperError("invalid_request", "Unknown method."));
    }
    const id = `ff-${++this.nextId}`;
    const body = JSON.stringify({ version: FORM_FILL_HELPER_PROTOCOL_VERSION, id, method, ...params });
    if (Buffer.byteLength(body, "utf8") > FORM_FILL_MAX_REQUEST_BYTES) {
      return Promise.reject(
        new FormFillHelperError("invalid_request", "The form-fill request is too large."),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failTransport("The form-fill helper timed out.");
        reject(new FormFillHelperError("timeout", "The form-fill helper timed out."));
      }, timeoutMs);
      const onAbort = (): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new FormFillHelperError("cancelled", "Request cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        timer,
      });
      child.stdin?.write(`${body}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          this.failTransport("The form-fill helper could not receive the request.");
          reject(new FormFillHelperError("transport", "The form-fill helper closed its input."));
        }
      });
    });
  }

  /** True after a transport failure; callers should recreate the client once. */
  get isPoisoned(): boolean {
    return this.poisoned;
  }

  async loadModel(modelPath: string, signal?: AbortSignal): Promise<string> {
    const result = await this.request(
      "load",
      { modelPath },
      FORM_FILL_LOAD_TIMEOUT_MS,
      signal,
    );
    const loaded = result.load as { loadedPath?: unknown } | undefined;
    if (typeof loaded?.loadedPath !== "string") {
      throw new FormFillHelperError("invalid_output", "The helper returned an invalid load result.");
    }
    this.loadedModel = loaded.loadedPath;
    return loaded.loadedPath;
  }

  async compileModel(
    modelPath: string,
    destinationDirectory: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.request(
      "compile",
      { modelPath, destinationDirectory },
      FORM_FILL_COMPILE_TIMEOUT_MS,
      signal,
    );
    const compiled = result.compile as { compiledPath?: unknown } | undefined;
    if (typeof compiled?.compiledPath !== "string") {
      throw new FormFillHelperError(
        "invalid_output",
        "The helper returned an invalid compile result.",
      );
    }
    return compiled.compiledPath;
  }

  async score(
    context: string,
    options: string[],
    signal?: AbortSignal,
  ): Promise<FormFillScoreResult> {
    if (options.length < FORM_FILL_MIN_OPTIONS || options.length > FORM_FILL_MAX_OPTIONS) {
      throw new FormFillHelperError(
        "invalid_request",
        "The form-fill request must contain between 2 and 32 options.",
      );
    }
    const result = await this.request(
      "score",
      { context, options },
      FORM_FILL_SCORE_TIMEOUT_MS,
      signal,
    );
    return validateScoreResult(result.score);
  }

  async shutdown(): Promise<void> {
    if (!this.process) return;
    try {
      await this.request("shutdown", {}, 5_000);
    } catch {
      // Shutdown failures only matter to the process we then kill anyway.
    } finally {
      this.teardownProcess();
      this.poisoned = false;
    }
  }

  dispose(): void {
    this.failTransport("The form-fill helper was closed.");
    this.poisoned = false;
  }
}

function validateScoreResult(value: unknown): FormFillScoreResult {
  const score = value as Partial<FormFillScoreResult> | undefined;
  const numbers = (list: unknown): list is number[] =>
    Array.isArray(list) && list.length <= FORM_FILL_MAX_OPTIONS &&
    list.every((entry) => typeof entry === "number" && Number.isFinite(entry));
  if (
    !score ||
    typeof score.selectedIndex !== "number" ||
    !Number.isInteger(score.selectedIndex) ||
    score.selectedIndex < 0 ||
    !numbers(score.probabilities) ||
    !numbers(score.rawProbabilities) ||
    !numbers(score.logits) ||
    score.probabilities.length !== score.logits.length ||
    score.rawProbabilities.length !== score.logits.length ||
    typeof score.contextWasTruncated !== "boolean" ||
    !Array.isArray(score.truncatedOptionIndices) ||
    score.truncatedOptionIndices.some(
      (index) => typeof index !== "number" || !Number.isInteger(index),
    )
  ) {
    throw new FormFillHelperError(
      "invalid_output",
      "The helper returned a malformed score result.",
    );
  }
  if (score.selectedIndex >= score.probabilities.length) {
    throw new FormFillHelperError(
      "invalid_output",
      "The helper selected an out-of-range option.",
    );
  }
  if (score.probabilities.some((p) => p < 0 || p > 1)) {
    throw new FormFillHelperError(
      "invalid_output",
      "The helper returned invalid probabilities.",
    );
  }
  return {
    selectedIndex: score.selectedIndex,
    probabilities: score.probabilities,
    rawProbabilities: score.rawProbabilities,
    logits: score.logits,
    contextWasTruncated: score.contextWasTruncated,
    truncatedOptionIndices: score.truncatedOptionIndices,
  };
}
