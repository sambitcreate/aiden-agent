import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { terminateDirectChild } from "../computer-use/process.js";
import { BotComputerError } from "./types.js";

export interface BoundedProcessOptions {
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Bytes kept from stdout; more is dropped (`truncate`) or ends the child (`fail`). */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  overflow?: "truncate" | "fail";
  /** Written to the child's stdin, which is then closed. Secrets go here, never in argv. */
  stdin?: string;
  /** A local file streamed to the child's stdin instead (a binary copied into a guest). */
  stdinFile?: string;
  cwd?: string;
  /** Called once the executable has started; never when it couldn't be started at all. */
  onSpawn?: () => void;
  /**
   * A cancel ends the child with SIGKILL at once, rather than TERM and then KILL, so it runs
   * nothing more even if it handles TERM: for Lume's `run` when Aiden quits.
   */
  killOnAbort?: boolean;
}

export interface BoundedProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

const DEFAULT_MAX_STDOUT = 1024 * 1024;
const DEFAULT_MAX_STDERR = 64 * 1024;

/**
 * Run one fixed executable with no shell, an exact environment and bounded
 * output. Timeouts end the direct child (TERM, then KILL) and are reported in
 * the result; cancellation rejects. The child gets no process group, so a late
 * signal can never reach a reused PGID.
 */
export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new BotComputerError("cancelled", "The request was cancelled."));
  }
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const maxStderr = options.maxStderrBytes ?? DEFAULT_MAX_STDERR;
  const overflow = options.overflow ?? "fail";
  return new Promise<BoundedProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: false,
      env: options.env,
      shell: false,
      stdio: [options.stdin === undefined && options.stdinFile === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (options.onSpawn) child.once("spawn", options.onSpawn);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let failure: Error | undefined;
    let terminating: Promise<void> | undefined;
    let settled = false;

    const settle = (result: BoundedProcessResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const terminate = () => {
      terminating ??= terminateDirectChild(child).catch(() => undefined);
      return terminating;
    };
    const onAbort = () => {
      failure ??= new BotComputerError("cancelled", "The request was cancelled.");
      if (options.killOnAbort) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      void terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (chunks: Buffer[], chunk: Buffer, used: number, limit: number): number => {
      if (used >= limit) {
        truncated = true;
        return used + chunk.byteLength;
      }
      const room = limit - used;
      if (chunk.byteLength > room) {
        chunks.push(chunk.subarray(0, room));
        truncated = true;
      } else {
        chunks.push(chunk);
      }
      return used + chunk.byteLength;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes, maxStdout);
      if (truncated && overflow === "fail") {
        failure ??= new BotComputerError("lume_failed", "The helper returned too much output.");
        void terminate();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes = collect(stderr, chunk, stderrBytes, maxStderr);
      if (truncated && overflow === "fail") {
        failure ??= new BotComputerError("lume_failed", "The helper returned too much diagnostic output.");
        void terminate();
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(
        new BotComputerError(
          "lume_failed",
          error.code === "ENOENT" ? `${command} is missing.` : `${command} could not start.`,
        ),
      );
    });
    child.on("close", (exitCode, signal) => {
      void (terminating ?? Promise.resolve()).then(() => {
        if (failure) {
          settle(failure);
          return;
        }
        settle({
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          truncated,
          timedOut,
        });
      });
    });
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin);
    } else if (options.stdinFile !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      const source = createReadStream(options.stdinFile);
      source.once("error", () => {
        failure ??= new BotComputerError("invalid", "The file to copy can't be read.");
        void terminate();
      });
      source.pipe(child.stdin);
    }
    if (options.signal?.aborted) onAbort();
  });
}
