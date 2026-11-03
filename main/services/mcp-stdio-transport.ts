// Stdio MCP transport that owns its server's whole process tree. Pi's
// StdioTransport starts the server in its own process group on POSIX and
// signals that group when Aiden closes the transport. A wrapper (`npx`,
// `uvx`) that exits on its own can still leave the real server (a
// grandchild) running, so this transport also terminates the group whenever
// the server's pipes close, and on Aiden's exit. Close is bounded even when
// a process outside the group holds the server's stdout.
import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { StdioTransport, type McpTransport, type StdioTransportOptions } from "@earendil-works/pi-mcp";

export interface McpStdioTransportOptions {
  command: string;
  args?: readonly string[];
  /** The server's declared environment, layered over a safe default set. */
  env?: Record<string, string>;
  cwd?: string;
  maxBufferSize?: number;
  /** Wait after closing stdin, and again after SIGTERM, before escalating. */
  closeGraceMs?: number;
  /**
   * `inherit` (default) forwards the server's stderr to Aiden's; `pipe` keeps
   * a bounded tail in the transport instead (the CLI's TUI owns the terminal).
   */
  stderr?: "inherit" | "pipe";
}

const DEFAULT_CLOSE_GRACE_MS = 2_000;
const liveGroups = new Set<number>();
const groupListeners = new Set<(groups: readonly number[]) => void>();
let exitHookInstalled = false;

function groupsChanged(): void {
  const groups = [...liveGroups];
  for (const listener of groupListeners) listener(groups);
}

/**
 * Reports the process groups of this process's live stdio servers now and on
 * every change, so an owner that can be SIGKILLed (which skips the exit hook)
 * can publish them for whoever force-stops it. Returns an unsubscribe.
 */
export function watchMcpProcessGroups(listener: (groups: readonly number[]) => void): () => void {
  groupListeners.add(listener);
  listener([...liveGroups]);
  return () => { groupListeners.delete(listener); };
}

/** The environment every stdio server may see, matching the MCP SDK's default set. */
const DEFAULT_INHERITED_ENV_VARS = process.platform === "win32"
  ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"]
  : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

/**
 * Safe default environment for a spawned MCP server: login identity, PATH
 * and terminal basics only, never Aiden's tokens or proxy secrets. Values
 * that look like exported shell functions are skipped.
 */
export function defaultMcpStdioEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = process.env[key];
    if (value === undefined || value.startsWith("()")) continue;
    env[key] = value;
  }
  return env;
}

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

function settlesWithin(operation: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void operation.then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(true); },
    );
  });
}

const OVERSIZED_MESSAGE = /^MCP stdio message exceeds \d+ bytes$/u;

/**
 * Pi's stdio transport with Aiden's lifecycle guarantees: close never waits
 * forever, an oversized message ends the connection, and on POSIX the
 * server's whole process group is reaped.
 */
class AidenStdioTransport extends StdioTransport {
  private groupPid?: number;
  /** Set once the process group's teardown has begun; it runs exactly once. */
  private groupReaped = false;

  constructor(
    options: StdioTransportOptions,
    private readonly graceMs: number,
    private readonly processGroups: boolean,
  ) {
    super(options);
    // Every pipe is closed, so nothing left in the group can reach Aiden. A
    // wrapper that exited on its own may still have left its server there.
    this.onClose(() => this.reapGroup());
    // Pi drops an oversized line but keeps the connection, so a request it
    // answered would wait out its whole timeout. Close instead: pending
    // requests fail at once.
    this.onError((error) => {
      if (OVERSIZED_MESSAGE.test(error.message)) void this.close().catch(() => undefined);
    });
  }

  override async start(): Promise<void> {
    await super.start();
    const pid = this.pid;
    if (pid === undefined || !this.processGroups) return;
    this.groupPid = pid;
    installExitHook();
    liveGroups.add(pid);
    groupsChanged();
  }

  /**
   * Pi waits for the child's pipes to close. A process outside the group (a
   * `setsid` grandchild) that inherited stdout would hold them open forever,
   * so after twice the grace the pipes are destroyed and the server killed.
   */
  override async close(): Promise<void> {
    const closing = super.close();
    if (!(await settlesWithin(closing, 2 * this.graceMs))) {
      // Pi keeps the child private; only its pipes and process are touched.
      const child = (this as unknown as { child?: ChildProcess }).child;
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      if (this.groupPid !== undefined) signalGroup(this.groupPid, "SIGKILL");
      else child?.kill("SIGKILL");
      await settlesWithin(closing, this.graceMs);
    }
    // A wrapper that already exited while its server holds the pipes never
    // reports a pipe close; the group is still reaped here.
    this.reapGroup();
  }

  /** Terminate whatever remains of the group, then forget it: SIGTERM, then SIGKILL after the grace. */
  private reapGroup(): void {
    const pid = this.groupPid;
    if (pid === undefined || this.groupReaped) return;
    this.groupReaped = true;
    signalGroup(pid, "SIGTERM");
    const straggler = setTimeout(() => {
      signalGroup(pid, "SIGKILL");
      if (liveGroups.delete(pid)) groupsChanged();
    }, this.graceMs);
    straggler.unref?.();
  }
}

/**
 * Stdio transport for a configured server. The child receives only the safe
 * default environment (HOME, LOGNAME, PATH, SHELL, TERM, USER on POSIX) plus
 * the server's declared `env`, never Aiden's whole environment. On Windows,
 * Pi's transport runs `.cmd` shims through cross-spawn and ends the tree with
 * `taskkill /T`.
 */
export function createMcpStdioTransport(options: McpStdioTransportOptions): McpTransport {
  const graceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const transportOptions: StdioTransportOptions = {
    command: options.command,
    args: [...(options.args ?? [])],
    env: { ...defaultMcpStdioEnvironment(), ...options.env },
    inheritEnv: false,
    cwd: options.cwd,
    stderr: options.stderr ?? "inherit",
    ...(options.maxBufferSize === undefined ? {} : { maxMessageBytes: options.maxBufferSize }),
    closeTimeoutMs: graceMs,
  };
  return new AidenStdioTransport(transportOptions, graceMs, process.platform !== "win32");
}
