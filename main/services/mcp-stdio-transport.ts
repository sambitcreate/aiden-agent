// Stdio MCP transport that owns its server's whole process tree. The SDK's
// StdioClientTransport spawns the server in Aiden's own process group and on
// close signals only that direct child, so `npx`/`uvx` wrappers leave the real
// server (a grandchild) running. On POSIX this transport starts the server in
// a new process group and signals the group; message framing is the SDK's.
import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export interface McpStdioTransportOptions {
  command: string;
  args?: readonly string[];
  /** The server's declared environment, layered over the SDK's safe default set. */
  env?: Record<string, string>;
  cwd?: string;
  maxBufferSize?: number;
  /** Wait after closing stdin, and again after SIGTERM, before escalating. */
  closeGraceMs?: number;
}

const DEFAULT_CLOSE_GRACE_MS = 2_000;
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: every member of the group has already exited.
  }
}

/** Last resort if Aiden exits without closing a server (closes are async). */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const pid of liveGroups) signalGroup(pid, "SIGTERM");
  });
}

function settlesWithin(operation: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void operation.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

class ProcessGroupStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcess;
  private started = false;
  /** Set once the process group's teardown has begun; it runs exactly once. */
  private groupReaped = false;
  private readonly readBuffer: ReadBuffer;

  constructor(private readonly options: McpStdioTransportOptions) {
    this.readBuffer = new ReadBuffer({ maxBufferSize: options.maxBufferSize });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<void> {
    if (this.started) throw new Error("MCP stdio transport already started.");
    this.started = true;
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, [...(this.options.args ?? [])], {
        env: { ...getDefaultEnvironment(), ...this.options.env },
        stdio: ["pipe", "pipe", "inherit"],
        shell: false,
        cwd: this.options.cwd,
        // Leader of a new process group: close can then reach grandchildren.
        detached: true,
      });
      this.child = child;
      const pid = child.pid;
      if (pid !== undefined) {
        installExitHook();
        liveGroups.add(pid);
      }
      child.on("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.on("spawn", () => resolve());
      child.on("close", () => {
        if (this.child === child) this.child = undefined;
        // Every pipe is closed, so nothing left in the group can reach Aiden.
        // A wrapper that exited on its own may still have left its server there.
        if (pid !== undefined) this.reapGroup(pid);
        this.onclose?.();
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.readBuffer.append(chunk);
          this.processReadBuffer();
        } catch (error) {
          this.onerror?.(error as Error);
          void this.close().catch(() => undefined);
        }
      });
      child.stdout?.on("error", (error) => this.onerror?.(error));
    });
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error as Error);
      }
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin) {
        reject(new Error("Not connected"));
        return;
      }
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.readBuffer.clear();
    const pid = child?.pid;
    if (!child || pid === undefined) return;
    const grace = this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", () => resolve());
    });
    // Spec shutdown: close stdin and let the server exit, then SIGTERM, then SIGKILL.
    try { child.stdin?.end(); } catch { /* already closed */ }
    if (!await settlesWithin(exited, grace)) {
      signalGroup(pid, "SIGTERM");
      if (!await settlesWithin(exited, grace)) signalGroup(pid, "SIGKILL");
    }
    this.reapGroup(pid);
  }

  /** Terminate whatever remains of the group, then forget it: SIGTERM, then SIGKILL after the grace. */
  private reapGroup(pid: number): void {
    if (this.groupReaped) return;
    this.groupReaped = true;
    signalGroup(pid, "SIGTERM");
    const straggler = setTimeout(() => {
      signalGroup(pid, "SIGKILL");
      liveGroups.delete(pid);
    }, this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS);
    straggler.unref?.();
  }
}

/**
 * Stdio transport for a configured server. The child receives only the SDK's
 * default environment (HOME, LOGNAME, PATH, SHELL, TERM, USER on POSIX) plus
 * the server's declared `env`, never Aiden's whole environment. Windows keeps
 * the SDK transport, which runs `.cmd` shims through cross-spawn.
 */
export function createMcpStdioTransport(options: McpStdioTransportOptions): Transport {
  if (process.platform === "win32") {
    return new StdioClientTransport({
      command: options.command,
      args: [...(options.args ?? [])],
      // The pinned SDK already layers env over its defaults; spell it out so
      // this contract does not depend on SDK internals.
      env: { ...getDefaultEnvironment(), ...options.env },
      cwd: options.cwd,
      maxBufferSize: options.maxBufferSize,
    });
  }
  return new ProcessGroupStdioTransport(options);
}
