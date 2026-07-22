import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import path from "node:path";
import {
  CUA_DRIVER_HOST_BUNDLE_ID,
  CUA_DRIVER_TOOL_SCHEMA,
  CUA_DRIVER_VERSION,
  CuaDriverError,
  type CuaDriverInvocation,
  type CuaDriverManifest,
  buildCuaDriverEnvironment,
} from "./contract.js";
import { verifyCuaDriverBridgeProcess } from "./binary.js";
import { runCuaDriverCommand, terminateDirectChild } from "./process.js";
import { CuaDriverSession } from "./session.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const MAX_BRIDGE_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_READY_BYTES = 64 * 1024;

export interface CuaDriverHostOptions {
  invocation: CuaDriverInvocation;
  baseEnv?: NodeJS.ProcessEnv;
  tempRoot?: string;
  startupTimeoutMs?: number;
  removeDirectory?: typeof rm;
  broker: {
    appPath: string;
  };
}

interface SessionRuntime {
  bridge: ChildProcess;
  brokerLauncher: ChildProcess | null;
  tempDirectory: string;
  session: CuaDriverSession | null;
  diagnostic: string;
  cleanupPromise: Promise<void> | null;
  stopping: boolean;
}

function startupTimeoutError(): CuaDriverError {
  return new CuaDriverError(
    "startup_timeout",
    "Aiden Computer Use did not finish starting in time.",
    true,
  );
}

function abortError(signal?: AbortSignal): CuaDriverError {
  return signal?.reason instanceof CuaDriverError
    ? signal.reason
    : new CuaDriverError("cancelled", "Computer Use startup was cancelled.");
}

function remainingMilliseconds(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw startupTimeoutError();
  return Math.max(1, remaining);
}

async function readBridgeReady(
  child: ChildProcess,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  const readyPipe = child.stdio[4] as Readable | null;
  if (!readyPipe || typeof readyPipe.on !== "function") {
    throw new CuaDriverError("bridge_invalid", "Computer Use readiness is unavailable.");
  }
  return new Promise((resolve, reject) => {
    let input: Buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      readyPipe.removeListener("data", data);
      readyPipe.removeListener("error", failed);
      readyPipe.removeListener("close", closed);
      child.removeListener("error", failed);
      child.removeListener("close", childClosed);
      readyPipe.destroy();
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => finish(abortError(signal));
    const failed = () =>
      finish(new CuaDriverError("bridge_failed", "Aiden Computer Use could not start.", true));
    const closed = () =>
      finish(
        new CuaDriverError(
          "bridge_closed",
          "Aiden Computer Use closed its readiness channel before startup.",
          true,
        ),
      );
    const childClosed = () =>
      finish(
        new CuaDriverError("bridge_closed", "Aiden Computer Use exited during startup.", true),
      );
    const data = (chunk: Buffer) => {
      input = input.length === 0 ? chunk : Buffer.concat([input, chunk]);
      if (input.length > MAX_READY_BYTES) {
        finish(new CuaDriverError("bridge_invalid", "Computer Use returned too much startup data."));
        return;
      }
      const newline = input.indexOf(0x0a);
      if (newline < 0) return;
      if (input.subarray(newline + 1).some((byte) => ![0x0a, 0x0d, 0x20, 0x09].includes(byte))) {
        finish(new CuaDriverError("bridge_invalid", "Computer Use returned invalid startup data."));
        return;
      }
      try {
        const value = JSON.parse(input.toString("utf8", 0, newline)) as Record<string, unknown>;
        if (
          value.type !== "ready" ||
          value.protocolVersion !== 2 ||
          Object.keys(value).some((key) => key !== "type" && key !== "protocolVersion")
        ) {
          throw new Error("invalid readiness");
        }
        finish();
      } catch {
        finish(new CuaDriverError("bridge_invalid", "Computer Use returned invalid startup data."));
      }
    };
    const timer = setTimeout(
      () =>
        finish(startupTimeoutError()),
      remainingMilliseconds(deadline),
    );
    timer.unref();
    signal?.addEventListener("abort", aborted, { once: true });
    readyPipe.on("data", data);
    readyPipe.once("error", failed);
    readyPipe.once("close", closed);
    child.once("error", failed);
    child.once("close", childClosed);
    if (signal?.aborted) aborted();
  });
}

export class CuaDriverHost {
  private readonly env: Record<string, string>;
  private manifest: CuaDriverManifest | null = null;
  private sessions = new Set<CuaDriverSession>();
  private runtimes = new Set<SessionRuntime>();
  private pendingLaunches = new Set<Promise<unknown>>();
  private shutdownPromise: Promise<void> | null = null;
  private readonly shutdownController = new AbortController();
  private cleanupPromise: Promise<void> = Promise.resolve();
  private pendingCleanupDirectories = new Set<string>();

  constructor(private readonly options: CuaDriverHostOptions) {
    const unsafeOptions = options as CuaDriverHostOptions & {
      hostBundleId?: unknown;
      testOnly?: unknown;
      verifyBridgeProcess?: unknown;
      broker: CuaDriverHostOptions["broker"] & { testInvocation?: unknown };
    };
    if (
      Object.prototype.hasOwnProperty.call(unsafeOptions, "hostBundleId") ||
      Object.prototype.hasOwnProperty.call(unsafeOptions, "testOnly") ||
      Object.prototype.hasOwnProperty.call(unsafeOptions, "verifyBridgeProcess") ||
      Object.prototype.hasOwnProperty.call(unsafeOptions.broker, "testInvocation")
    ) {
      throw new CuaDriverError(
        "broker_required",
        "Computer Use test hooks are unavailable in the production host.",
      );
    }
    this.env = buildCuaDriverEnvironment(
      options.baseEnv ?? process.env,
      CUA_DRIVER_HOST_BUNDLE_ID,
    );
  }

  /** Overridden only by the Node-test harness, which is not imported by production. */
  protected directBrokerInvocation(): CuaDriverInvocation | null {
    return null;
  }

  /** Production always validates the exact live bridge process. */
  protected verifySpawnedBridge(
    pid: number,
    expectedExecutable: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return verifyCuaDriverBridgeProcess(pid, expectedExecutable, signal);
  }

  get driverManifest(): CuaDriverManifest | null {
    return this.manifest;
  }

  get running(): boolean {
    return [...this.runtimes].some(
      (runtime) =>
        !runtime.stopping &&
        runtime.bridge.exitCode === null &&
        runtime.bridge.signalCode === null,
    );
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.shutdownPromise) {
      throw new CuaDriverError("host_closed", "The Computer Use host has shut down.");
    }
    if (signal?.aborted) throw abortError(signal);
    await this.retryPendingCleanup();
    this.manifest = {
      schemaVersion: CUA_DRIVER_TOOL_SCHEMA,
      binaryVersion: CUA_DRIVER_VERSION,
    };
  }

  async createSession(signal?: AbortSignal): Promise<CuaDriverSession> {
    if (this.shutdownPromise) {
      throw new CuaDriverError("host_closed", "The Computer Use host has shut down.");
    }
    if (signal?.aborted) throw abortError(signal);
    const timeoutMs = Math.max(1, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadlineController.abort(startupTimeoutError()),
      timeoutMs,
    );
    deadlineTimer.unref();
    const launchSignal = AbortSignal.any(
      signal
        ? [signal, this.shutdownController.signal, deadlineController.signal]
        : [this.shutdownController.signal, deadlineController.signal],
    );
    const launch = this.createSessionInternal(launchSignal, deadline);
    this.pendingLaunches.add(launch);
    try {
      return await launch;
    } finally {
      clearTimeout(deadlineTimer);
      this.pendingLaunches.delete(launch);
    }
  }

  private async createSessionInternal(
    signal: AbortSignal,
    deadline: number,
  ): Promise<CuaDriverSession> {
    await this.start(signal);
    this.assertOpen(signal);
    const tempDirectory = await mkdtemp(path.join(this.options.tempRoot ?? "/tmp", "acu-"));
    const controlPath = path.join(tempDirectory, "control.sock");
    const launchLeasePath = path.join(tempDirectory, "lease.sock");
    let brokerLauncher: ChildProcess | null = null;
    let bridge: ChildProcess | null = null;
    let runtime: SessionRuntime | null = null;
    let diagnostic = "";
    try {
      await chmod(tempDirectory, 0o700);
      this.assertOpen(signal);
      const testBroker = this.directBrokerInvocation();
      if (testBroker) {
        brokerLauncher = spawn(
          testBroker.command,
          [
            ...(testBroker.prefixArgs ?? []),
            "--control-socket",
            controlPath,
            "--launch-lease-socket",
            launchLeasePath,
          ],
          {
            detached: process.platform !== "win32",
            env: this.env,
            shell: false,
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
          },
        );
        brokerLauncher.stderr?.on("data", (chunk: Buffer) => {
          diagnostic = (diagnostic + chunk.toString("utf8")).slice(-MAX_BRIDGE_DIAGNOSTIC_BYTES);
        });
        brokerLauncher.on("error", (error) => {
          diagnostic = (diagnostic + error.message).slice(-MAX_BRIDGE_DIAGNOSTIC_BYTES);
        });
      } else {
        await runCuaDriverCommand(
          { command: "/usr/bin/open" },
          [
            "-n",
            "-g",
            this.options.broker.appPath,
            "--args",
            "--control-socket",
            controlPath,
            "--launch-lease-socket",
            launchLeasePath,
          ],
          {
            env: this.env,
            signal,
            timeoutMs: remainingMilliseconds(deadline),
          },
        );
      }

      bridge = spawn(
        this.options.invocation.command,
        [
          ...(this.options.invocation.prefixArgs ?? []),
          "--bridge",
          "--control-socket",
          controlPath,
          "--launch-lease-socket",
          launchLeasePath,
        ],
        {
          detached: process.platform !== "win32",
          env: this.env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe", "ipc", "pipe"],
          windowsHide: true,
        },
      );
      bridge.stderr?.on("data", (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString("utf8")).slice(-MAX_BRIDGE_DIAGNOSTIC_BYTES);
        if (runtime) runtime.diagnostic = diagnostic;
      });
      bridge.on("error", (error) => {
        diagnostic = (diagnostic + error.message).slice(-MAX_BRIDGE_DIAGNOSTIC_BYTES);
        if (runtime) runtime.diagnostic = diagnostic;
      });
      if (!bridge.pid) {
        throw new CuaDriverError("bridge_failed", "Aiden could not start Computer Use.", true);
      }
      await this.verifySpawnedBridge(bridge.pid, this.options.invocation.command, signal);
      await readBridgeReady(bridge, deadline, signal);
      this.assertOpen(signal);

      runtime = {
        bridge,
        brokerLauncher,
        tempDirectory,
        session: null,
        diagnostic,
        cleanupPromise: null,
        stopping: false,
      };
      this.runtimes.add(runtime);
      const ownedRuntime = runtime;
      const session = new CuaDriverSession({
        bridge,
        diagnostic: () => ownedRuntime.diagnostic,
        onClosed: (closed) => {
          this.sessions.delete(closed);
          this.scheduleRuntimeCleanup(ownedRuntime);
        },
      });
      runtime.session = session;
      this.sessions.add(session);
      brokerLauncher?.once("close", () => {
        if (!ownedRuntime.stopping) session.invalidate();
      });
      await session.connect(signal, deadline);
      this.assertOpen(signal);
      return session;
    } catch (error) {
      if (runtime) {
        await this.cleanupRuntime(runtime);
      } else {
        if (bridge) {
          if (bridge.connected) {
            try {
              bridge.disconnect();
            } catch {
              // The bridge may have closed fd 3 during startup failure.
            }
          }
          await terminateDirectChild(bridge).catch(() => {});
        }
        if (brokerLauncher) await terminateDirectChild(brokerLauncher).catch(() => {});
        this.pendingCleanupDirectories.add(tempDirectory);
        try {
          await this.removeDirectory(tempDirectory);
          this.pendingCleanupDirectories.delete(tempDirectory);
        } catch {
          // Retried by shutdown or before the next session.
        }
      }
      if (this.shutdownPromise) {
        throw new CuaDriverError("host_closed", "The Computer Use host has shut down.");
      }
      if (signal.aborted) throw abortError(signal);
      if (Date.now() >= deadline) throw startupTimeoutError();
      if (error instanceof CuaDriverError) {
        if (!diagnostic.trim()) throw error;
        throw new CuaDriverError(
          error.code,
          `${error.message} Diagnostic: ${diagnostic.trim().slice(-600)}`,
          error.retryable,
        );
      }
      throw new CuaDriverError(
        "bridge_start_failed",
        `Aiden could not start Computer Use${diagnostic.trim() ? `: ${diagnostic.trim().slice(-600)}` : "."}`,
        true,
      );
    }
  }

  private assertOpen(signal?: AbortSignal): void {
    if (this.shutdownPromise) {
      throw new CuaDriverError("host_closed", "The Computer Use host has shut down.");
    }
    if (signal?.aborted) throw abortError(signal);
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownController.abort();
      this.shutdownPromise = this.shutdownInternal();
    }
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    await Promise.allSettled([...this.pendingLaunches]);
    await Promise.allSettled([...this.sessions].map((session) => session.close()));
    this.sessions.clear();
    await Promise.allSettled([...this.runtimes].map((runtime) => this.cleanupRuntime(runtime)));
    await this.cleanupPromise;
    await this.retryPendingCleanup();
    this.manifest = null;
  }

  private scheduleRuntimeCleanup(runtime: SessionRuntime): void {
    const attempt = () => this.cleanupRuntime(runtime);
    this.cleanupPromise = this.cleanupPromise.then(attempt, attempt);
  }

  private cleanupRuntime(runtime: SessionRuntime): Promise<void> {
    runtime.cleanupPromise ??= this.cleanupRuntimeInternal(runtime);
    return runtime.cleanupPromise;
  }

  private async cleanupRuntimeInternal(runtime: SessionRuntime): Promise<void> {
    runtime.stopping = true;
    if (runtime.session) {
      this.sessions.delete(runtime.session);
      await runtime.session.close().catch(() => {});
    } else {
      if (runtime.bridge.connected) {
        try {
          runtime.bridge.disconnect();
        } catch {
          // The bridge may have closed fd 3 concurrently.
        }
      }
      await terminateDirectChild(runtime.bridge).catch(() => {});
    }
    if (runtime.brokerLauncher) {
      await terminateDirectChild(runtime.brokerLauncher).catch(() => {});
    }
    this.runtimes.delete(runtime);
    this.pendingCleanupDirectories.add(runtime.tempDirectory);
    try {
      await this.removeDirectory(runtime.tempDirectory);
      this.pendingCleanupDirectories.delete(runtime.tempDirectory);
    } catch {
      // Retain the exact directory for shutdown or the next session to retry.
    }
  }

  private get removeDirectory(): (directory: string) => Promise<void> {
    const remove = this.options.removeDirectory ?? rm;
    return async (directory: string) => {
      await remove(directory, { recursive: true, force: true });
    };
  }

  private async retryPendingCleanup(): Promise<void> {
    await this.cleanupPromise;
    for (const directory of [...this.pendingCleanupDirectories]) {
      await this.removeDirectory(directory);
      this.pendingCleanupDirectories.delete(directory);
    }
  }
}
