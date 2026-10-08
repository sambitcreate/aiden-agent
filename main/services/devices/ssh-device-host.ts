/**
 * Adapted from t3code apps/server/src/device/SshDeviceHost.ts @ a6ec88f7 (MIT)
 *
 * A device host reached over the system `ssh`. Aiden pipes a Node program to
 * the host (`ssh-device-script.ts`), which starts expo-device-hub (and, for
 * agent access, the agent-device daemon) on the host's loopback. Aiden then
 * forwards those ports to this Mac's loopback with `ssh -N -L`, so the device
 * service, the token proxy, and agent-device see an ordinary loopback hub.
 * The renderer only ever reaches the proxy.
 *
 * Network posture: nothing here runs on its own. The device service calls in
 * only from a user action (Connect, Refresh, Open, Test connection, Install,
 * Update) or an attended agent tool call on a host the user already
 * connected. There is no health polling: `ServerAliveInterval` keepalives on
 * the tunnel detect a dead link, the tunnel exits, and a bounded reconnect
 * (five attempts, 1 s doubling) follows. A user action re-checks the
 * forwarded hub before reusing it.
 *
 * Aiden stores no keys or passwords. `BatchMode=yes` makes ssh fail instead of
 * prompting, so keys must be loaded in the agent or listed in ssh_config.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { SshDeviceHostConfig, DeviceToolVersions, DeviceHostPlatformCheck } from "../../../renderer/shared/device-ssh-hosts.js";
import { deviceToolInstallMessage, parseDeviceToolVersions } from "../../../renderer/shared/device-ssh-hosts.js";
import {
  DeviceHostError,
  DeviceToolsMissingError,
  type AgentDeviceEndpoint,
  type DeviceCommandResult,
  type DeviceHost,
  type DeviceHostAgentReady,
  type DeviceHostHealth,
  type DeviceHostReady,
  type DevicePlatformAvailability,
} from "./device-host.js";
import {
  SSH_MISSING_TOOL_EXIT,
  SSH_MISSING_TOOL_PREFIX,
  quoteRemoteArg,
  remoteDeviceEnvironment,
  remoteDeviceScript,
  remoteNodeBootstrap,
  type SshDeviceScriptMode,
} from "./ssh-device-script.js";

export const SSH_START_TIMEOUT_MS = 22 * 60_000;
export const SSH_PROBE_TIMEOUT_MS = 45_000;
/** Stopping is best effort; a host that does not answer must not hold up a revoke or quit. */
export const SSH_STOP_TIMEOUT_MS = 10_000;
export const SSH_FORWARD_READY_TIMEOUT_MS = 15_000;
export const SSH_RECONNECT_ATTEMPTS = 5;
export const SSH_RECONNECT_MAX_DELAY_MS = 30_000;
const SSH_RECONNECT_MIN_DELAY_MS = 1_000;
const FORWARD_POLL_MS = 100;
const FORWARD_CHECK_TIMEOUT_MS = 3_000;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
/** ssh exits 255 when the connection itself failed, rather than the remote command. */
const SSH_CONNECTION_FAILED = 255;

export interface SshCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The subset of a spawned `ssh -N -L` the host relies on, so tests can pass a fake. */
export interface SshTunnelProcess {
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): void;
  onExit(listener: () => void): void;
  /** The last part of ssh's stderr, for the error shown when a forward fails. */
  stderr(): string;
}

export interface SshDeviceHostDeps {
  /** Distinguishes this Aiden install's helpers on a host shared with other installs. */
  owner: string;
  runSsh(args: readonly string[], options: { stdin?: string; timeoutMs: number }): Promise<SshCommandResult>;
  spawnTunnel(args: readonly string[]): SshTunnelProcess;
  reservePort(): Promise<number>;
  fetch(url: string, init?: { signal?: AbortSignal }): Promise<{ ok: boolean; status: number }>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface SshHostProbe {
  nodePath: string;
  nodeVersion: string;
  platforms: DeviceHostPlatformCheck[];
  tools?: DeviceToolVersions;
}

interface SshHostStarted extends SshHostProbe {
  hubPort: number;
  daemonPort?: number;
  token?: string;
  entryPath?: string;
  helpers: { axSettings: string | null; serveSimCli: string | null };
}

/** A DeviceHost plus the SSH-only reads the service and Settings need. */
export interface SshDeviceHost extends DeviceHost {
  kind: "ssh";
  config: SshDeviceHostConfig;
  /** Checks Node, npm, Xcode, and tool versions on the host. Never installs or starts anything. */
  inspect(): Promise<SshHostProbe>;
  /** Versions from the last check or connect, without contacting the host. */
  tools(): DeviceToolVersions | undefined;
}

/** Stable per Aiden data directory and host entry, so two Aiden installs never stop each other's hub. */
export function sshDeviceHostOwner(baseDir: string, hostId: string): string {
  return createHash("sha256").update(`${baseDir}\0${hostId}`).digest("hex").slice(0, 24);
}

/** Options shared by every ssh invocation. `BatchMode` refuses password and passphrase prompts. */
export function sshBaseArgs(config: Pick<SshDeviceHostConfig, "port" | "identityFile">): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    ...(config.port === undefined ? [] : ["-p", String(config.port)]),
    ...(config.identityFile ? ["-i", config.identityFile, "-o", "IdentitiesOnly=yes"] : []),
  ];
}

/** `ssh … -- target sh -c '<script>'`: the remote login shell runs one quoted `sh -c`. */
export function sshCommandArgs(config: SshDeviceHostConfig, remoteScript: string): string[] {
  return [...sshBaseArgs(config), "--", config.target, "sh", "-c", quoteRemoteArg(remoteDeviceEnvironment + remoteScript)];
}

/** The tunnel that forwards the host's loopback hub (and daemon) to this Mac's loopback. */
export function sshForwardArgs(
  config: SshDeviceHostConfig,
  forwards: ReadonlyArray<{ localPort: number; remotePort: number }>,
): string[] {
  return [
    ...sshBaseArgs(config),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
    "-N",
    ...forwards.flatMap(({ localPort, remotePort }) => ["-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`]),
    "--",
    config.target,
  ];
}

/** `exec`s one command on the host with only the given environment added. */
export function remoteExecScript(command: string, args: readonly string[], env: Record<string, string> = {}): string {
  const exports = Object.entries(env)
    .filter(([key]) => /^[A-Z_][A-Z0-9_]*$/u.test(key))
    .map(([key, value]) => `export ${key}=${quoteRemoteArg(value)}\n`)
    .join("");
  return `${exports}exec ${[command, ...args].map(quoteRemoteArg).join(" ")}`;
}

/** The next reconnect delay: 1 s, doubling to 30 s. */
export function nextSshReconnectDelay(previousDelayMs: number): number {
  if (previousDelayMs <= 0) return SSH_RECONNECT_MIN_DELAY_MS;
  return Math.min(previousDelayMs * 2, SSH_RECONNECT_MAX_DELAY_MS);
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** Turns a failed ssh invocation into the sentence Settings and the Simulator tab show. */
export function sshFailureMessage(label: string, result: SshCommandResult): string {
  const detail = lastLine(result.stderr);
  if (result.code === SSH_CONNECTION_FAILED) {
    if (/permission denied/iu.test(result.stderr)) {
      return `SSH to ${label} was refused: ${detail} Load the key into ssh-agent or set an identity file; Aiden never asks for passwords.`;
    }
    if (/host key verification failed/iu.test(result.stderr)) {
      return `SSH to ${label} stopped at host key verification. Connect once in Terminal to accept the host key, then try again.`;
    }
    return `Could not connect to ${label} over SSH${detail ? `: ${detail}` : "."}`;
  }
  return detail || `The command on ${label} failed (exit code ${result.code}).`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePlatforms(value: unknown): DeviceHostPlatformCheck[] | null {
  if (!Array.isArray(value)) return null;
  const platforms: DeviceHostPlatformCheck[] = [];
  for (const item of value) {
    if (!isRecord(item) || item.platform !== "ios" || typeof item.available !== "boolean") continue;
    platforms.push({
      platform: "ios",
      available: item.available,
      ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
    });
  }
  return platforms;
}

export function parseSshProbe(stdout: string): SshHostProbe | null {
  let value: unknown;
  try {
    value = JSON.parse(lastLine(stdout));
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.nodePath !== "string" || typeof value.nodeVersion !== "string") return null;
  const platforms = parsePlatforms(value.platforms);
  if (!platforms) return null;
  const tools = value.tools === undefined ? undefined : (parseDeviceToolVersions(value.tools) ?? undefined);
  return { nodePath: value.nodePath, nodeVersion: value.nodeVersion, platforms, ...(tools ? { tools } : {}) };
}

const isPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535;

export function parseSshStarted(stdout: string): SshHostStarted | null {
  const probe = parseSshProbe(stdout);
  if (!probe) return null;
  const value = JSON.parse(lastLine(stdout)) as Record<string, unknown>;
  if (!isPort(value.hubPort)) return null;
  const helpers = isRecord(value.helpers) ? value.helpers : {};
  const helper = (key: string) => (typeof helpers[key] === "string" ? (helpers[key] as string) : null);
  const agent =
    isPort(value.daemonPort) && typeof value.token === "string" && value.token && typeof value.entryPath === "string"
      ? { daemonPort: value.daemonPort, token: value.token, entryPath: value.entryPath }
      : {};
  return {
    ...probe,
    hubPort: value.hubPort,
    ...agent,
    helpers: { axSettings: helper("axSettings"), serveSimCli: helper("serveSimCli") },
  };
}

interface Tunnel {
  process: SshTunnelProcess;
  localPort: number;
}

export function createSshDeviceHost(config: SshDeviceHostConfig, deps: SshDeviceHostDeps): SshDeviceHost {
  const label = config.label;
  let ready: DeviceHostReady | null = null;
  let hubTunnel: Tunnel | null = null;
  let agentDevice: AgentDeviceEndpoint | null = null;
  let agentTunnel: Tunnel | null = null;
  let stopped = false;
  /** A start script ran on the host, so `stop` must clean up there. */
  let activated = false;
  let lastProbe: SshHostProbe | null = null;
  let lock: Promise<unknown> = Promise.resolve();
  const healthListeners = new Set<(health: DeviceHostHealth, detail?: string) => void>();
  const emitHealth = (health: DeviceHostHealth, detail?: string) => {
    for (const listener of healthListeners) listener(health, detail);
  };

  function withLock<T>(task: () => Promise<T>): Promise<T> {
    const result = lock.then(task);
    lock = result.catch(() => undefined);
    return result;
  }

  const run: DeviceHostReady["run"] = async (command, args, options = {}) => {
    const result = await deps
      .runSsh(sshCommandArgs(config, remoteExecScript(command, args, options.env)), {
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        timeoutMs: options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      })
      .catch((error: unknown): SshCommandResult => ({
        code: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }));
    return { stdout: result.stdout, stderr: result.stderr, code: result.code } satisfies DeviceCommandResult;
  };

  async function bootstrap(mode: SshDeviceScriptMode, allowInstall = false): Promise<SshCommandResult> {
    const result = await deps.runSsh(sshCommandArgs(config, remoteNodeBootstrap), {
      stdin: remoteDeviceScript(deps.owner, mode, { allowInstall }),
      timeoutMs:
        mode === "start" || mode === "agent-start"
          ? SSH_START_TIMEOUT_MS
          : mode === "probe"
            ? SSH_PROBE_TIMEOUT_MS
            : SSH_STOP_TIMEOUT_MS,
    });
    if (result.code === SSH_MISSING_TOOL_EXIT) {
      const line = result.stderr.split(/\r?\n/u).find((entry) => entry.startsWith(SSH_MISSING_TOOL_PREFIX));
      if (line) throw new DeviceToolsMissingError(line.slice(SSH_MISSING_TOOL_PREFIX.length).trim());
    }
    if (result.code !== 0) throw new Error(sshFailureMessage(label, result));
    return result;
  }

  async function inspect(): Promise<SshHostProbe> {
    const result = await bootstrap("probe");
    const probe = parseSshProbe(result.stdout);
    if (!probe) throw new Error(`${label} answered the connection check with output Aiden could not read.`);
    lastProbe = probe;
    return probe;
  }

  function closeTunnel(tunnel: Tunnel | null): void {
    if (tunnel && tunnel.process.exitCode === null) tunnel.process.kill("SIGTERM");
  }

  async function waitForForward(tunnel: Tunnel, route: string): Promise<void> {
    const origin = `http://127.0.0.1:${tunnel.localPort}`;
    const deadline = deps.now() + SSH_FORWARD_READY_TIMEOUT_MS;
    while (deps.now() < deadline) {
      if (tunnel.process.exitCode !== null) break;
      const response = await deps.fetch(`${origin}${route}`).catch(() => null);
      if (response?.ok) return;
      await deps.sleep(FORWARD_POLL_MS);
    }
    closeTunnel(tunnel);
    const detail = lastLine(tunnel.process.stderr());
    throw new DeviceHostError(config.id, "forwarding ports", {
      cause: new Error(detail || "The forwarded port did not answer."),
    });
  }

  /** Forwards one remote loopback port, retrying with a fresh local port if another process took it first. */
  async function forward(remotePort: number, route: string): Promise<Tunnel> {
    for (let attempt = 0; ; attempt += 1) {
      const localPort = await deps.reservePort();
      const tunnel: Tunnel = {
        process: deps.spawnTunnel(sshForwardArgs(config, [{ localPort, remotePort }])),
        localPort,
      };
      try {
        await waitForForward(tunnel, route);
        return tunnel;
      } catch (error) {
        if (attempt >= 2) {
          const cause = error instanceof DeviceHostError ? (error.cause as Error | undefined)?.message : undefined;
          throw new Error(`Could not forward ${label}'s device hub to this Mac${cause ? `: ${cause}` : "."}`);
        }
      }
    }
  }

  function readyFrom(started: SshHostStarted, tunnel: Tunnel): DeviceHostReady {
    return {
      nodePath: started.nodePath,
      hub: { origin: `http://127.0.0.1:${tunnel.localPort}` },
      helpers: { ...started.helpers },
      run,
    };
  }

  async function connect(allowInstall: boolean): Promise<DeviceHostReady> {
    activated = true;
    const result = await bootstrap("start", allowInstall);
    const started = parseSshStarted(result.stdout);
    if (!started) throw new Error(`${label} started its device hub but reported no port Aiden could use.`);
    lastProbe = { nodePath: started.nodePath, nodeVersion: started.nodeVersion, platforms: started.platforms, ...(started.tools ? { tools: started.tools } : {}) };
    const tunnel = await forward(started.hubPort, "/readyz");
    if (stopped) {
      closeTunnel(tunnel);
      throw new Error(`${label} was disconnected while connecting.`);
    }
    hubTunnel = tunnel;
    ready = readyFrom(started, tunnel);
    tunnel.process.onExit(() => void onHubTunnelExit(tunnel));
    return ready;
  }

  async function onHubTunnelExit(exited: Tunnel): Promise<void> {
    if (stopped || hubTunnel !== exited) return;
    hubTunnel = null;
    ready = null;
    closeTunnel(agentTunnel);
    agentTunnel = null;
    agentDevice = null;
    let delay = 0;
    for (let attempt = 1; attempt <= SSH_RECONNECT_ATTEMPTS; attempt += 1) {
      emitHealth("restarting", `Reconnecting to ${label}…`);
      delay = nextSshReconnectDelay(delay);
      await deps.sleep(delay);
      if (stopped || ready) return;
      try {
        // A reconnect never installs: a version that went missing needs the user's Update.
        await withLock(async () => {
          if (stopped || ready) return;
          await connect(false);
        });
        if (stopped) return;
        emitHealth("ready");
        return;
      } catch (error) {
        if (stopped) return;
        if (error instanceof DeviceToolsMissingError || attempt === SSH_RECONNECT_ATTEMPTS) {
          emitHealth("failed", error instanceof Error ? error.message : String(error));
          return;
        }
      }
    }
  }

  /** The forwarded hub still answers. Checked only when a user action is about to reuse it. */
  async function forwardAlive(current: Tunnel): Promise<boolean> {
    if (current.process.exitCode !== null) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FORWARD_CHECK_TIMEOUT_MS);
    try {
      const response = await deps.fetch(`http://127.0.0.1:${current.localPort}/readyz`, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  const ensureReady: DeviceHost["ensureReady"] = (onPhase, options = {}) =>
    withLock(async () => {
      stopped = false;
      if (ready && hubTunnel) {
        if (await forwardAlive(hubTunnel)) return ready;
        // The hub on the host died while ssh stayed up; start it again.
        const stale = hubTunnel;
        hubTunnel = null;
        ready = null;
        closeTunnel(stale);
      }
      if (options.allowInstall) {
        const probe = await inspect();
        const hub = probe.tools?.hub;
        const missing = !hub || !hub.installedVersions.includes(hub.requiredVersion);
        onPhase?.(missing ? "installing" : "starting", missing ? deviceToolInstallMessage("device hub", hub) : undefined);
      } else {
        onPhase?.("starting", `Connecting to ${label}…`);
      }
      return connect(options.allowInstall === true);
    });

  return {
    id: config.id,
    kind: "ssh",
    config,
    inspect: () => withLock(inspect),
    tools: () => lastProbe?.tools,
    async platformAvailability(): Promise<DevicePlatformAvailability> {
      try {
        const probe = await withLock(inspect);
        const ios = probe.platforms.find((platform) => platform.platform === "ios");
        return ios ?? { platform: "ios", available: false, reason: `${label} reported no iOS support.` };
      } catch (error) {
        return { platform: "ios", available: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    hubInstalled: async () => {
      const hub = lastProbe?.tools?.hub;
      return Boolean(hub?.installedVersions.includes(hub.requiredVersion));
    },
    agentInstalled: async () => {
      const agent = lastProbe?.tools?.agent;
      return Boolean(agent?.installedVersions.includes(agent.requiredVersion));
    },
    ensureReady,
    async ensureAgentReady(onPhase, options = {}): Promise<DeviceHostAgentReady> {
      const hubReady = await ensureReady(onPhase, options);
      return withLock(async () => {
        const current = ready ?? hubReady;
        if (agentDevice && agentTunnel && agentTunnel.process.exitCode === null) return { ...current, agentDevice };
        closeTunnel(agentTunnel);
        agentTunnel = null;
        agentDevice = null;
        const agent = lastProbe?.tools?.agent;
        const missing = !agent || !agent.installedVersions.includes(agent.requiredVersion);
        onPhase?.(
          missing && options.allowInstall ? "installing" : "starting",
          missing && options.allowInstall ? deviceToolInstallMessage("agent tools", agent) : undefined,
        );
        const result = await bootstrap("agent-start", options.allowInstall === true);
        const started = parseSshStarted(result.stdout);
        if (!started?.daemonPort || !started.token || !started.entryPath) {
          throw new DeviceHostError(config.id, "starting agent-device");
        }
        lastProbe = { nodePath: started.nodePath, nodeVersion: started.nodeVersion, platforms: started.platforms, ...(started.tools ? { tools: started.tools } : {}) };
        const tunnel = await forward(started.daemonPort, "/health");
        if (stopped) {
          closeTunnel(tunnel);
          throw new Error(`${label} was disconnected while agent tools started.`);
        }
        agentTunnel = tunnel;
        agentDevice = { baseUrl: `http://127.0.0.1:${tunnel.localPort}`, token: started.token, entryPath: started.entryPath };
        tunnel.process.onExit(() => {
          if (agentTunnel !== tunnel) return;
          // The next agent call forwards the daemon again; the viewer keeps its own tunnel.
          agentTunnel = null;
          agentDevice = null;
        });
        return { ...(ready ?? current), agentDevice };
      });
    },
    current: () => ready,
    onHealth(listener) {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    stopAgent: () =>
      withLock(async () => {
        const hadAgent = agentDevice !== null;
        closeTunnel(agentTunnel);
        agentTunnel = null;
        agentDevice = null;
        if (hadAgent) await bootstrap("stop-agent").catch(() => undefined);
      }),
    async stop() {
      // Marked first, so a reconnect loop or an in-flight connect gives up without waiting for the lock.
      stopped = true;
      const tunnels = [hubTunnel, agentTunnel];
      hubTunnel = null;
      agentTunnel = null;
      ready = null;
      agentDevice = null;
      for (const tunnel of tunnels) closeTunnel(tunnel);
      await withLock(async () => {
        if (!activated) return;
        activated = false;
        await bootstrap("stop").catch(() => undefined);
      });
    },
  };
}

const SSH_STDERR_LIMIT = 4_096;
const SSH_OUTPUT_LIMIT = 4 * 1024 * 1024;

/** Production dependencies: the system ssh, real loopback ports, and the wall clock. */
export function defaultSshDeviceHostDeps(input: {
  owner: string;
  sshPath?: string;
  reservePort(): Promise<number>;
}): SshDeviceHostDeps {
  const sshPath = input.sshPath ?? "/usr/bin/ssh";
  return {
    owner: input.owner,
    runSsh: (args, options) => runSshCommand(sshPath, args, options),
    spawnTunnel(args) {
      const child = spawn(sshPath, [...args], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-SSH_STDERR_LIMIT);
      });
      child.once("error", (error) => {
        stderr = error.message;
      });
      return {
        get exitCode() {
          return child.exitCode ?? (child.signalCode ? 1 : null);
        },
        kill: (signal) => {
          child.kill(signal);
        },
        onExit: (listener) => {
          if (child.exitCode !== null || child.signalCode !== null) listener();
          else child.once("exit", () => listener());
        },
        stderr: () => stderr,
      };
    },
    reservePort: input.reservePort,
    fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

export function runSshCommand(
  sshPath: string,
  args: readonly string[],
  options: { stdin?: string; timeoutMs: number },
): Promise<SshCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const child = spawn(sshPath, [...args], { stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      stderr += "\nThe SSH command timed out.";
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-SSH_OUTPUT_LIMIT);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-SSH_OUTPUT_LIMIT);
    });
    child.once("error", (error) => {
      stderr = error.message;
      finish(127);
    });
    child.once("close", (code, signal) => finish(code ?? (signal ? 124 : 1)));
    if (options.stdin !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.stdin);
    }
  });
}
