/**
 * Simulator discovery, consent, and per-chat device sessions for the
 * Simulator tab and, in Phase 4, the agent's device tools.
 *
 * Nothing starts on its own. The hub is installed only from the explicit
 * streaming consent action; a refresh may start an already-installed hub
 * (a local spawn) but never contacts npm. Consent is device-local, stored in
 * `userData/devices/consent.json`, because the installs it authorizes are.
 */
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_DEVICE_HOST_ID,
  type DeviceConsent,
  type DeviceActionInput,
  type DeviceConsentKind,
  type DeviceHostState,
  type DeviceKind,
  type DeviceServiceState,
  type DeviceSession,
  type DeviceSettings,
  type DeviceStreamGrant,
  type DeviceSummary,
} from "../../../renderer/shared/devices.js";
import {
  DeviceHostUnavailableError,
  DeviceToolsMissingError,
  type DeviceHost,
  type DeviceHostReady,
} from "./device-host.js";
import { readDeviceSettings, runDeviceAction } from "./device-actions.js";
import type { DeviceHubProxy } from "./device-hub-proxy.js";
import { AGENT_DEVICE, DEVICE_HUB } from "./device-toolchain.js";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  ensureAgentDeviceShim,
  writeAgentDeviceConfig,
} from "./agent-device-shim.js";

export const DEVICE_BOOT_TIMEOUT_MS = 3 * 60_000;
const HUB_REQUEST_TIMEOUT_MS = 30_000;
const SIMCTL_LIST_TIMEOUT_MS = 30_000;
const SIMCTL_SHUTDOWN_TIMEOUT_MS = 60_000;

export interface DeviceServiceDeps {
  /** `userData/devices`, where `consent.json` lives beside the tool installs. */
  baseDir: string;
  host: DeviceHost;
  /** Starts the renderer-facing proxy lazily, the first time a stream grant is requested. */
  startProxy(resolveHub: (hostId: string) => string | null): Promise<DeviceHubProxy>;
  fetch(
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
  ): Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;
}

export interface DeviceOpenInput {
  chatId: string;
  hostId?: string;
  deviceId: string;
  openedBy: "user" | "agent";
}

export interface DeviceCloseInput {
  chatId: string;
  hostId: string;
  deviceId: string;
  /** Shuts the simulator down too. Only an explicit request does; closing a session never does. */
  shutdown?: boolean;
}

export interface DeviceService {
  load(): Promise<DeviceServiceState>;
  state(): DeviceServiceState;
  onState(listener: (state: DeviceServiceState) => void): () => void;
  grantConsent(kind: DeviceConsentKind): Promise<DeviceServiceState>;
  revokeConsent(kind: DeviceConsentKind): Promise<DeviceServiceState>;
  refresh(): Promise<DeviceServiceState>;
  open(input: DeviceOpenInput): Promise<DeviceSession>;
  close(input: DeviceCloseInput): Promise<void>;
  /** Drops every session a removed chat held. Simulators keep running. */
  closeChat(chatId: string): void;
  sessionsForChat(chatId: string): DeviceSession[];
  /** Runs one typed action, then returns the settings as they now read. */
  action(input: DeviceActionInput): Promise<DeviceSettings>;
  settings(input: { hostId: string; deviceId: string }): Promise<DeviceSettings>;
  screenshot(input: { hostId: string; deviceId: string }): Promise<Buffer>;
  streamGrant(): Promise<DeviceStreamGrant>;
  /**
   * Starts agent-device and pins it to one chat's device. Needs agent access;
   * never installs, since installing happens only when the user grants access.
   */
  agentTarget(input: { chatId: string; hostId: string; deviceId: string }): Promise<{ command: string; args: string[] }>;
  /** The `agent-device` shim directory while agent access holds, for `run_command`'s PATH. */
  agentShimDir(): string | null;
  /** A per-chat directory for screenshots a text-only model cannot view. Removed with the chat. */
  screenshotDir(chatId: string): Promise<string>;
  /** Asks the renderer to show the Simulator tab for a chat. */
  reveal(chatId: string): void;
  onReveal(listener: (chatId: string) => void): () => void;
  stop(): Promise<void>;
}

interface SimctlDevice {
  udid?: unknown;
  name?: unknown;
  state?: unknown;
  isAvailable?: unknown;
  deviceTypeIdentifier?: unknown;
}

const IOS_RUNTIME_PATTERN = /SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/u;

function deviceKind(deviceTypeIdentifier: string, name: string): DeviceKind {
  const identity = `${deviceTypeIdentifier} ${name}`;
  if (/iPad/u.test(identity)) return "ipad";
  if (/iPhone/u.test(identity)) return "iphone";
  return "other";
}

/** Parses `xcrun simctl list devices --json`: available iOS simulators only, booted first. */
export function parseSimctlDevices(stdout: string, hostId: string = LOCAL_DEVICE_HOST_ID): DeviceSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const runtimes = (parsed as { devices?: unknown })?.devices;
  if (typeof runtimes !== "object" || runtimes === null) return [];
  const devices: (DeviceSummary & { sortVersion: number[] })[] = [];
  for (const [runtime, entries] of Object.entries(runtimes)) {
    const match = IOS_RUNTIME_PATTERN.exec(runtime);
    if (!match || !Array.isArray(entries)) continue;
    const sortVersion = match.slice(1).map((part) => Number(part ?? 0));
    const version = `iOS ${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ""}`;
    for (const entry of entries as SimctlDevice[]) {
      if (entry?.isAvailable !== true) continue;
      if (typeof entry.udid !== "string" || typeof entry.name !== "string") continue;
      if (!entry.udid || !entry.name) continue;
      const typeIdentifier = typeof entry.deviceTypeIdentifier === "string" ? entry.deviceTypeIdentifier : "";
      devices.push({
        hostId,
        id: entry.udid,
        name: entry.name,
        platform: "ios",
        version,
        booted: entry.state === "Booted",
        kind: deviceKind(typeIdentifier, entry.name),
        sortVersion,
      });
    }
  }
  devices.sort((left, right) => {
    if (left.booted !== right.booted) return left.booted ? -1 : 1;
    for (let index = 0; index < 3; index += 1) {
      const delta = (right.sortVersion[index] ?? 0) - (left.sortVersion[index] ?? 0);
      if (delta !== 0) return delta;
    }
    return left.name.localeCompare(right.name);
  });
  return devices.map(({ sortVersion: _sortVersion, ...device }) => device);
}

function parseConsent(text: string): DeviceConsent {
  try {
    const value = JSON.parse(text) as Partial<DeviceConsent>;
    const streaming = value.streaming === true;
    // Agent access builds on streaming, so it never survives without it.
    return { streaming, agentAccess: streaming && value.agentAccess === true };
  } catch {
    return { streaming: false, agentAccess: false };
  }
}

const AGENT_ACCESS_OFF = "Agent access to simulators is off. Ask the user to allow it in the Simulator tab.";
const chatKey = (chatId: string) => createHash("sha256").update(chatId).digest("hex").slice(0, 24);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDeviceService(deps: DeviceServiceDeps): DeviceService {
  const consentPath = path.join(deps.baseDir, "consent.json");
  const host = deps.host;
  const listeners = new Set<(state: DeviceServiceState) => void>();
  const revealListeners = new Set<(chatId: string) => void>();
  let shimDir: string | null = null;
  let consent: DeviceConsent = { streaming: false, agentAccess: false };
  let hostState: DeviceHostState = { status: "needs-consent" };
  let unavailableReason: string | undefined;
  let devices: DeviceSummary[] = [];
  let sessions: DeviceSession[] = [];
  let loaded: Promise<void> | null = null;
  let starting: Promise<DeviceHostReady | null> | null = null;
  let proxy: Promise<DeviceHubProxy> | null = null;
  /** Bumped by every revoke, so a grant or agent start that raced one never outlives it. */
  let consentEpoch = 0;
  let saving: Promise<void> = Promise.resolve();
  let granting: Promise<unknown> = Promise.resolve();

  const snapshot = (): DeviceServiceState => ({
    hostStatus: hostState.status,
    hostStatuses: { [host.id]: { ...hostState } },
    consent: { ...consent },
    devices: devices.map((device) => ({ ...device })),
    sessions: sessions.map((session) => ({ ...session })),
    toolVersions: { hub: DEVICE_HUB.version, agent: AGENT_DEVICE.version },
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  });

  const emit = () => {
    const state = snapshot();
    for (const listener of listeners) listener(state);
  };

  const setHost = (next: DeviceHostState, reason?: string) => {
    hostState = next;
    unavailableReason = reason;
    emit();
  };

  host.onHealth((health, detail) => {
    if (!consent.streaming) return;
    if (health === "restarting") setHost({ status: "starting", detail: "Restarting the device hub…" });
    else if (health === "ready") setHost({ status: "ready" });
    else setHost({ status: "error", ...(detail ? { detail } : {}) });
  });

  async function idleStatus(): Promise<DeviceHostState> {
    if (!consent.streaming) return { status: "needs-consent" };
    if (host.current()) return { status: "ready" };
    return (await host.hubInstalled())
      ? { status: "stopped" }
      : { status: "needs-consent", detail: "The simulator helpers need to be installed again." };
  }

  function load(): Promise<void> {
    loaded ??= (async () => {
      consent = parseConsent(await readFile(consentPath, "utf8").catch(() => ""));
      hostState = await idleStatus();
      // After a relaunch the shim from the earlier grant still pins agent-device for run_command.
      const shim = path.join(deps.baseDir, "bin");
      if (consent.agentAccess && (await access(path.join(shim, "agent-device")).then(() => true, () => false))) {
        shimDir = shim;
      }
    })();
    return loaded;
  }

  /** Saves run one at a time, each writing the consent current when it runs. */
  function saveConsent(): Promise<void> {
    const next = saving.then(async () => {
      await mkdir(deps.baseDir, { recursive: true });
      const temporary = `${consentPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, ...consent }, null, 2)}\n`);
        await rename(temporary, consentPath);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    saving = next.catch(() => undefined);
    return next;
  }

  /** Starts the host. Without `allowInstall`, a missing install stops short of npm. */
  function start(allowInstall: boolean): Promise<DeviceHostReady | null> {
    const running = host.current();
    if (running) return Promise.resolve(running);
    starting ??= (async () => {
      try {
        if (!allowInstall && !(await host.hubInstalled())) {
          setHost(await idleStatus());
          return null;
        }
        const ready = await host.ensureReady(
          (phase, detail) => setHost({ status: phase, ...(detail ? { detail } : {}) }),
          { allowInstall },
        );
        setHost({ status: "ready" });
        return ready;
      } catch (error) {
        if (error instanceof DeviceToolsMissingError) setHost(await idleStatus());
        else if (error instanceof DeviceHostUnavailableError) setHost({ status: "unavailable" }, error.reason);
        else setHost({ status: "error", detail: errorMessage(error) });
        return null;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  async function listDevices(ready: DeviceHostReady): Promise<void> {
    const result = await ready.run("xcrun", ["simctl", "list", "devices", "--json"], {
      timeoutMs: SIMCTL_LIST_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error("Could not list simulators. Open Xcode once to finish its setup, then try again.");
    }
    devices = parseSimctlDevices(result.stdout, host.id);
    const known = new Set(devices.map((device) => `${device.hostId}\0${device.id}`));
    sessions = sessions.filter((session) => known.has(`${session.hostId}\0${session.deviceId}`));
    emit();
  }

  function requireReady(hostId: string): DeviceHostReady {
    if (hostId !== host.id) throw new Error(`Unknown device host ${hostId}.`);
    const ready = host.current();
    if (!consent.streaming || !ready) throw new Error("Set up simulator streaming first.");
    return ready;
  }

  /** Actions only reach simulators the last listing reported, and only booted ones. */
  function requireKnownDevice(hostId: string, deviceId: string): DeviceSummary {
    const device = devices.find((candidate) => candidate.hostId === hostId && candidate.id === deviceId);
    if (!device) throw new Error("That simulator is no longer available.");
    if (!device.booted) throw new Error("Open the simulator before changing its settings.");
    return device;
  }

  async function postHub(ready: DeviceHostReady, route: string, body: unknown, timeoutMs: number) {
    return deps.fetch(`${ready.hub.origin}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function postHubJson(ready: DeviceHostReady, route: string, body: unknown, timeoutMs: number) {
    const response = await postHub(ready, route, body, timeoutMs);
    let payload: { ok?: unknown; error?: unknown } = {};
    try {
      payload = JSON.parse(Buffer.from(await response.arrayBuffer()).toString("utf8")) as typeof payload;
    } catch {
      // Treated as a failure below.
    }
    if (!response.ok || payload.ok !== true) {
      const detail = typeof payload.error === "string" && payload.error ? `: ${payload.error}` : "";
      throw new Error(`The device hub refused ${route}${detail}.`);
    }
  }

  /** Starts agent-device and writes the shim. Callers publish `shimDir` only after rechecking consent. */
  async function prepareAgent(allowInstall: boolean, onPhase?: Parameters<DeviceHost["ensureAgentReady"]>[0]) {
    const ready = await host.ensureAgentReady(onPhase, { allowInstall });
    const shim = await ensureAgentDeviceShim({
      baseDir: deps.baseDir,
      nodePath: ready.nodePath,
      entryPath: ready.agentDevice.entryPath,
    });
    return { ready, shim };
  }

  async function stopHost(): Promise<void> {
    await host.stop();
    devices = [];
    sessions = [];
    const running = proxy;
    proxy = null;
    await running?.then((value) => value.close()).catch(() => undefined);
  }

  return {
    async load() {
      await load();
      return snapshot();
    },
    state: snapshot,
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async grantConsent(kind) {
      await load();
      if (kind === "agentAccess" && !consent.streaming) {
        throw new Error("Set up simulator streaming before allowing agent access.");
      }
      if (kind === "agentAccess") {
        // The only path that installs agent-device: an explicit grant from the Simulator tab.
        // Grants run one at a time, and a revoke that lands mid-grant wins.
        const grant = granting.then(async () => {
          const epoch = consentEpoch;
          let prepared: Awaited<ReturnType<typeof prepareAgent>>;
          try {
            prepared = await prepareAgent(true, (phase, detail) =>
              setHost({ status: phase, ...(detail ? { detail } : {}) }),
            );
          } catch (error) {
            setHost(await idleStatus());
            throw error instanceof DeviceHostUnavailableError ? new Error(error.reason) : error;
          }
          if (epoch !== consentEpoch || !consent.streaming) {
            await host.stopAgent();
            setHost(await idleStatus());
            throw new Error("Agent access was turned off while it was being set up.");
          }
          consent = { ...consent, agentAccess: true };
          shimDir = prepared.shim.shimDir;
          await saveConsent();
          setHost({ status: "ready" });
          return snapshot();
        });
        granting = grant.catch(() => undefined);
        return grant;
      }
      consent = { ...consent, [kind]: true };
      await saveConsent();
      emit();
      if (kind === "streaming") {
        const ready = await start(true);
        if (ready) await listDevices(ready).catch((error) => setHost({ status: "error", detail: errorMessage(error) }));
      }
      return snapshot();
    },
    async revokeConsent(kind) {
      await load();
      consentEpoch += 1;
      consent =
        kind === "streaming" ? { streaming: false, agentAccess: false } : { ...consent, agentAccess: false };
      shimDir = null;
      await saveConsent();
      if (kind === "streaming") await stopHost();
      else await host.stopAgent();
      // The per-host configs hold the daemon token.
      await rm(path.join(deps.baseDir, "hosts"), { recursive: true, force: true }).catch(() => undefined);
      setHost(await idleStatus());
      return snapshot();
    },
    async refresh() {
      await load();
      if (!consent.streaming) return snapshot();
      const ready = host.current() ?? (await start(false));
      if (!ready) return snapshot();
      try {
        await listDevices(ready);
      } catch (error) {
        setHost({ status: "error", detail: errorMessage(error) });
      }
      return snapshot();
    },
    async open(input) {
      await load();
      const hostId = input.hostId ?? host.id;
      const ready = requireReady(hostId);
      const existing = sessions.find(
        (session) =>
          session.chatId === input.chatId && session.hostId === hostId && session.deviceId === input.deviceId,
      );
      let device = devices.find((candidate) => candidate.hostId === hostId && candidate.id === input.deviceId);
      if (!device) {
        await listDevices(ready);
        device = devices.find((candidate) => candidate.hostId === hostId && candidate.id === input.deviceId);
      }
      if (!device) throw new Error("That simulator is no longer available.");
      if (!device.booted) {
        await postHubJson(
          ready,
          "/api/devices/boot",
          { platform: "ios", id: device.id, name: device.name },
          DEVICE_BOOT_TIMEOUT_MS,
        );
        devices = devices.map((candidate) => (candidate === device ? { ...candidate, booted: true } : candidate));
      }
      // The stream helper must be attached even when the simulator was already booted.
      await postHubJson(ready, "/vendor/serve-sim/grid/api/start", { udid: device.id }, HUB_REQUEST_TIMEOUT_MS);
      if (existing) {
        emit();
        return { ...existing };
      }
      const session: DeviceSession = { chatId: input.chatId, hostId, deviceId: device.id, openedBy: input.openedBy };
      sessions = [...sessions, session];
      emit();
      return { ...session };
    },
    async close(input) {
      await load();
      sessions = sessions.filter(
        (session) =>
          !(session.chatId === input.chatId && session.hostId === input.hostId && session.deviceId === input.deviceId),
      );
      if (input.shutdown) {
        const ready = requireReady(input.hostId);
        await ready.run("xcrun", ["simctl", "shutdown", input.deviceId], { timeoutMs: SIMCTL_SHUTDOWN_TIMEOUT_MS });
        devices = devices.map((device) =>
          device.hostId === input.hostId && device.id === input.deviceId ? { ...device, booted: false } : device,
        );
      }
      emit();
    },
    closeChat(chatId) {
      void rm(path.join(deps.baseDir, "screenshots", chatKey(chatId)), { recursive: true, force: true }).catch(
        () => undefined,
      );
      const remaining = sessions.filter((session) => session.chatId !== chatId);
      if (remaining.length === sessions.length) return;
      sessions = remaining;
      emit();
    },
    async action(input) {
      await load();
      const ready = requireReady(input.hostId);
      requireKnownDevice(input.hostId, input.deviceId);
      await runDeviceAction(ready, input);
      return readDeviceSettings(ready, input.deviceId);
    },
    async settings(input) {
      await load();
      const ready = requireReady(input.hostId);
      requireKnownDevice(input.hostId, input.deviceId);
      return readDeviceSettings(ready, input.deviceId);
    },
    sessionsForChat: (chatId) =>
      sessions.filter((session) => session.chatId === chatId).map((session) => ({ ...session })),
    async screenshot(input) {
      await load();
      const ready = requireReady(input.hostId);
      const response = await postHub(
        ready,
        "/vendor/serve-sim/api/screenshot",
        { udid: input.deviceId },
        HUB_REQUEST_TIMEOUT_MS,
      );
      if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("image/png")) {
        throw new Error("The simulator screenshot failed.");
      }
      return Buffer.from(await response.arrayBuffer());
    },
    async streamGrant() {
      await load();
      requireReady(host.id);
      proxy ??= deps.startProxy((hostId) => (hostId === host.id ? (host.current()?.hub.origin ?? null) : null));
      try {
        return (await proxy).mintGrant();
      } catch (error) {
        proxy = null;
        throw error;
      }
    },
    async agentTarget(input) {
      await load();
      if (!consent.streaming || !consent.agentAccess) throw new Error(AGENT_ACCESS_OFF);
      if (input.hostId !== host.id) throw new Error(`Unknown device host ${input.hostId}.`);
      const epoch = consentEpoch;
      let prepared: Awaited<ReturnType<typeof prepareAgent>>;
      try {
        // Never installs: a missing tool sends the user back to the Simulator tab.
        prepared = await prepareAgent(false);
      } catch (error) {
        if (error instanceof DeviceToolsMissingError) {
          throw new Error(
            `${error.tool} is not installed. Ask the user to turn agent access off and on in the Simulator tab.`,
          );
        }
        throw error;
      }
      if (epoch !== consentEpoch || !consent.streaming || !consent.agentAccess) {
        if (!consent.agentAccess) await host.stopAgent();
        throw new Error(AGENT_ACCESS_OFF);
      }
      shimDir = prepared.shim.shimDir;
      const config = agentDeviceConfigPath(deps.baseDir, input.hostId);
      await writeAgentDeviceConfig(config, prepared.ready.agentDevice);
      return {
        command: prepared.shim.command,
        args: ["--config", config, "--session", agentDeviceSession(input.chatId, input.hostId, input.deviceId)],
      };
    },
    agentShimDir: () => (consent.streaming && consent.agentAccess ? shimDir : null),
    async screenshotDir(chatId) {
      const directory = path.join(deps.baseDir, "screenshots", chatKey(chatId));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return directory;
    },
    reveal(chatId) {
      for (const listener of revealListeners) listener(chatId);
    },
    onReveal(listener) {
      revealListeners.add(listener);
      return () => revealListeners.delete(listener);
    },
    async stop() {
      await stopHost();
      shimDir = null;
      listeners.clear();
      revealListeners.clear();
    },
  };
}
