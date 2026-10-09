/**
 * One supervised ACP agent process.
 *
 * Adapted from pi-antigravity-acp-provider src/acp/process.ts @ 07e369b (MIT)
 * and T3 Code apps/server/src/provider/acp/AcpSessionRuntime.ts @ f870c419fc
 * (MIT). Aiden spawns the agent directly; packaged builds cannot run Electron
 * as Node, so there is no supervisor process. On POSIX the agent leads its own
 * process group, and shutdown signals the whole group so tool grandchildren
 * die with it. Crash leftovers are handled by the pid ledger on next launch.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { Writable } from "node:stream";

import { AcpHarnessError, redactSecrets } from "./errors.js";

const STDERR_TAIL_BYTES = 16 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const TERM_GRACE_MS = 1_000;
const KILL_GRACE_MS = 1_500;
let nextGeneration = 1;

export interface AcpProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

export interface AcpProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** Sees each complete stderr line before it is redacted into the tail. */
  onStderrLine?: (line: string) => void;
  /** Sees each non-JSON stdout line; such lines never reach the protocol. */
  onStdoutNoise?: (line: string) => void;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number | undefined) => void;
  /** Test seam. */
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
}

export class AcpProcess {
  readonly generation = nextGeneration++;
  readonly input: ReadableStream<Uint8Array>;
  readonly output: WritableStream<Uint8Array>;
  readonly exited: Promise<AcpProcessExit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly platform: NodeJS.Platform;
  private stderr = "";
  private stderrPartial = "";
  private noiseLines = 0;
  private settled = false;
  private closing: Promise<void> | undefined;

  constructor(options: AcpProcessOptions) {
    this.platform = options.platform ?? process.platform;
    let resolveExit!: (exit: AcpProcessExit) => void;
    this.exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const spawnImpl = options.spawnImpl ?? spawn;
    const child = spawnImpl(options.command, [...options.args], {
      cwd: path.resolve(options.cwd),
      env: { ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: this.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    if (child.pid !== undefined) options.onSpawn?.(child.pid);

    const finish = (code: number | null, signal: NodeJS.Signals | null, note?: string) => {
      if (this.settled) return;
      this.settled = true;
      // The leader is gone, but helpers it started may live on in its group.
      // The group id cannot be reused while any member exists.
      if (this.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // ESRCH: nothing left in the group.
        }
      }
      this.flushStderr(options.onStderrLine);
      options.onExit?.(child.pid);
      const tail = note ? `${this.stderr}\n${note}` : this.stderr;
      resolveExit({ code, signal, stderrTail: redactSecrets(tail).slice(-STDERR_TAIL_BYTES) });
    };
    child.once("error", (cause) => finish(null, null, `spawn failed: ${cause.message}`));
    child.once("exit", (code, signal) => finish(code, signal));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.consumeStderr(chunk, options.onStderrLine));
    // A dead agent turns stdin writes into EPIPE; the exit promise reports it.
    child.stdin.on("error", () => undefined);

    let pending: Buffer = Buffer.alloc(0);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.input = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const emitLine = (line: Buffer) => {
      const text = line.toString("utf8").replace(/\r$/u, "");
      if (text.trim().length === 0) return;
      if (text.trimStart().startsWith("{")) {
        controller.enqueue(new Uint8Array(Buffer.from(`${text}\n`, "utf8")));
        return;
      }
      this.noiseLines += 1;
      options.onStdoutNoise?.(text);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let index: number;
      while ((index = pending.indexOf(0x0a)) >= 0) {
        emitLine(pending.subarray(0, index));
        pending = pending.subarray(index + 1);
      }
      if (pending.length > MAX_LINE_BYTES) {
        controller.error(new AcpHarnessError("protocol", "The agent sent an oversized protocol line."));
        void this.close();
      }
    });
    child.stdout.once("end", () => {
      if (pending.length > 0) emitLine(pending);
      pending = Buffer.alloc(0);
      try {
        controller.close();
      } catch {
        // Already errored.
      }
    });
    this.output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.settled && this.child.exitCode === null && this.child.signalCode === null;
  }

  get stderrTail(): string {
    return redactSecrets(this.stderr).slice(-STDERR_TAIL_BYTES);
  }

  get ignoredStdoutLines(): number {
    return this.noiseLines;
  }

  /** Idempotent: TERM the group, then KILL it if the agent ignores TERM. */
  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    if (!this.alive) return;
    this.signal("SIGTERM");
    if (await settlesWithin(this.exited, TERM_GRACE_MS)) return;
    this.signal("SIGKILL");
    await settlesWithin(this.exited, KILL_GRACE_MS);
  }

  private signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    try {
      if (this.platform === "win32" && pid) {
        const args = ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
        spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
        return;
      }
      if (pid) process.kill(-pid, signal);
      else this.child.kill(signal);
    } catch {
      // ESRCH: the group already exited.
      try {
        this.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  private consumeStderr(chunk: string, onLine?: (line: string) => void): void {
    this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_BYTES * 2);
    if (!onLine) return;
    this.stderrPartial += chunk;
    let index: number;
    while ((index = this.stderrPartial.indexOf("\n")) >= 0) {
      const line = this.stderrPartial.slice(0, index).replace(/\r$/u, "");
      this.stderrPartial = this.stderrPartial.slice(index + 1);
      safely(() => onLine(line));
    }
    if (this.stderrPartial.length > 64 * 1024) this.stderrPartial = this.stderrPartial.slice(-64 * 1024);
  }

  private flushStderr(onLine?: (line: string) => void): void {
    if (onLine && this.stderrPartial) safely(() => onLine(this.stderrPartial));
    this.stderrPartial = "";
  }
}

function safely(callback: () => void): void {
  try {
    callback();
  } catch {
    // Observers must not break process bookkeeping.
  }
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
