/**
 * Adapted from t3code apps/server/src/device/LocalDeviceHost.ts @ 1c127066 (MIT)
 *
 * The device host that is this Mac. It runs expo-device-hub as a supervised
 * Electron-as-Node child on a loopback port and starts the agent-device
 * daemon in HTTP mode under an Aiden-owned state directory. Both are lazy:
 * the device service asks for explicit consent before calling `ensureReady`.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { LOCAL_DEVICE_HOST_ID } from "../../../renderer/shared/devices.js";
import {
  DeviceHostError,
  DeviceHostUnavailableError,
  DeviceToolsMissingError,
  type AgentDeviceEndpoint,
  type DeviceCommandOptions,
  type DeviceCommandResult,
  type DeviceHost,
  type DeviceHostAgentReady,
  type DeviceHostHealth,
  type DeviceHostHelpers,
  type DeviceHostPhase,
  type DeviceHostReady,
  type DeviceHostStartOptions,
  type DevicePlatformAvailability,
} from "./device-host.js";
import {
  AGENT_DEVICE,
  DEVICE_HUB,
  deviceToolPaths,
  ensureTool,
  isToolInstalled,
  type NpmRunner,
  type ToolSpec,
} from "./device-toolchain.js";

export const HUB_READY_TIMEOUT_MS = 30_000;
export const DAEMON_READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;
export const HUB_RESTART_STABLE_UPTIME_MS = 60_000;
export const HUB_RESTART_MAX_DELAY_MS = 30_000;
const HUB_RESTART_MIN_DELAY_MS = 1_000;
const DEFAULT_RUN_TIMEOUT_MS = 20_000;
const DAEMON_HEALTH_TIMEOUT_MS = 2_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;

export const NPM_REQUIRED_REASON =
  "Node.js and npm are needed once to install the simulator helpers. Install Node.js, then try again.";

/** The subset of `ChildProcess` the host relies on, so tests can pass a fake. */
export interface HostChildProcess {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface LocalDeviceHostDeps {
  /** `userData/devices`: tool installs, `hub.json`, and agent-device state. */
  baseDir: string;
  platform: NodeJS.Platform;
  /** Electron's own binary, run with `ELECTRON_RUN_AS_NODE=1`. */
  nodePath: string;
  env: NodeJS.ProcessEnv;
  spawn(command: string, args: readonly string[], env: NodeJS.ProcessEnv): HostChildProcess;
  runCommand(
    command: string,
    args: readonly string[],
    options: Omit<DeviceCommandOptions, "env"> & { env: NodeJS.ProcessEnv },
  ): Promise<DeviceCommandResult>;
  reservePort(): Promise<number>;
  fetch(url: string, init?: { signal?: AbortSignal }): Promise<{ ok: boolean; status: number }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  isProcessAlive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  /** Resolves the user's npm only when an install is needed; null means npm was not found. */
  resolveNpmRunner(): Promise<NpmRunner | null>;
}

interface HubProcess {
  child: HostChildProcess;
  origin: string;
  entryPath: string;
  startedAt: number;
  helpers: DeviceHostHelpers;
}

async function existingPath(candidate: string): Promise<string | null> {
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/** serve-sim ships these inside the hub package; T3 looks in the same place. */
export async function findDeviceHostHelpers(hubInstallDir: string): Promise<DeviceHostHelpers> {
  const dist = path.join(hubInstallDir, "node_modules", "expo-device-hub", "vendor", "serve-sim", "dist");
  const [axSettings, serveSimCli] = await Promise.all([
    existingPath(path.join(dist, "simax", "serve-sim-ax-settings")),
    existingPath(path.join(dist, "serve-sim.js")),
  ]);
  return { axSettings, serveSimCli };
}

interface HubStateFile {
  pid: number;
  port: number;
  entryPath: string;
}

function parseHubStateFile(text: string): HubStateFile | null {
  try {
    const value = JSON.parse(text) as Partial<HubStateFile>;
    return Number.isInteger(value.pid) &&
      Number.isInteger(value.port) &&
      typeof value.entryPath === "string"
      ? { pid: value.pid!, port: value.port!, entryPath: value.entryPath }
      : null;
  } catch {
    return null;
  }
}

function parseDaemonFile(text: string): { httpPort: number; token: string } | null {
  try {
    const value = JSON.parse(text) as { httpPort?: unknown; token?: unknown };
    return Number.isInteger(value.httpPort) && typeof value.token === "string" && value.token
      ? { httpPort: value.httpPort as number, token: value.token }
      : null;
  } catch {
    return null;
  }
}

/** The next supervised restart delay: immediate after stable uptime, else 1s doubling to 30s. */
export function nextHubRestartDelay(previousDelayMs: number, uptimeMs: number): number {
  if (uptimeMs >= HUB_RESTART_STABLE_UPTIME_MS) return 0;
  if (previousDelayMs <= 0) return HUB_RESTART_MIN_DELAY_MS;
  return Math.min(previousDelayMs * 2, HUB_RESTART_MAX_DELAY_MS);
}

/** Maps `xcrun simctl help` output to a setup step the user can take. */
export function xcodeUnavailableReason(result: DeviceCommandResult): string | null {
  if (result.code === 0) return null;
  const output = `${result.stderr}\n${result.stdout}`;
  if (result.code === 127 || /xcode-select: error|unable to find utility|invalid active developer path/iu.test(output)) {
    return "Xcode was not found. Install Xcode from the App Store, open it once, then try again.";
  }
  if (/license/iu.test(output)) {
    return "Open Xcode once and accept its license, then try again.";
  }
  return "Xcode's simulator tools did not respond. Open Xcode once to finish its setup, then try again.";
}

export function createLocalDeviceHost(deps: LocalDeviceHostDeps): DeviceHost {
  const hubStatePath = path.join(deps.baseDir, "hub.json");
  const agentStateDir = path.join(deps.baseDir, "agent-state");
  const nodeEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...deps.env,
    ELECTRON_RUN_AS_NODE: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...extra,
  });
  const agentEnv = () =>
    nodeEnv({
      AGENT_DEVICE_STATE_DIR: agentStateDir,
      AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
    });

  let hub: HubProcess | null = null;
  let agentDevice: AgentDeviceEndpoint | null = null;
  let stopped = false;
  let restartDelayMs = 0;
  let startLock: Promise<unknown> = Promise.resolve();
  const healthListeners = new Set<(health: DeviceHostHealth, detail?: string) => void>();
  const emitHealth = (health: DeviceHostHealth, detail?: string) => {
    for (const listener of healthListeners) listener(health, detail);
  };

  function withStartLock<T>(task: () => Promise<T>): Promise<T> {
    const result = startLock.then(task);
    startLock = result.catch(() => undefined);
    return result;
  }

  const run: DeviceHostReady["run"] = (command, args, options = {}) =>
    deps.runCommand(command, args, {
      timeoutMs: options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      env: options.env ? { ...deps.env, ...options.env } : deps.env,
    });

  const ready = (): DeviceHostReady | null =>
    hub ? { nodePath: deps.nodePath, hub: { origin: hub.origin }, helpers: { ...hub.helpers }, run } : null;

  async function install(
    spec: ToolSpec,
    onPhase: ((phase: DeviceHostPhase, detail?: string) => void) | undefined,
    allowInstall: boolean,
  ) {
    if (await isToolInstalled(deps.baseDir, spec)) return deviceToolPaths(deps.baseDir, spec).entryPath;
    if (!allowInstall) throw new DeviceToolsMissingError(spec.name);
    onPhase?.("installing", `${spec.name}@${spec.version}`);
    const runNpm = await deps.resolveNpmRunner();
    if (!runNpm) throw new DeviceHostUnavailableError(NPM_REQUIRED_REASON);
    return ensureTool(deps.baseDir, spec, { runNpm });
  }

  /** Kills a hub left by an Aiden that died without cleanup, but only if the pid is still that hub. */
  async function reapStaleHub(): Promise<void> {
    const state = parseHubStateFile(await readFile(hubStatePath, "utf8").catch(() => ""));
    if (state && deps.isProcessAlive(state.pid)) {
      const command = await deps
        .runCommand("ps", ["-o", "command=", "-p", String(state.pid)], {
          timeoutMs: 5_000,
          env: deps.env,
        })
        .catch(() => null);
      if (command?.code === 0 && command.stdout.includes(state.entryPath)) {
        deps.kill(state.pid, "SIGTERM");
      }
    }
    await rm(hubStatePath, { force: true });
  }

  async function waitForHub(child: HostChildProcess, origin: string): Promise<void> {
    const deadline = deps.now() + HUB_READY_TIMEOUT_MS;
    while (deps.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new DeviceHostError(LOCAL_DEVICE_HOST_ID, "starting the device hub");
      }
      const response = await deps.fetch(`${origin}/readyz`).catch(() => null);
      if (response?.ok) return;
      await deps.sleep(READY_POLL_MS);
    }
    throw new DeviceHostError(LOCAL_DEVICE_HOST_ID, "waiting for the device hub to become ready");
  }

  async function spawnHub(entryPath: string): Promise<HubProcess> {
    await reapStaleHub();
    const port = await deps.reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const child = deps.spawn(
      deps.nodePath,
      [entryPath, "--port", String(port), "--host", "127.0.0.1", "--hide-sidebar", "--hide-boot-device"],
      nodeEnv(),
    );
    try {
      await waitForHub(child, origin);
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
    if (child.pid !== undefined) {
      await mkdir(deps.baseDir, { recursive: true });
      await writeFile(hubStatePath, JSON.stringify({ pid: child.pid, port, entryPath } satisfies HubStateFile));
    }
    const helpers = await findDeviceHostHelpers(deviceToolPaths(deps.baseDir, DEVICE_HUB).installDir);
    const spawned: HubProcess = { child, origin, entryPath, startedAt: deps.now(), helpers };
    child.once("exit", () => void supervise(spawned));
    return spawned;
  }

  async function supervise(exited: HubProcess): Promise<void> {
    if (stopped || hub !== exited) return;
    hub = null;
    // agent-device drives simulators directly, so it survives a hub restart.
    restartDelayMs = nextHubRestartDelay(restartDelayMs, deps.now() - exited.startedAt);
    emitHealth("restarting");
    if (restartDelayMs > 0) await deps.sleep(restartDelayMs);
    if (stopped || hub) return;
    try {
      await withStartLock(async () => {
        if (stopped || hub) return;
        hub = await spawnHub(exited.entryPath);
      });
      if (hub) emitHealth("ready");
    } catch (error) {
      emitHealth("failed", error instanceof Error ? error.message : String(error));
    }
  }

  async function daemonHealthy(endpoint: { httpPort: number }): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DAEMON_HEALTH_TIMEOUT_MS);
    try {
      const response = await deps.fetch(`http://127.0.0.1:${endpoint.httpPort}/health`, {
        signal: controller.signal,
      });
      return response.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function startAgentDaemon(entryPath: string): Promise<AgentDeviceEndpoint> {
    const daemonPath = path.join(agentStateDir, "daemon.json");
    const existing = parseDaemonFile(await readFile(daemonPath, "utf8").catch(() => ""));
    if (existing && (await daemonHealthy(existing))) {
      return { baseUrl: `http://127.0.0.1:${existing.httpPort}`, token: existing.token, entryPath };
    }
    await rm(daemonPath, { force: true });
    await mkdir(agentStateDir, { recursive: true });
    // Any agent-device command starts the daemon; `devices` is the cheapest one.
    const launch = deps
      .runCommand(deps.nodePath, [entryPath, "devices", "--json"], {
        timeoutMs: DAEMON_READY_TIMEOUT_MS,
        env: agentEnv(),
      })
      .catch(() => null);
    const deadline = deps.now() + DAEMON_READY_TIMEOUT_MS;
    while (deps.now() < deadline) {
      const daemon = parseDaemonFile(await readFile(daemonPath, "utf8").catch(() => ""));
      if (daemon) {
        return { baseUrl: `http://127.0.0.1:${daemon.httpPort}`, token: daemon.token, entryPath };
      }
      await deps.sleep(READY_POLL_MS);
    }
    await launch;
    throw new DeviceHostError(LOCAL_DEVICE_HOST_ID, "starting agent-device");
  }

  async function ensureHub(
    onPhase?: (phase: DeviceHostPhase, detail?: string) => void,
    options: DeviceHostStartOptions = {},
  ) {
    const current = ready();
    if (current) return current;
    return withStartLock(async () => {
      const existing = ready();
      if (existing) return existing;
      const availability = await platformAvailability();
      if (!availability.available) throw new DeviceHostUnavailableError(availability.reason ?? "");
      const entryPath = await install(DEVICE_HUB, onPhase, options.allowInstall === true);
      onPhase?.("starting");
      stopped = false;
      restartDelayMs = 0;
      hub = await spawnHub(entryPath);
      return ready()!;
    });
  }

  async function platformAvailability(): Promise<DevicePlatformAvailability> {
    if (deps.platform !== "darwin") {
      return { platform: "ios", available: false, reason: "iOS Simulators need macOS with Xcode." };
    }
    const reason = xcodeUnavailableReason(await run("xcrun", ["simctl", "help"], { timeoutMs: 15_000 }));
    return reason ? { platform: "ios", available: false, reason } : { platform: "ios", available: true };
  }

  /**
   * Stops the daemon, including one a previous Aiden left running: it has no
   * idle timeout, so a leftover `daemon.json` means a live token.
   */
  async function stopAgent(): Promise<void> {
    const endpoint = agentDevice;
    agentDevice = null;
    let entryPath = endpoint?.entryPath;
    if (!entryPath) {
      const leftover = await readFile(path.join(agentStateDir, "daemon.json"), "utf8").catch(() => null);
      if (leftover === null) return;
      if (!(await isToolInstalled(deps.baseDir, AGENT_DEVICE))) return;
      entryPath = deviceToolPaths(deps.baseDir, AGENT_DEVICE).entryPath;
    }
    await deps
      .runCommand(deps.nodePath, [entryPath, "daemon", "stop", "--state-dir", agentStateDir], {
        timeoutMs: DAEMON_STOP_TIMEOUT_MS,
        env: agentEnv(),
      })
      .catch(() => undefined);
  }

  return {
    id: LOCAL_DEVICE_HOST_ID,
    kind: "local",
    platformAvailability,
    hubInstalled: () => isToolInstalled(deps.baseDir, DEVICE_HUB),
    agentInstalled: () => isToolInstalled(deps.baseDir, AGENT_DEVICE),
    ensureReady: ensureHub,
    async ensureAgentReady(onPhase, options = {}) {
      const hubReady = await ensureHub(onPhase, options);
      if (agentDevice) return { ...hubReady, agentDevice };
      return withStartLock(async () => {
        if (!agentDevice) {
          const entryPath = await install(AGENT_DEVICE, onPhase, options.allowInstall === true);
          onPhase?.("starting");
          agentDevice = await startAgentDaemon(entryPath);
        }
        const current = ready();
        if (!current) {
          // The hub stopped while the daemon started; never leave the daemon and its token behind.
          await stopAgent();
          throw new DeviceHostError(LOCAL_DEVICE_HOST_ID, "starting agent-device");
        }
        return { ...current, agentDevice } satisfies DeviceHostAgentReady;
      });
    },
    current: ready,
    onHealth(listener) {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    stopAgent,
    async stop() {
      stopped = true;
      const running = hub;
      hub = null;
      await stopAgent();
      running?.child.kill("SIGTERM");
      await rm(hubStatePath, { force: true }).catch(() => undefined);
    },
  };
}

/** Production dependencies: real processes, the loopback network, and the wall clock. */
export function defaultLocalDeviceHostDeps(
  options: Pick<LocalDeviceHostDeps, "baseDir" | "resolveNpmRunner"> &
    Partial<Pick<LocalDeviceHostDeps, "nodePath" | "env" | "platform">>,
): LocalDeviceHostDeps {
  return {
    baseDir: options.baseDir,
    resolveNpmRunner: options.resolveNpmRunner,
    platform: options.platform ?? process.platform,
    nodePath: options.nodePath ?? process.execPath,
    env: options.env ?? process.env,
    spawn: (command, args, env) =>
      nodeSpawn(command, [...args], { env, stdio: "ignore", detached: false }),
    runCommand: runChildCommand,
    reservePort,
    fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    },
  };
}

const OUTPUT_LIMIT = 4 * 1024 * 1024;

export function runChildCommand(
  command: string,
  args: readonly string[],
  options: Omit<DeviceCommandOptions, "env"> & { env: NodeJS.ProcessEnv },
): Promise<DeviceCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    const child = nodeSpawn(command, [...args], {
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-OUTPUT_LIMIT);
    });
    child.once("error", (error) => {
      stderr = error.message;
      finish(127);
    });
    child.once("close", (code, signal) => finish(code ?? (signal ? 124 : 1)));
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

/** Asks the OS for a free loopback port. The hub needs an explicit `--port`. */
export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("No loopback port was available."))));
    });
  });
}
