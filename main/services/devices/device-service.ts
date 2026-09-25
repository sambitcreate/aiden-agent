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
  type DeviceHostInfo,
  type DeviceHostState,
  type DeviceKind,
  type DeviceServiceState,
  type DeviceSession,
  type DeviceSettings,
  type DeviceStreamGrant,
  type DeviceSummary,
  type DeviceToolchainState,
} from "../../../renderer/shared/devices.js";
import {
  DeviceHostUnavailableError,
  DeviceToolsMissingError,
  type DeviceHost,
  type DeviceHostReady,
} from "./device-host.js";
import { readDeviceSettings, runDeviceAction } from "./device-actions.js";
import type { DeviceHubProxy, DeviceHubTarget } from "./device-hub-proxy.js";
import type { AidenRemoteSimulatorHost } from "../aiden-remote-simulators.js";
import type { DevicePeerPort } from "./peer-devices.js";
import { AGENT_DEVICE, DEVICE_HUB, installedToolVersions, pruneOldToolVersions } from "./device-toolchain.js";
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
  /** Paired desktops sharing their simulators. Absent in tests and when peers are unavailable. */
  peers?: DevicePeerPort;
  /** Starts the renderer-facing proxy lazily, the first time a stream grant is requested. */
  startProxy(
    resolveHub: (hostId: string) => DeviceHubTarget | null | Promise<DeviceHubTarget | null>,
  ): Promise<DeviceHubProxy>;
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
  /** Refreshes this Mac and every paired Mac. */
  refresh(): Promise<DeviceServiceState>;
  /** Refreshes this Mac only; never contacts paired Macs. */
  refreshLocal(): Promise<DeviceServiceState>;
  /** Contacts paired Macs only; never starts or installs anything locally. */
  refreshPeers(): Promise<DeviceServiceState>;
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
  /** The pinned helpers and what is installed on disk. Reads files only; never starts or installs. */
  toolchain(): Promise<DeviceToolchainState>;
  /** Deletes every installed helper version except the pinned ones. */
  pruneTools(): Promise<DeviceToolchainState>;
  /**
   * Turns every simulator permission off, stops both helpers, and deletes the
   * installs, the agent shim, and their state. The next grant installs again.
   */
  removeTools(): Promise<DeviceServiceState>;
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
  /** What paired desktops may reach while the owner shares this Mac's simulators. */
  shareHost(): AidenRemoteSimulatorHost;
  stop(): Promise<void>;
}

interface PeerEntry {
  name: string;
  state: DeviceHostState;
  devices: DeviceSummary[];
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

const NO_CONSENT: DeviceConsent = { streaming: false, agentAccess: false, peerSharing: false };

function parseConsent(text: string): DeviceConsent {
  try {
    const value = JSON.parse(text) as Partial<DeviceConsent>;
    const streaming = value.streaming === true;
    // Agent access and sharing build on streaming, so neither survives without it.
    return {
      streaming,
      agentAccess: streaming && value.agentAccess === true,
      peerSharing: streaming && value.peerSharing === true,
    };
  } catch {
    return { ...NO_CONSENT };
  }
}

const STREAMING_OFF = "Set up simulator streaming first.";
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
  let consent: DeviceConsent = { ...NO_CONSENT };
  let hostState: DeviceHostState = { status: "needs-consent" };
  let unavailableReason: string | undefined;
  /** This Mac's simulators. Paired Macs' simulators live in `peers`. */
  let devices: DeviceSummary[] = [];
  const peers = new Map<string, PeerEntry>();
  let peerRefresh: Promise<void> | null = null;
  /** Bumped whenever the peer list is forgotten, so an in-flight refresh or open cannot repopulate it. */
  let peerEpoch = 0;
  const sharingListeners = new Set<(sharing: boolean) => void>();
  let sharingWas = false;
  let sessions: DeviceSession[] = [];
  let loaded: Promise<void> | null = null;
  let starting: Promise<DeviceHostReady | null> | null = null;
  let proxy: Promise<DeviceHubProxy> | null = null;
  /** Bumped by every revoke, so a grant or agent start that raced one never outlives it. */
  let consentEpoch = 0;
  /** Bumped only by a streaming revoke, so an agent-access or sharing change never aborts an open. */
  let streamingEpoch = 0;
  let saving: Promise<void> = Promise.resolve();
  let granting: Promise<unknown> = Promise.resolve();
  /** A running "Remove installed tools"; grants wait for it so nothing reinstalls mid-delete. */
  let removing: Promise<DeviceServiceState> | null = null;
  /** Agent starts from `agentTarget`, which removal waits out before deleting their files. */
  const agentStarts = new Set<Promise<unknown>>();

  const hostList = (): DeviceHostInfo[] => [
    { id: host.id, kind: "local", name: "This Mac", ...hostState },
    ...[...peers].map(([id, entry]): DeviceHostInfo => ({ id, kind: "peer", name: entry.name, ...entry.state })),
  ];
  const allDevices = (): DeviceSummary[] => [...devices, ...[...peers.values()].flatMap((entry) => entry.devices)];

  const snapshot = (): DeviceServiceState => ({
    hostStatus: hostState.status,
    hostStatuses: Object.fromEntries(hostList().map(({ id, status, detail }) => [id, detail ? { status, detail } : { status }])),
    hosts: hostList(),
    consent: { ...consent },
    devices: allDevices().map((device) => ({ ...device })),
    sessions: sessions.map((session) => ({ ...session })),
    toolVersions: { hub: DEVICE_HUB.version, agent: AGENT_DEVICE.version },
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  });

  const sharing = () => consent.streaming && consent.peerSharing;

  const emit = () => {
    const state = snapshot();
    for (const listener of listeners) listener(state);
    const now = sharing();
    if (now !== sharingWas) {
      sharingWas = now;
      for (const listener of sharingListeners) listener(now);
    }
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
      sharingWas = sharing();
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
      const epoch = consentEpoch;
      try {
        if (!consent.streaming) return null;
        if (!allowInstall && !(await host.hubInstalled())) {
          setHost(await idleStatus());
          return null;
        }
        // A revoke during the install check wins before npm is contacted.
        if (epoch !== consentEpoch || !consent.streaming) return null;
        const ready = await host.ensureReady(
          (phase, detail) => setHost({ status: phase, ...(detail ? { detail } : {}) }),
          { allowInstall },
        );
        if (epoch !== consentEpoch || !consent.streaming) {
          // Streaming was turned off while the hub installed or started; the revoke wins.
          await host.stop();
          setHost(await idleStatus());
          return null;
        }
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
    const known = new Set(devices.map((device) => device.id));
    sessions = sessions.filter((session) => session.hostId !== host.id || known.has(session.deviceId));
    emit();
  }

  function peerPort(): DevicePeerPort {
    if (!deps.peers) throw new Error("Paired Macs are unavailable.");
    return deps.peers;
  }

  function requirePeer(hostId: string): PeerEntry {
    // Paired Macs are part of simulator streaming; revoking it disconnects them too.
    if (!consent.streaming) throw new Error(STREAMING_OFF);
    const entry = peers.get(hostId);
    if (!entry) throw new Error(`Unknown device host ${hostId}.`);
    if (entry.state.status !== "ready") {
      throw new Error(entry.state.detail ?? `${entry.name} is not sharing simulators right now.`);
    }
    return entry;
  }

  function setPeerDevices(hostId: string, entry: PeerEntry, next: DeviceSummary[]): void {
    entry.devices = next;
    const known = new Set(next.map((device) => device.id));
    sessions = sessions.filter((session) => session.hostId !== hostId || known.has(session.deviceId));
  }

  async function refreshLocalHost(): Promise<void> {
    if (consent.streaming) {
      const ready = host.current() ?? (await start(false));
      if (ready) {
        try {
          await listDevices(ready);
        } catch (error) {
          setHost({ status: "error", detail: errorMessage(error) });
        }
      }
    }
  }

  /** Closes the renderer's proxied streams to a paired Mac that is gone or no longer ready. */
  function closePeerStreams(hostId: string): void {
    void proxy?.then(
      (running) => running.closeHost(hostId),
      () => undefined,
    );
  }

  function forgetPeers(): void {
    peerEpoch += 1;
    peerRefresh = null;
    for (const id of peers.keys()) closePeerStreams(id);
    peers.clear();
    sessions = sessions.filter((session) => session.hostId === host.id);
  }

  /** Lists every enabled paired Mac. Hosts whose Aiden cannot share simulators are left out. */
  function refreshPeerHosts(): Promise<void> {
    if (!deps.peers) return Promise.resolve();
    if (!consent.streaming) {
      forgetPeers();
      return Promise.resolve();
    }
    const port = deps.peers;
    if (peerRefresh) return peerRefresh;
    const epoch = peerEpoch;
    const current = () => epoch === peerEpoch && consent.streaming;
    let run: Promise<void> | null = null;
    run = (async () => {
      const wasReady = new Set([...peers].filter(([, entry]) => entry.state.status === "ready").map(([id]) => id));
      try {
        const hosts = await port.hosts().catch(() => []);
        if (!current()) return;
        const present = new Set(hosts.map((peer) => peer.id));
        for (const id of [...peers.keys()]) {
          if (!present.has(id)) {
            peers.delete(id);
            sessions = sessions.filter((session) => session.hostId !== id);
          }
        }
        await Promise.all(
          hosts.map(async (peer) => {
            const entry = peers.get(peer.id) ?? { name: peer.name, state: { status: "starting" }, devices: [] };
            entry.name = peer.name;
            try {
              const listing = await port.list(peer.id);
              // A revoke while this Mac was answering must not bring it back.
              if (!current()) return;
              if (!listing) {
                peers.delete(peer.id);
                sessions = sessions.filter((session) => session.hostId !== peer.id);
                return;
              }
              peers.set(peer.id, entry);
              if (!listing.sharing) {
                entry.state = { status: "needs-consent", detail: `Simulator sharing is off on ${peer.name}.` };
                setPeerDevices(peer.id, entry, []);
                return;
              }
              entry.state = listing.detail ? { status: listing.status, detail: listing.detail } : { status: listing.status };
              setPeerDevices(
                peer.id,
                entry,
                listing.devices.map((device) => ({ ...device, hostId: peer.id, platform: "ios" as const })),
              );
            } catch {
              if (!current()) return;
              peers.set(peer.id, entry);
              entry.state = { status: "unavailable", detail: `Could not reach ${peer.name}.` };
              setPeerDevices(peer.id, entry, []);
            }
          }),
        );
        for (const id of wasReady) {
          if (peers.get(id)?.state.status !== "ready") closePeerStreams(id);
        }
      } finally {
        if (peerRefresh === run) peerRefresh = null;
        emit();
      }
    })();
    peerRefresh = run;
    return run;
  }

  /** Boots the simulator if needed and attaches the stream helper. */
  async function attach(ready: DeviceHostReady, device: DeviceSummary): Promise<DeviceSummary> {
    let attached = device;
    if (!device.booted) {
      await postHubJson(
        ready,
        "/api/devices/boot",
        { platform: "ios", id: device.id, name: device.name },
        DEVICE_BOOT_TIMEOUT_MS,
      );
      attached = { ...device, booted: true };
      devices = devices.map((candidate) => (candidate.id === device.id ? attached : candidate));
    }
    // The stream helper must be attached even when the simulator was already booted.
    await postHubJson(ready, "/vendor/serve-sim/grid/api/start", { udid: device.id }, HUB_REQUEST_TIMEOUT_MS);
    return attached;
  }

  async function shutdownLocal(ready: DeviceHostReady, deviceId: string): Promise<void> {
    const result = await ready.run("xcrun", ["simctl", "shutdown", deviceId], { timeoutMs: SIMCTL_SHUTDOWN_TIMEOUT_MS });
    if (result.code !== 0) throw new Error("The simulator did not shut down.");
    devices = devices.map((device) => (device.id === deviceId ? { ...device, booted: false } : device));
  }

  function requireSharing(): DeviceHostReady {
    if (!sharing()) throw new Error("Simulator sharing is off.");
    const ready = host.current();
    if (!ready) throw new Error("The simulator hub is not running.");
    return ready;
  }

  const share: AidenRemoteSimulatorHost = {
    sharing,
    async list() {
      await load();
      if (!sharing()) return { sharing: false, status: hostState.status, devices: [] };
      const ready = host.current() ?? (await start(false));
      if (ready) {
        await listDevices(ready).catch((error) => setHost({ status: "error", detail: errorMessage(error) }));
      }
      return {
        sharing: sharing(),
        status: hostState.status,
        devices: sharing() ? devices.map(({ hostId: _hostId, ...device }) => device) : [],
      };
    },
    async open(deviceId) {
      const ready = requireSharing();
      const device = devices.find((candidate) => candidate.id === deviceId);
      if (!device) throw new Error("That simulator is no longer available.");
      const { hostId: _hostId, ...attached } = await attach(ready, device);
      emit();
      return attached;
    },
    async shutdown(deviceId) {
      const ready = requireSharing();
      if (!devices.some((device) => device.id === deviceId)) throw new Error("That simulator is no longer available.");
      await shutdownLocal(ready, deviceId);
      emit();
    },
    async settings(deviceId) {
      const ready = requireSharing();
      requireKnownDevice(host.id, deviceId);
      return readDeviceSettings(ready, deviceId);
    },
    async action(input) {
      const ready = requireSharing();
      const local = { ...input, hostId: host.id };
      requireKnownDevice(host.id, local.deviceId);
      await runDeviceAction(ready, local);
      return readDeviceSettings(ready, local.deviceId);
    },
    hubOrigin: () => (sharing() ? (host.current()?.hub.origin ?? null) : null),
    isKnownDevice: (deviceId) => sharing() && devices.some((device) => device.id === deviceId),
    onSharingChanged(listener) {
      sharingListeners.add(listener);
      return () => sharingListeners.delete(listener);
    },
  };

  function requireReady(hostId: string): DeviceHostReady {
    if (hostId !== host.id) throw new Error(`Unknown device host ${hostId}.`);
    const ready = host.current();
    if (!consent.streaming || !ready) throw new Error("Set up simulator streaming first.");
    return ready;
  }

  function requirePeerDevice(hostId: string, deviceId: string): DeviceSummary {
    const device = requirePeer(hostId).devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new Error("That simulator is no longer available.");
    if (!device.booted) throw new Error("Open the simulator before changing its settings.");
    return device;
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

  async function revoke(kind: DeviceConsentKind): Promise<DeviceServiceState> {
    await load();
    consentEpoch += 1;
    if (kind === "streaming") streamingEpoch += 1;
    if (kind === "peerSharing") {
      consent = { ...consent, peerSharing: false };
      await saveConsent();
      emit();
      return snapshot();
    }
    consent = kind === "streaming" ? { ...NO_CONSENT } : { ...consent, agentAccess: false };
    if (kind === "streaming") forgetPeers();
    shimDir = null;
    await saveConsent();
    // Sharing ends before the hub stops, so relays close first.
    emit();
    if (kind === "streaming") await stopHost();
    else await host.stopAgent();
    // The per-host configs hold the daemon token.
    await rm(path.join(deps.baseDir, "hosts"), { recursive: true, force: true }).catch(() => undefined);
    setHost(await idleStatus());
    return snapshot();
  }

  async function readToolchain(): Promise<DeviceToolchainState> {
    const [hub, agent] = await Promise.all([
      installedToolVersions(deps.baseDir, DEVICE_HUB),
      installedToolVersions(deps.baseDir, AGENT_DEVICE),
    ]);
    return {
      tools: [
        { id: "hub", name: DEVICE_HUB.name, pinned: DEVICE_HUB.version, installed: hub },
        { id: "agent", name: AGENT_DEVICE.name, pinned: AGENT_DEVICE.version, installed: agent },
      ],
    };
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
      await removing?.catch(() => undefined);
      if (kind === "agentAccess" && !consent.streaming) {
        throw new Error("Set up simulator streaming before allowing agent access.");
      }
      if (kind === "peerSharing" && !consent.streaming) {
        throw new Error("Set up simulator streaming before sharing with paired Macs.");
      }
      if (kind === "agentAccess") {
        // The only path that installs agent-device: an explicit grant from the Simulator tab.
        // Grants run one at a time, and a revoke that lands mid-grant wins.
        const epoch = consentEpoch;
        const grant = granting.then(async () => {
          // A revoke queued ahead of this grant, or streaming turned off meanwhile, wins before npm.
          if (epoch !== consentEpoch || !consent.streaming) {
            throw new Error("Agent access was turned off while it was being set up.");
          }
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
            // A streaming revoke also stops the hub this grant may have started.
            if (consent.streaming) await host.stopAgent();
            else await stopHost();
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
      const epoch = consentEpoch;
      consent = { ...consent, [kind]: true };
      await saveConsent();
      emit();
      // A revoke or removal that landed while this grant was saving wins; nothing is installed.
      if (epoch !== consentEpoch) return snapshot();
      if (kind === "streaming") {
        const ready = await start(true);
        if (ready) await listDevices(ready).catch((error) => setHost({ status: "error", detail: errorMessage(error) }));
      }
      return snapshot();
    },
    revokeConsent: revoke,
    toolchain: readToolchain,
    async pruneTools() {
      await Promise.all([
        pruneOldToolVersions(deps.baseDir, DEVICE_HUB),
        pruneOldToolVersions(deps.baseDir, AGENT_DEVICE),
      ]);
      return readToolchain();
    },
    removeTools() {
      removing ??= (async () => {
        try {
          await revoke("streaming");
          // Any install or start already under way finishes, and loses to the revoke, before deleting.
          await granting;
          await starting?.catch(() => undefined);
          await Promise.all([...agentStarts].map((running) => running.catch(() => undefined)));
          await stopHost();
          const results = await Promise.allSettled(
            ["tools", "bin", "agent-state", "hosts", "screenshots", "hub.json"].map((entry) =>
              rm(path.join(deps.baseDir, entry), { recursive: true, force: true }),
            ),
          );
          shimDir = null;
          setHost(await idleStatus());
          const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failed) throw new Error(`Some simulator tool files could not be deleted: ${errorMessage(failed.reason)}`);
          return snapshot();
        } finally {
          removing = null;
        }
      })();
      return removing;
    },
    async refresh() {
      await load();
      const peersDone = refreshPeerHosts();
      await refreshLocalHost();
      await peersDone;
      return snapshot();
    },
    async refreshLocal() {
      await load();
      await refreshLocalHost();
      return snapshot();
    },
    async refreshPeers() {
      await load();
      await refreshPeerHosts();
      return snapshot();
    },
    async open(input) {
      await load();
      const hostId = input.hostId ?? host.id;
      if (hostId !== host.id) {
        const entry = requirePeer(hostId);
        if (!entry.devices.some((device) => device.id === input.deviceId)) {
          throw new Error("That simulator is no longer available.");
        }
        const epoch = peerEpoch;
        const opened = await peerPort().open(hostId, input.deviceId);
        if (epoch !== peerEpoch || !consent.streaming || peers.get(hostId) !== entry) {
          throw new Error("Simulator streaming was turned off while opening.");
        }
        entry.devices = entry.devices.map((device) =>
          device.id === opened.id ? { ...opened, hostId, platform: "ios" } : device,
        );
        const existing = sessions.find(
          (session) => session.chatId === input.chatId && session.hostId === hostId && session.deviceId === opened.id,
        );
        if (existing) {
          emit();
          return { ...existing };
        }
        const session: DeviceSession = { chatId: input.chatId, hostId, deviceId: opened.id, openedBy: input.openedBy };
        sessions = [...sessions, session];
        emit();
        return { ...session };
      }
      const ready = requireReady(hostId);
      const epoch = streamingEpoch;
      let device = devices.find((candidate) => candidate.hostId === hostId && candidate.id === input.deviceId);
      if (!device) {
        await listDevices(ready);
        device = devices.find((candidate) => candidate.hostId === hostId && candidate.id === input.deviceId);
      }
      if (!device) throw new Error("That simulator is no longer available.");
      await attach(ready, device);
      // A revoke while the simulator booted wins; never register a session after it.
      if (epoch !== streamingEpoch || !consent.streaming) {
        throw new Error("Simulator streaming was turned off while opening.");
      }
      // Looked up after the boot, so concurrent opens share one session and a close meanwhile sticks.
      const existing = sessions.find(
        (session) =>
          session.chatId === input.chatId && session.hostId === hostId && session.deviceId === input.deviceId,
      );
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
      if (input.shutdown && input.hostId !== host.id) {
        const entry = requirePeer(input.hostId);
        await peerPort().shutdown(input.hostId, input.deviceId);
        entry.devices = entry.devices.map((device) =>
          device.id === input.deviceId ? { ...device, booted: false } : device,
        );
      } else if (input.shutdown) {
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
      if (input.hostId !== host.id) {
        requirePeerDevice(input.hostId, input.deviceId);
        return peerPort().action(input.hostId, input);
      }
      const ready = requireReady(input.hostId);
      requireKnownDevice(input.hostId, input.deviceId);
      await runDeviceAction(ready, input);
      return readDeviceSettings(ready, input.deviceId);
    },
    async settings(input) {
      await load();
      if (input.hostId !== host.id) {
        requirePeerDevice(input.hostId, input.deviceId);
        return peerPort().settings(input.hostId, input.deviceId);
      }
      const ready = requireReady(input.hostId);
      requireKnownDevice(input.hostId, input.deviceId);
      return readDeviceSettings(ready, input.deviceId);
    },
    sessionsForChat: (chatId) =>
      sessions.filter((session) => session.chatId === chatId).map((session) => ({ ...session })),
    async screenshot(input) {
      await load();
      if (input.hostId !== host.id) {
        requirePeer(input.hostId);
        return peerPort().screenshot(input.hostId, input.deviceId);
      }
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
      const localReady = consent.streaming && host.current() !== null;
      const peerReady = consent.streaming && [...peers.values()].some((entry) => entry.state.status === "ready");
      if (!localReady && !peerReady) requireReady(host.id);
      proxy ??= deps.startProxy((hostId) => {
        if (hostId === host.id) return consent.streaming ? (host.current()?.hub.origin ?? null) : null;
        // A paired Mac is reachable only after a refresh reported it ready.
        if (!consent.streaming || peers.get(hostId)?.state.status !== "ready" || !deps.peers) return null;
        return deps.peers.upstream(hostId);
      });
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
      if (removing) throw new Error(AGENT_ACCESS_OFF);
      const epoch = consentEpoch;
      let prepared: Awaited<ReturnType<typeof prepareAgent>>;
      // Never installs: a missing tool sends the user back to the Simulator tab.
      const preparing = prepareAgent(false);
      agentStarts.add(preparing);
      try {
        prepared = await preparing;
      } catch (error) {
        if (error instanceof DeviceToolsMissingError) {
          throw new Error(
            `${error.tool} is not installed. Ask the user to turn agent access off and on in the Simulator tab.`,
          );
        }
        throw error;
      } finally {
        agentStarts.delete(preparing);
      }
      if (epoch !== consentEpoch || !consent.streaming || !consent.agentAccess) {
        // Stops whatever this call started: the hub too once streaming is off.
        if (!consent.streaming) await stopHost();
        else if (!consent.agentAccess) await host.stopAgent();
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
    shareHost: () => share,
    async stop() {
      for (const listener of sharingListeners) listener(false);
      sharingListeners.clear();
      await stopHost();
      shimDir = null;
      peerEpoch += 1;
      peerRefresh = null;
      peers.clear();
      listeners.clear();
      revealListeners.clear();
    },
  };
}
