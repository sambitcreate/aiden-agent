/**
 * Adapted from t3code apps/server/src/device/LocalDeviceHost.ts @ 1c127066 (MIT)
 *
 * The device host that is this Mac. It runs expo-device-hub as a supervised
 * standalone Node.js child on a loopback port and starts the agent-device
 * daemon in HTTP mode under an Aiden-owned state directory. Both are lazy:
 * the device service asks for explicit consent before calling `ensureReady`.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { LOCAL_DEVICE_HOST_ID, type DevicePlatform } from "../../../renderer/shared/devices.js";
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
  DeviceNodeUnavailableError,
  defaultDeviceNodeResolutionDeps,
  deviceNodeEnvironment,
  resolveDeviceNode,
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
  "Node.js 22 or newer and npm are needed to install the simulator helpers. Install Node.js, then try again.";

/** The subset of `ChildProcess` the host relies on, so tests can pass a fake. */
export interface HostChildProcess {
  pid?: number;
  startupError?: Error;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface LocalDeviceHostDeps {
  /** `userData/devices`: tool installs, `hub.json`, and agent-device state. */
  baseDir: string;
  platform: NodeJS.Platform;
  /** Resolved only when a device action needs a standalone Node runtime. */
  resolveNodePath(): Promise<string>;
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
  /** Filesystem probes for Android SDK discovery. Default to the real filesystem. */
  pathExists?(file: string): Promise<boolean>;
  realPath?(file: string): Promise<string | null>;
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

/** Where the Android SDK is and which of its tools are installed. Adapted from t3code LocalDeviceHost @ a6ec88f7 (MIT). */
export interface AndroidSdk {
  root: string | null;
  adb: boolean;
  emulator: boolean;
  avdmanager: boolean;
  legacyAvdmanager: boolean;
}

/**
 * Finds the Android SDK: `ANDROID_HOME` or `ANDROID_SDK_ROOT` when set, else
 * the Android Studio default, else the SDK that owns an `adb` on PATH. Only
 * existence checks; nothing is run.
 */
export async function findAndroidSdk(input: {
  env: NodeJS.ProcessEnv;
  pathExists(file: string): Promise<boolean>;
  realPath(file: string): Promise<string | null>;
}): Promise<AndroidSdk> {
  const { env } = input;
  const home = env.HOME ?? "";
  const explicit = env.ANDROID_HOME?.trim() || env.ANDROID_SDK_ROOT?.trim();
  const candidates = explicit ? [explicit] : [path.join(home, "Library", "Android", "sdk"), path.join(home, "Android", "Sdk")];
  if (!explicit) {
    for (const directory of (env.PATH ?? "").split(":")) {
      if (!directory) continue;
      const resolved = await input.realPath(path.join(directory, "adb"));
      if (resolved) candidates.push(path.dirname(path.dirname(resolved)));
    }
  }
  for (const root of candidates) {
    const adb = await input.pathExists(path.join(root, "platform-tools", "adb"));
    const emulator = await input.pathExists(path.join(root, "emulator", "emulator"));
    if (explicit || adb || emulator) {
      const avdmanager = await input.pathExists(path.join(root, "cmdline-tools", "latest", "bin", "avdmanager"));
      const legacyAvdmanager = !avdmanager && (await input.pathExists(path.join(root, "tools", "bin", "avdmanager")));
      return { root, adb, emulator, avdmanager, legacyAvdmanager };
    }
  }
  return { root: null, adb: false, emulator: false, avdmanager: false, legacyAvdmanager: false };
}

/** Why Android Emulators cannot run, or null when the SDK has everything the hub needs. */
export function androidUnavailableReason(sdk: AndroidSdk): string | null {
  if (!sdk.root) {
    return "Android SDK not found. Install it with Android Studio, or set ANDROID_HOME to your SDK folder.";
  }
  if (!sdk.adb) {
    return `Android SDK Platform-Tools are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`;
  }
  if (!sdk.emulator) return `Android Emulator is missing from ${sdk.root}. Install it in Android Studio's SDK Manager.`;
  if (!sdk.avdmanager) {
    return sdk.legacyAvdmanager
      ? `The Android SDK command-line tools in ${sdk.root} are too old. Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager.`
      : `Android SDK Command-line Tools (latest) are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`;
  }
  return null;
}

/**
 * Android Studio's bundled Java runtime, used when `JAVA_HOME` is unset. The
 * hub runs `avdmanager` to list AVDs before it boots one, and `avdmanager`
 * needs Java. A Mac that only has Android Studio has no Java on PATH
 * (`/usr/bin/java` is a stub), so every boot failed with "Failed to allocate an
 * emulator port". Only existence checks; nothing is run.
 */
export async function findAndroidStudioJava(input: {
  env: NodeJS.ProcessEnv;
  pathExists(file: string): Promise<boolean>;
}): Promise<string | null> {
  if (input.env.JAVA_HOME?.trim()) return null;
  const apps = ["/Applications/Android Studio.app", path.join(input.env.HOME ?? "", "Applications", "Android Studio.app")];
  for (const app of apps) {
    const javaHome = path.join(app, "Contents", "jbr", "Contents", "Home");
    if (await input.pathExists(path.join(javaHome, "bin", "java"))) return javaHome;
  }
  return null;
}

/** The hub and every host command see the SDK: `ANDROID_HOME` set and its tools first on PATH, plus Java when found. */
export function androidSdkEnv(env: NodeJS.ProcessEnv, root: string | null, javaHome: string | null = null): NodeJS.ProcessEnv {
  if (!root) return env;
  return {
    ...env,
    ANDROID_HOME: root,
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
    PATH: [
      path.join(root, "platform-tools"),
      path.join(root, "emulator"),
      ...(javaHome ? [path.join(javaHome, "bin")] : []),
      env.PATH ?? "",
    ].join(":"),
  };
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
  const pathExists =
    deps.pathExists ??
    ((file: string) =>
      access(file).then(
        () => true,
        () => false,
      ));
  const realPath = deps.realPath ?? ((file: string) => realpath(file).catch(() => null));
  // Rediscovered on every check, so installing the SDK or Xcode needs no relaunch.
  let sdkEnv: NodeJS.ProcessEnv = deps.env;
  let iosAvailable = false;
  let nodePath: string | null = null;
  const nodeEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...deviceNodeEnvironment(sdkEnv, nodePath!),
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
  let pendingHub: { child: HostChildProcess; controller: AbortController } | null = null;
  const terminatedHubChildren = new WeakSet<HostChildProcess>();
  const terminateHubChild = (child: HostChildProcess) => {
    if (terminatedHubChildren.has(child)) return;
    terminatedHubChildren.add(child);
    child.kill("SIGTERM");
  };
  let agentDevice: AgentDeviceEndpoint | null = null;
  let stopped = false;
  let generation = 0;
  let stopPromise: Promise<void> = Promise.resolve();
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
      env: nodePath
        ? deviceNodeEnvironment({ ...sdkEnv, ...options.env }, nodePath)
        : { ...sdkEnv, ...options.env },
    });

  const ready = (): DeviceHostReady | null =>
    hub ? { nodePath: nodePath!, hub: { origin: hub.origin }, helpers: { ...hub.helpers }, run, env: deviceNodeEnvironment(sdkEnv, nodePath!) } : null;

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

  async function waitForHub(child: HostChildProcess, origin: string, signal: AbortSignal): Promise<void> {
    const deadline = deps.now() + HUB_READY_TIMEOUT_MS;
    while (deps.now() < deadline) {
      if (signal.aborted) throw new DeviceHostError(LOCAL_DEVICE_HOST_ID, "starting the device hub after it stopped");
      if (child.startupError) {
        throw new DeviceHostError(LOCAL_DEVICE_HOST_ID, "starting the device hub", { cause: child.startupError });
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new DeviceHostError(LOCAL_DEVICE_HOST_ID, "starting the device hub");
      }
      const response = await deps.fetch(`${origin}/readyz`, { signal }).catch(() => null);
      if (signal.aborted) throw new DeviceHostError(LOCAL_DEVICE_HOST_ID, "starting the device hub after it stopped");
      if (response?.ok) return;
      await deps.sleep(READY_POLL_MS);
    }
    throw new DeviceHostError(LOCAL_DEVICE_HOST_ID, "waiting for the device hub to become ready");
  }

  const isCurrent = (startedIn: number) => !stopped && generation === startedIn;
  const assertCurrent = (startedIn: number) => {
    if (!isCurrent(startedIn)) throw new DeviceHostError(LOCAL_DEVICE_HOST_ID, "starting the device hub after it stopped");
  };

  async function spawnHub(entryPath: string, startedIn: number): Promise<HubProcess> {
    assertCurrent(startedIn);
    await reapStaleHub();
    assertCurrent(startedIn);
    const port = await deps.reservePort();
    assertCurrent(startedIn);
    const origin = `http://127.0.0.1:${port}`;
    const child = deps.spawn(
      nodePath!,
      [entryPath, "--port", String(port), "--host", "127.0.0.1", "--hide-sidebar", "--hide-boot-device"],
      nodeEnv(),
    );
    const controller = new AbortController();
    pendingHub = { child, controller };
    try {
      await waitForHub(child, origin, controller.signal);
      assertCurrent(startedIn);
      if (child.pid !== undefined) {
        await mkdir(deps.baseDir, { recursive: true });
        assertCurrent(startedIn);
        await writeFile(hubStatePath, JSON.stringify({ pid: child.pid, port, entryPath } satisfies HubStateFile));
      }
      assertCurrent(startedIn);
      const helpers = await findDeviceHostHelpers(deviceToolPaths(deps.baseDir, DEVICE_HUB).installDir);
      assertCurrent(startedIn);
      const spawned: HubProcess = { child, origin, entryPath, startedAt: deps.now(), helpers };
      child.once("exit", () => void supervise(spawned));
      return spawned;
    } catch (error) {
      if (pendingHub?.child === child) pendingHub = null;
      terminateHubChild(child);
      // A late readiness or file write must not recreate an endpoint after stop.
      // The start lock keeps a newer spawn from publishing its state until this cleanup finishes.
      await rm(hubStatePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function supervise(exited: HubProcess): Promise<void> {
    if (stopped || hub !== exited) return;
    const startedIn = generation;
    hub = null;
    // agent-device drives simulators directly, so it survives a hub restart.
    restartDelayMs = nextHubRestartDelay(restartDelayMs, deps.now() - exited.startedAt);
    emitHealth("restarting");
    if (restartDelayMs > 0) await deps.sleep(restartDelayMs);
    if (!isCurrent(startedIn) || hub) return;
    try {
      await withStartLock(async () => {
        if (!isCurrent(startedIn) || hub) return;
        const replacement = await spawnHub(exited.entryPath, startedIn);
        if (!isCurrent(startedIn) || hub) {
          if (pendingHub?.child === replacement.child) pendingHub = null;
          terminateHubChild(replacement.child);
          await rm(hubStatePath, { force: true }).catch(() => undefined);
          return;
        }
        hub = replacement;
        if (pendingHub?.child === replacement.child) pendingHub = null;
      });
      if (isCurrent(startedIn) && hub) emitHealth("ready");
    } catch (error) {
      if (isCurrent(startedIn)) emitHealth("failed", error instanceof Error ? error.message : String(error));
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
      .runCommand(nodePath!, [entryPath, "devices", "--json"], {
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
    // An explicit call after stop opens a new lifecycle. Calls already queued
    // before stop keep their old generation and cannot revive it.
    if (stopped) stopped = false;
    const startedIn = generation;
    const priorStop = stopPromise;
    return withStartLock(async () => {
      await priorStop;
      assertCurrent(startedIn);
      const existing = ready();
      if (existing) return existing;
      // The hub serves both platforms, so it starts when either one can run.
      const [ios, android] = await Promise.all([platformAvailability("ios"), platformAvailability("android")]);
      assertCurrent(startedIn);
      if (!ios.available && !android.available) {
        throw new DeviceHostUnavailableError(
          deps.platform === "darwin" ? [ios.reason, android.reason].filter(Boolean).join(" ") : (ios.reason ?? ""),
        );
      }
      nodePath = await deps.resolveNodePath();
      assertCurrent(startedIn);
      const entryPath = await install(DEVICE_HUB, onPhase, options.allowInstall === true);
      assertCurrent(startedIn);
      onPhase?.("starting");
      restartDelayMs = 0;
      const started = await spawnHub(entryPath, startedIn);
      if (!isCurrent(startedIn)) {
        if (pendingHub?.child === started.child) pendingHub = null;
        terminateHubChild(started.child);
        await rm(hubStatePath, { force: true }).catch(() => undefined);
        assertCurrent(startedIn);
      }
      hub = started;
      if (pendingHub?.child === started.child) pendingHub = null;
      return ready()!;
    });
  }

  async function platformAvailability(platform: DevicePlatform): Promise<DevicePlatformAvailability> {
    // Simulator devices are a macOS feature; the hub is never started elsewhere.
    if (deps.platform !== "darwin") {
      return platform === "ios"
        ? { platform, available: false, reason: "iOS Simulators need macOS with Xcode." }
        : { platform, available: false, reason: "Android Emulators in Aiden need macOS." };
    }
    if (platform === "android") {
      const sdk = await findAndroidSdk({ env: deps.env, pathExists, realPath });
      const javaHome = sdk.root ? await findAndroidStudioJava({ env: deps.env, pathExists }) : null;
      sdkEnv = androidSdkEnv(deps.env, sdk.root, javaHome);
      const reason = androidUnavailableReason(sdk);
      return reason ? { platform, available: false, reason } : { platform, available: true };
    }
    // Once Xcode answers it stays installed for this run; only a missing Xcode is checked again.
    if (iosAvailable) return { platform, available: true };
    const reason = xcodeUnavailableReason(await run("xcrun", ["simctl", "help"], { timeoutMs: 15_000 }));
    iosAvailable = reason === null;
    return reason ? { platform, available: false, reason } : { platform, available: true };
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
    try {
      const runtime = nodePath ?? await deps.resolveNodePath();
      nodePath = runtime;
      await deps.runCommand(runtime, [entryPath, "daemon", "stop", "--state-dir", agentStateDir], {
        timeoutMs: DAEMON_STOP_TIMEOUT_MS,
        env: agentEnv(),
      });
    } catch {
      // Discovery and daemon stop are both best effort. Revocation/removal must
      // still clear token configs, close the proxy and remove installed files.
    }
  }

  return {
    id: LOCAL_DEVICE_HOST_ID,
    kind: "local",
    platformAvailability,
    hubInstalled: () => isToolInstalled(deps.baseDir, DEVICE_HUB),
    agentInstalled: () => isToolInstalled(deps.baseDir, AGENT_DEVICE),
    ensureReady: ensureHub,
    async ensureAgentReady(onPhase, options = {}) {
      const startedIn = generation;
      const hubReady = await ensureHub(onPhase, options);
      assertCurrent(startedIn);
      if (agentDevice) return { ...hubReady, agentDevice };
      return withStartLock(async () => {
        assertCurrent(startedIn);
        if (!agentDevice) {
          const entryPath = await install(AGENT_DEVICE, onPhase, options.allowInstall === true);
          assertCurrent(startedIn);
          onPhase?.("starting");
          agentDevice = await startAgentDaemon(entryPath);
        }
        const current = ready();
        if (!isCurrent(startedIn) || !current) {
          // The hub stopped while the daemon started; never leave the daemon and its token behind.
          await stopAgent();
          throw new DeviceHostError(LOCAL_DEVICE_HOST_ID, "starting agent-device");
        }
        return { ...current, agentDevice } satisfies DeviceHostAgentReady;
      });
    },
    current: ready,
    async installTool(tool) {
      const spec = tool === "hub" ? DEVICE_HUB : AGENT_DEVICE;
      await withStartLock(() => install(spec, undefined, true));
    },
    runningToolVersions: () => ({
      hub: hub ? DEVICE_HUB.version : null,
      agent: agentDevice ? AGENT_DEVICE.version : null,
    }),
    onHealth(listener) {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    stopAgent,
    async stop() {
      if (stopped) return stopPromise;
      generation += 1;
      stopped = true;
      const running = hub;
      hub = null;
      const starting = pendingHub;
      pendingHub = null;
      starting?.controller.abort();
      if (starting) terminateHubChild(starting.child);
      if (running) terminateHubChild(running.child);
      const priorStop = stopPromise;
      stopPromise = (async () => {
        await priorStop;
        await stopAgent();
        await rm(hubStatePath, { force: true }).catch(() => undefined);
      })();
      return stopPromise;
    },
  };
}

/** Production dependencies: real processes, the loopback network, and the wall clock. */
export function defaultLocalDeviceHostDeps(
  options: Pick<LocalDeviceHostDeps, "baseDir" | "resolveNpmRunner"> &
    Partial<Pick<LocalDeviceHostDeps, "resolveNodePath" | "env" | "platform">>,
): LocalDeviceHostDeps {
  return {
    baseDir: options.baseDir,
    resolveNpmRunner: options.resolveNpmRunner,
    platform: options.platform ?? process.platform,
    resolveNodePath: options.resolveNodePath ?? (() => requireDeviceNode(options.env)),
    env: options.env ?? process.env,
    spawn: (command, args, env) => {
      const child: HostChildProcess = nodeSpawn(command, [...args], { env, stdio: "ignore", detached: false });
      // Spawn errors do not emit exit. Record them so readiness fails without an unhandled event.
      (child as ReturnType<typeof nodeSpawn>).once("error", (error) => { child.startupError = error; });
      return child;
    },
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

/** Commands still running, so quit can end them when its deadline arrives before their own timeouts. */
const runningCommands = new Set<ReturnType<typeof nodeSpawn>>();
/** Set once quit's Devices deadline has passed: no helper command starts after that. */
let commandsCancelledForQuit = false;

/**
 * Sends SIGTERM to every helper command still running, the same fallback each
 * command's own timeout applies, and refuses every helper command started
 * afterwards. Quit calls it when the Devices budget runs out first: the
 * shutdown chain keeps running past the deadline (recording waits, SSH, then
 * `daemon stop`), so a command it starts later would otherwise outlive the app.
 * A refused `daemon stop` leaves `daemon.json` behind, which the next launch's
 * stop reaps. Returns how many running commands were signalled.
 */
export function terminateRunningDeviceCommands(): number {
  commandsCancelledForQuit = true;
  const children = [...runningCommands];
  for (const child of children) child.kill("SIGTERM");
  return children.length;
}

/** Test-only: clears the quit cancellation so one test's deadline cleanup cannot refuse another test's commands. */
export function resetDeviceCommandCancellationForTests(): void {
  commandsCancelledForQuit = false;
}

export function runChildCommand(
  command: string,
  args: readonly string[],
  options: Omit<DeviceCommandOptions, "env"> & { env: NodeJS.ProcessEnv },
): Promise<DeviceCommandResult> {
  if (commandsCancelledForQuit) {
    return Promise.resolve({ stdout: "", stderr: "Aiden is quitting, so the device helper command did not start.", code: 124 });
  }
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runningCommands.delete(child);
      resolve({ stdout, stderr, code });
    };
    const child = nodeSpawn(command, [...args], {
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    runningCommands.add(child);
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

/** Fresh discovery lets Retry recover after Node is installed without restarting Aiden. */
export async function requireDeviceNode(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const nodePath = await resolveDeviceNode(defaultDeviceNodeResolutionDeps(env));
  if (!nodePath) throw new DeviceNodeUnavailableError();
  return nodePath;
}
