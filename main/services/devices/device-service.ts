/**
 * Simulator discovery, consent, and per-chat device sessions for the
 * Simulator tab and, in Phase 4, the agent's device tools.
 *
 * Nothing starts on its own. The hub is installed only from the explicit
 * streaming consent action; a refresh may start an already-installed hub
 * (a local spawn) but never contacts npm. Consent is device-local, stored in
 * `userData/devices/consent.json`, because the installs it authorizes are.
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  DEVICE_ID_PATTERN,
  LOCAL_DEVICE_HOST_ID,
  deviceActionSupported,
  type DeviceConsent,
  type DeviceActionInput,
  type DevicePlatformAvailability,
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
import { isEmulatorSerial, readAndroidDeviceSettings, runAndroidDeviceAction } from "./android-device-actions.js";
import type { DeviceHubProxy, DeviceHubTarget } from "./device-hub-proxy.js";
import {
  MOBILE_SIMULATOR_REFUSAL,
  type AidenRemoteSimulatorAudience,
  type AidenRemoteSimulatorHost,
} from "../aiden-remote-simulators.js";
import { AidenRemoteServiceError } from "../aiden-remote-errors.js";
import type { DevicePeerPort } from "./peer-devices.js";
import {
  AGENT_DEVICE,
  DEVICE_HUB,
  deviceToolPaths,
  installedToolVersions,
  isToolInstalled,
} from "./device-toolchain.js";
import { runToolMaintenance, type ToolMaintenanceSpec } from "./device-tool-maintenance.js";
import type { SshDeviceHost } from "./ssh-device-host.js";
import {
  readSshHosts,
  writeSshHosts,
  type SshHostToolConsent,
  type StoredSshHosts,
} from "./ssh-host-store.js";
import {
  deviceToolInstallMessage,
  toolNeedsUpdate,
  updateSshDeviceHosts,
  type DeviceHostCheck,
  type DeviceToolVersions,
  type SshDeviceHostConfig,
} from "../../../renderer/shared/device-ssh-hosts.js";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  ensureAgentDeviceShim,
  writeAgentDeviceConfig,
} from "./agent-device-shim.js";
import { writeJsonAtomic } from "../durable-fs.js";

export const DEVICE_BOOT_TIMEOUT_MS = 3 * 60_000;
const HUB_REQUEST_TIMEOUT_MS = 30_000;
const SIMCTL_LIST_TIMEOUT_MS = 30_000;
const SIMCTL_SHUTDOWN_TIMEOUT_MS = 60_000;
/** The hub lists AVDs with `avdmanager`, a JVM tool that is slow to start. */
const ANDROID_LIST_TIMEOUT_MS = 45_000;
/** Shutting an emulator down saves its snapshot first. */
const ANDROID_SHUTDOWN_TIMEOUT_MS = 90_000;

/** The device an agent opened, so the renderer can float or select exactly that one. */
export interface DeviceRevealTarget {
  hostId: string;
  deviceId: string;
}

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
    init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; signal: AbortSignal },
  ): Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;
  /** SSH device hosts. Absent in tests that only cover this Mac and paired Macs. */
  ssh?: DeviceSshPort;
  /** Electron-as-Node, which runs the local agent-device shim and tool maintenance. */
  nodePath?: string;
  /** Reclaims old helper versions under the maintenance lock; injectable for tests. */
  runMaintenance?(input: {
    nodePath: string;
    toolsRoot: string;
    specs: readonly ToolMaintenanceSpec[];
    policy: "prune" | "reclaim";
  }): Promise<string[]>;
}

/** What the service needs to manage SSH hosts. Nothing here contacts a host until a method runs. */
export interface DeviceSshPort {
  create(config: SshDeviceHostConfig): SshDeviceHost;
  /** Resolves the target with `ssh -G` and a name lookup; true when it is this Mac. */
  isLocalTarget(config: SshDeviceHostConfig): Promise<boolean>;
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
  /**
   * The running host and one simulator this Mac listed, for device features
   * that run `simctl` directly (erase, clipboard, recording). Paired Macs are
   * refused; `booted` also refuses a simulator that is shut down.
   */
  localTarget(input: { hostId: string; deviceId: string; booted?: boolean }): Promise<{
    ready: DeviceHostReady;
    device: DeviceSummary;
  }>;
  /**
   * Shuts one device on this Mac down the way the Shut down control does: an
   * Android emulator through the hub, which waits until adb loses it. Sessions
   * on it end when the listing drops its id.
   */
  shutdownLocal(input: { hostId: string; deviceId: string }): Promise<void>;
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
  /** Asks the renderer to show a chat's device: floating over the chat, or in its tab. */
  reveal(chatId: string, target?: DeviceRevealTarget): void;
  onReveal(listener: (chatId: string, target?: DeviceRevealTarget) => void): () => void;
  /**
   * What one Aiden Remote audience may reach while the owner shares this
   * Mac's simulators with it: paired desktops (`peerSharing`, the default) or
   * Aiden On The Go phones (`mobileSharing`).
   */
  shareHost(audience?: AidenRemoteSimulatorAudience): AidenRemoteSimulatorHost;
  /**
   * An explicit Start or Retry for one host. When the user already approved a
   * helper's install, an outdated version is updated here, with progress.
   */
  startHost(hostId: string): Promise<DeviceServiceState>;
  /** Installs (or updates) a pinned helper on one host after the user confirmed it. */
  updateTool(input: { hostId: string; tool: "hub" | "agent" }): Promise<DeviceServiceState>;
  /** Reads helper versions: from disk for this Mac, over SSH for SSH hosts. Changes nothing. */
  inspectTools(): Promise<DeviceServiceState>;
  /** Adds or edits an SSH host. An edited destination disconnects the old one first. */
  saveSshHost(config: SshDeviceHostConfig): Promise<DeviceServiceState>;
  /** Disconnects an SSH host, stops its helpers there, and forgets it. */
  removeSshHost(hostId: string): Promise<DeviceServiceState>;
  /** **Test connection**: checks Node, npm, Xcode, and versions without installing or starting anything. */
  testSshHost(config: SshDeviceHostConfig): Promise<DeviceHostCheck>;
  stop(): Promise<void>;
}

interface SshEntry {
  config: SshDeviceHostConfig;
  host: SshDeviceHost;
  state: DeviceHostState;
  devices: DeviceSummary[];
  toolInspectionError?: string;
  unsubscribe(): void;
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

interface HubDeviceList {
  emulators?: unknown;
  errors?: unknown;
}

/**
 * Adapted from t3code DeviceService `fetchDevices` @ a6ec88f7 (MIT). Android
 * emulators from the hub's `/api/devices`, plus AVDs it leaves out (it skips
 * ones that never booted), from `emulator -list-avds`. A running emulator's id
 * is its adb serial; a stopped one's is its AVD name. Physical phones are left
 * out. Booted first, then by name.
 */
export function parseAndroidDevices(
  hubList: unknown,
  listAvds: string,
  hostId: string = LOCAL_DEVICE_HOST_ID,
): DeviceSummary[] {
  const emulators = (hubList as HubDeviceList | null)?.emulators;
  const devices: DeviceSummary[] = [];
  for (const entry of Array.isArray(emulators) ? (emulators as Record<string, unknown>[]) : []) {
    if (typeof entry !== "object" || entry === null || entry.platform !== "android" || entry.physical === true) continue;
    const { id, name, version, booted } = entry;
    if (typeof id !== "string" || !DEVICE_ID_PATTERN.test(id) || typeof name !== "string" || !name) continue;
    if (devices.some((device) => device.id === id)) continue;
    devices.push({
      hostId,
      id,
      name,
      platform: "android",
      version: typeof version === "string" && version ? version : "Android",
      booted: booted === true,
      kind: "other",
    });
  }
  for (const line of listAvds.split(/\r?\n/u)) {
    const name = line.trim();
    if (!DEVICE_ID_PATTERN.test(name) || devices.some((device) => device.name === name)) continue;
    devices.push({ hostId, id: name, name, platform: "android", version: "Android", booted: false, kind: "other" });
  }
  return devices.sort((left, right) =>
    left.booted !== right.booted ? (left.booted ? -1 : 1) : left.name.localeCompare(right.name),
  );
}

export type DeviceBootFailure = "disk_space" | "timeout" | "launch_failed";

/** Adapted from t3code DeviceService `boot` @ a6ec88f7 (MIT): what the hub's boot error means. */
export function classifyBootFailure(error: string): DeviceBootFailure {
  if (/insufficient.*(?:disk|space)|not enough.*(?:disk|space)|no space left/iu.test(error)) return "disk_space";
  if (/timed? out|timeout/iu.test(error)) return "timeout";
  return "launch_failed";
}

const BOOT_FAILURE_MESSAGES: Record<DeviceBootFailure, string> = {
  disk_space: "There is not enough free disk space on this Mac.",
  timeout: "The device did not become ready in time.",
  launch_failed: "The simulator or emulator could not start. Check its configuration in Xcode or Android Studio.",
};

interface HubResult {
  ok?: unknown;
  id?: unknown;
  serial?: unknown;
  error?: unknown;
}

/** The hub answered a lifecycle request with `ok: false` or a failing status. */
class HubRefusedError extends Error {
  constructor(
    readonly route: string,
    readonly detail: string,
  ) {
    super(`The device hub refused ${route}${detail ? `: ${detail}` : ""}.`);
    this.name = "HubRefusedError";
  }
}

const NO_CONSENT: DeviceConsent = { streaming: false, agentAccess: false, peerSharing: false, mobileSharing: false };

function parseConsent(text: string): DeviceConsent {
  try {
    const value = JSON.parse(text) as Partial<DeviceConsent>;
    const streaming = value.streaming === true;
    // Agent access and sharing build on streaming, so neither survives without it.
    return {
      streaming,
      agentAccess: streaming && value.agentAccess === true,
      peerSharing: streaming && value.peerSharing === true,
      mobileSharing: streaming && value.mobileSharing === true,
    };
  } catch {
    return { ...NO_CONSENT };
  }
}

const STREAMING_OFF = "Set up simulator streaming first.";
const SSH_IDLE: DeviceHostState = { status: "stopped", detail: "Not connected. Aiden connects only when you ask." };
const NO_SSH_CONSENT: SshHostToolConsent = { hub: false, agent: false };
/** Tunnels close at once; the remote cleanup gets this long before a revoke or quit moves on. */
const SSH_STOP_BUDGET_MS = 5_000;

function withinBudget(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
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
  const revealListeners = new Set<(chatId: string, target?: DeviceRevealTarget) => void>();
  let shimDir: string | null = null;
  let consent: DeviceConsent = { ...NO_CONSENT };
  let hostState: DeviceHostState = { status: "needs-consent" };
  let unavailableReason: string | undefined;
  /** Which platforms this Mac can run, from the latest listing. */
  let platforms: DevicePlatformAvailability[] | undefined;
  /** This Mac's simulators. Paired Macs' simulators live in `peers`. */
  let devices: DeviceSummary[] = [];
  const peers = new Map<string, PeerEntry>();
  let peerRefresh: Promise<void> | null = null;
  /** Bumped whenever the peer list is forgotten, so an in-flight refresh or open cannot repopulate it. */
  let peerEpoch = 0;
  const SHARE_AUDIENCES = ["desktop", "mobile"] as const satisfies readonly AidenRemoteSimulatorAudience[];
  const sharingListeners: Record<AidenRemoteSimulatorAudience, Set<(sharing: boolean) => void>> = {
    desktop: new Set(),
    mobile: new Set(),
  };
  const sharingWas: Record<AidenRemoteSimulatorAudience, boolean> = { desktop: false, mobile: false };
  let sessions: DeviceSession[] = [];
  /** Bumped per session and per chat by every close, so an open still booting never undoes one. */
  const closes = new Map<string, number>();
  const sessionKey = (chatId: string, hostId: string, deviceId: string) =>
    JSON.stringify([chatId, hostId, deviceId]);
  const chatCloseKey = (chatId: string) => JSON.stringify([chatId]);
  const closeCount = (chatId: string, hostId: string, deviceId: string) =>
    (closes.get(sessionKey(chatId, hostId, deviceId)) ?? 0) + (closes.get(chatCloseKey(chatId)) ?? 0);
  const bumpClose = (key: string) => closes.set(key, (closes.get(key) ?? 0) + 1);
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
  /** SSH device hosts, in the order Settings lists them. Nothing connects until the user asks. */
  const ssh = new Map<string, SshEntry>();
  let sshStored: StoredSshHosts = { hosts: [], toolConsent: {} };
  /** Bumped when SSH hosts are disconnected by a revoke, so an in-flight connect cannot bring one back. */
  let sshEpoch = 0;
  /** This Mac's helper versions, read from disk only. */
  let localTools: DeviceToolVersions | undefined;
  let localToolsError: string | undefined;
  const nodePath = deps.nodePath ?? process.execPath;
  const maintain = deps.runMaintenance ?? ((input) => runToolMaintenance(input));

  const sshInfo = (entry: SshEntry): DeviceHostInfo => {
    const tools = entry.host.tools();
    return {
      id: entry.config.id,
      kind: "ssh",
      name: entry.config.label,
      ...entry.state,
      ...(tools ? { tools } : {}),
      ...(entry.toolInspectionError ? { toolInspectionError: entry.toolInspectionError } : {}),
    };
  };
  // This Mac first, then paired Macs, then SSH hosts.
  const hostList = (): DeviceHostInfo[] => [
    {
      id: host.id,
      kind: "local",
      name: "This Mac",
      ...hostState,
      ...(localTools ? { tools: localTools } : {}),
      ...(localToolsError ? { toolInspectionError: localToolsError } : {}),
      ...(platforms ? { platforms: platforms.map((entry) => ({ ...entry })) } : {}),
    },
    ...[...peers].map(([id, entry]): DeviceHostInfo => ({ id, kind: "peer", name: entry.name, ...entry.state })),
    ...[...ssh.values()].map(sshInfo),
  ];
  const allDevices = (): DeviceSummary[] => [
    ...devices,
    ...[...peers.values()].flatMap((entry) => entry.devices),
    ...[...ssh.values()].flatMap((entry) => entry.devices),
  ];

  const snapshot = (): DeviceServiceState => ({
    hostStatus: hostState.status,
    hostStatuses: Object.fromEntries(hostList().map(({ id, status, detail }) => [id, detail ? { status, detail } : { status }])),
    hosts: hostList(),
    consent: { ...consent },
    devices: allDevices().map((device) => ({ ...device })),
    sessions: sessions.map((session) => ({ ...session })),
    toolVersions: { hub: DEVICE_HUB.version, agent: AGENT_DEVICE.version },
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    sshHosts: sshStored.hosts.map((config) => ({ ...config })),
  });

  /** Each audience has its own consent, and both build on streaming. */
  const sharingFor = (audience: AidenRemoteSimulatorAudience) =>
    consent.streaming && (audience === "mobile" ? consent.mobileSharing === true : consent.peerSharing);

  const emit = () => {
    const state = snapshot();
    for (const listener of listeners) listener(state);
    for (const audience of SHARE_AUDIENCES) {
      const now = sharingFor(audience);
      if (now === sharingWas[audience]) continue;
      sharingWas[audience] = now;
      for (const listener of sharingListeners[audience]) listener(now);
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
    if (await host.hubInstalled()) return { status: "stopped" };
    // Streaming consent already covers the hub, so an outdated install updates on the next Start.
    const installed = await installedToolVersions(deps.baseDir, DEVICE_HUB);
    const previous = installed[installed.length - 1];
    return previous
      ? {
          status: "stopped",
          detail: `${DEVICE_HUB.name} ${DEVICE_HUB.version} replaces ${previous} when you choose Start.`,
        }
      : { status: "needs-consent", detail: "The simulator helpers need to be installed again." };
  }

  async function readLocalTools(): Promise<DeviceToolVersions> {
    const [hub, agent] = await Promise.all([
      installedToolVersions(deps.baseDir, DEVICE_HUB),
      installedToolVersions(deps.baseDir, AGENT_DEVICE),
    ]);
    const running = host.runningToolVersions?.() ?? {
      hub: host.current() ? DEVICE_HUB.version : null,
      agent: null,
    };
    return {
      hub: { requiredVersion: DEVICE_HUB.version, installedVersions: hub, runningVersion: running.hub },
      agent: { requiredVersion: AGENT_DEVICE.version, installedVersions: agent, runningVersion: running.agent },
    };
  }

  async function refreshLocalTools(): Promise<void> {
    try {
      localTools = await readLocalTools();
      localToolsError = undefined;
    } catch (error) {
      localToolsError = `Could not read helper versions: ${errorMessage(error)} Installed tools were not changed.`;
    }
  }

  function load(): Promise<void> {
    loaded ??= (async () => {
      consent = parseConsent(await readFile(consentPath, "utf8").catch(() => ""));
      for (const audience of SHARE_AUDIENCES) sharingWas[audience] = sharingFor(audience);
      hostState = await idleStatus();
      await refreshLocalTools();
      if (deps.ssh) {
        // Reading the saved hosts touches only the disk; no host is contacted.
        sshStored = await readSshHosts(deps.baseDir);
        for (const config of sshStored.hosts) addSshEntry(config);
      }
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
      await writeJsonAtomic(consentPath, { version: 1, ...consent }, { space: 2, trailingNewline: true });
    });
    saving = next.catch(() => undefined);
    return next;
  }

  /** Starts the host. Without `allowInstall`, a missing install stops short of npm. */
  function start(allowInstall: boolean, installDetail?: string): Promise<DeviceHostReady | null> {
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
          (phase, detail) => {
            const shown = phase === "installing" && installDetail ? installDetail : detail;
            setHost({ status: phase, ...(shown ? { detail: shown } : {}) });
          },
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

  async function listAndroid(ready: DeviceHostReady): Promise<DeviceSummary[]> {
    const response = await deps.fetch(`${ready.hub.origin}/api/devices`, {
      method: "GET",
      signal: AbortSignal.timeout(ANDROID_LIST_TIMEOUT_MS),
    });
    let list: unknown = null;
    try {
      list = JSON.parse(Buffer.from(await response.arrayBuffer()).toString("utf8"));
    } catch {
      // Treated as a failure below.
    }
    if (!response.ok || typeof list !== "object" || list === null) {
      throw new Error("The device hub did not list emulators.");
    }
    const avds = await ready.run("emulator", ["-list-avds"], { timeoutMs: SIMCTL_LIST_TIMEOUT_MS });
    if (avds.code !== 0) throw new Error("The Android emulator did not list its virtual devices.");
    return parseAndroidDevices(list, avds.stdout, host.id);
  }

  async function listDevices(ready: DeviceHostReady): Promise<void> {
    const [ios, android] = await Promise.all([host.platformAvailability("ios"), host.platformAvailability("android")]);
    const next: DeviceSummary[] = [];
    let androidState = android;
    if (ios.available) {
      const result = await ready.run("xcrun", ["simctl", "list", "devices", "--json"], {
        timeoutMs: SIMCTL_LIST_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        throw new Error("Could not list simulators. Open Xcode once to finish its setup, then try again.");
      }
      next.push(...parseSimctlDevices(result.stdout, host.id));
    }
    if (android.available) {
      try {
        next.push(...(await listAndroid(ready)));
      } catch (error) {
        // iOS keeps working when Android discovery fails; the tab says why emulators are missing.
        androidState = { platform: "android", available: false, reason: `Could not list Android emulators. ${errorMessage(error)}` };
      }
    }
    platforms = [ios, androidState];
    devices = next;
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
                listing.devices.map((device) => ({ ...device, hostId: peer.id })),
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

  /**
   * Boots the device through the hub if needed and attaches the iOS stream
   * helper. An Android AVD changes id when it boots (AVD name to emulator
   * serial), so the returned device's id is authoritative.
   */
  async function attach(ready: DeviceHostReady, device: DeviceSummary): Promise<DeviceSummary> {
    let attached = device;
    if (!device.booted) {
      if (device.platform === "ios") await recycleStaleStreamHelper(ready);
      let result: HubResult;
      try {
        result = await postHubJson(
          ready,
          "/api/devices/boot",
          { platform: device.platform, id: device.id, name: device.name },
          DEVICE_BOOT_TIMEOUT_MS,
        );
      } catch (error) {
        const detail = error instanceof HubRefusedError ? error.detail : errorMessage(error);
        const failure = error instanceof HubRefusedError ? classifyBootFailure(detail) : "launch_failed";
        throw new Error(`${device.name} failed to boot. ${BOOT_FAILURE_MESSAGES[failure]}${detail ? ` (${detail})` : ""}`);
      }
      const bootedId = [result.serial, result.id].find(
        (candidate): candidate is string => typeof candidate === "string" && DEVICE_ID_PATTERN.test(candidate),
      );
      attached = { ...device, id: device.platform === "android" ? (bootedId ?? device.id) : device.id, booted: true };
      if (device.platform === "android") {
        await listDevices(ready).catch(() => undefined);
        attached = devices.find((candidate) => candidate.id === attached.id) ?? attached;
      }
      const replaced = attached;
      devices = devices.some((candidate) => candidate.id === replaced.id)
        ? devices.map((candidate) => (candidate.id === replaced.id ? replaced : candidate))
        : devices.map((candidate) => (candidate.id === device.id ? replaced : candidate));
    }
    // The iOS stream helper must be attached even when the simulator was already booted.
    // serve-emu attaches to a running emulator lazily, when the viewer's socket connects.
    if (attached.platform === "ios") {
      await postHubJson(ready, "/vendor/serve-sim/grid/api/start", { udid: attached.id }, HUB_REQUEST_TIMEOUT_MS);
    }
    return attached;
  }

  /**
   * serve-sim keeps one stream helper per simulator and reuses it on
   * `grid/api/start`. A helper that outlives its simulator (shut down, erased,
   * or restarted outside Aiden) keeps its old capture, so the rebooted device
   * streams one stale frame and then nothing. serve-sim closes helpers of
   * simulators that are no longer booted whenever one of its status routes is
   * read, so read `readyz` while the simulator is still off. Best effort: the
   * boot goes ahead whatever this returns.
   */
  async function recycleStaleStreamHelper(ready: DeviceHostReady): Promise<void> {
    try {
      const response = await deps.fetch(`${ready.hub.origin}/vendor/serve-sim/readyz`, {
        method: "GET",
        signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => undefined);
    } catch {
      // An older hub or a slow read only means a stale helper may survive.
    }
  }

  async function shutdownLocal(ready: DeviceHostReady, deviceId: string): Promise<void> {
    const device = devices.find((candidate) => candidate.id === deviceId);
    if (device?.platform === "android") {
      await postHubJson(
        ready,
        "/api/devices/shutdown",
        { platform: "android", id: device.id, name: device.name },
        ANDROID_SHUTDOWN_TIMEOUT_MS,
      );
      devices = devices.map((candidate) => (candidate.id === deviceId ? { ...candidate, booted: false } : candidate));
      // The serial goes back to the AVD name; a failed re-list must not fail an accepted shutdown.
      await listDevices(ready).catch(() => undefined);
      return;
    }
    const result = await ready.run("xcrun", ["simctl", "shutdown", deviceId], { timeoutMs: SIMCTL_SHUTDOWN_TIMEOUT_MS });
    if (result.code !== 0) throw new Error("The simulator did not shut down.");
    devices = devices.map((device) => (device.id === deviceId ? { ...device, booted: false } : device));
  }

  async function localAction(ready: DeviceHostReady, device: DeviceSummary, input: DeviceActionInput) {
    if (!deviceActionSupported(device.platform, input)) {
      throw new Error(
        device.platform === "android"
          ? "Android Emulators do not support this setting."
          : "iOS Simulators do not support this setting.",
      );
    }
    if (device.platform === "android") await runAndroidDeviceAction(ready, input);
    else await runDeviceAction(ready, input);
    return localSettings(ready, device);
  }

  const localSettings = (ready: DeviceHostReady, device: DeviceSummary) =>
    device.platform === "android" ? readAndroidDeviceSettings(ready, device.id) : readDeviceSettings(ready, device.id);

  function requireSharing(audience: AidenRemoteSimulatorAudience): DeviceHostReady {
    if (!sharingFor(audience)) throw new Error("Simulator sharing is off.");
    const ready = host.current();
    if (!ready) throw new Error("The simulator hub is not running.");
    return ready;
  }

  /** This Mac's simulators the desktop attached to one chat, in listing order. */
  function chatDeviceIds(chatId: string, listed: readonly { id: string }[]): string[] {
    const attached = new Set(
      sessions
        .filter((session) => session.chatId === chatId && session.hostId === host.id)
        .map((session) => session.deviceId),
    );
    return listed.filter((device) => attached.has(device.id)).map((device) => device.id);
  }

  function createShare(audience: AidenRemoteSimulatorAudience): AidenRemoteSimulatorHost {
    const sharing = () => sharingFor(audience);
    /**
     * Phones reach iOS Simulators only (they stream MJPEG, which only iOS
     * Simulators serve), so every phone mutation of an Android emulator is
     * refused here, before the hub is contacted.
     */
    const requirePhoneReachable = (device: DeviceSummary, refusal: string) => {
      if (audience === "mobile" && device.platform !== "ios") {
        throw new AidenRemoteServiceError("capability_denied", refusal, 403);
      }
    };
    return {
      sharing,
      async list(options) {
        await load();
        if (!sharing()) return { sharing: false, status: hostState.status, devices: [] };
        // A chat-scoped listing answers from what is already known: a phone
        // opening a chat must never start the hub. A chat with simulators
        // attached already has a running hub.
        if (options?.chatId === undefined) {
          const ready = host.current() ?? (await start(false));
          if (ready) {
            await listDevices(ready).catch((error) => setHost({ status: "error", detail: errorMessage(error) }));
          }
        }
        const listed = sharing() ? devices.map(({ hostId: _hostId, ...device }) => device) : [];
        return {
          sharing: sharing(),
          status: hostState.status,
          devices: listed,
          ...(options?.chatId === undefined ? {} : { chatDeviceIds: chatDeviceIds(options.chatId, listed) }),
          ...(audience === "mobile" ? { toolVersions: { hub: DEVICE_HUB.version, agent: AGENT_DEVICE.version } } : {}),
        };
      },
      async open(deviceId) {
        const ready = requireSharing(audience);
        const device = devices.find((candidate) => candidate.id === deviceId);
        if (!device) throw new Error("That simulator is no longer available.");
        requirePhoneReachable(device, "Open this device on your Mac to view it.");
        const { hostId: _hostId, ...attached } = await attach(ready, device);
        emit();
        return attached;
      },
      async shutdown(deviceId) {
        const ready = requireSharing(audience);
        const device = devices.find((candidate) => candidate.id === deviceId);
        if (!device) throw new Error("That simulator is no longer available.");
        requirePhoneReachable(device, "Shut this device down on your Mac.");
        await shutdownLocal(ready, deviceId);
        emit();
      },
      async settings(deviceId) {
        const ready = requireSharing(audience);
        return localSettings(ready, requireKnownDevice(host.id, deviceId));
      },
      async action(input) {
        const ready = requireSharing(audience);
        // The relay refuses phone actions first; this keeps the share host safe on its own.
        if (audience === "mobile") throw new AidenRemoteServiceError("capability_denied", MOBILE_SIMULATOR_REFUSAL, 403);
        const local = { ...input, hostId: host.id };
        return localAction(ready, requireKnownDevice(host.id, local.deviceId), local);
      },
      hubOrigin: () => (sharing() ? (host.current()?.hub.origin ?? null) : null),
      isKnownDevice: (deviceId) => sharing() && devices.some((device) => device.id === deviceId),
      onSharingChanged(listener) {
        sharingListeners[audience].add(listener);
        return () => sharingListeners[audience].delete(listener);
      },
    };
  }

  const shares: Record<AidenRemoteSimulatorAudience, AidenRemoteSimulatorHost> = {
    desktop: createShare("desktop"),
    mobile: createShare("mobile"),
  };

  function requireReady(hostId: string): DeviceHostReady {
    if (ssh.has(hostId)) return requireSsh(hostId).ready;
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
    const device = allDevices().find((candidate) => candidate.hostId === hostId && candidate.id === deviceId);
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

  async function postHubJson(
    ready: DeviceHostReady,
    route: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<HubResult> {
    const response = await postHub(ready, route, body, timeoutMs);
    let payload: HubResult = {};
    try {
      payload = JSON.parse(Buffer.from(await response.arrayBuffer()).toString("utf8")) as HubResult;
    } catch {
      // Treated as a failure below.
    }
    if (!response.ok || payload.ok !== true) {
      throw new HubRefusedError(route, typeof payload.error === "string" ? payload.error : "");
    }
    return payload;
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
    if (kind === "peerSharing" || kind === "mobileSharing") {
      consent = { ...consent, [kind]: false };
      await saveConsent();
      emit();
      return snapshot();
    }
    consent = kind === "streaming" ? { ...NO_CONSENT } : { ...consent, agentAccess: false };
    if (kind === "streaming") forgetPeers();
    if (kind === "streaming") await disconnectSsh({ forgetToolConsent: true });
    else await Promise.all([...ssh.values()].map((entry) => entry.host.stopAgent().catch(() => undefined)));
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

  // ---------------------------------------------------------------------------
  // SSH device hosts. Every function here runs from an explicit user action.
  // ---------------------------------------------------------------------------

  function sshPort(): DeviceSshPort {
    if (!deps.ssh) throw new Error("SSH device hosts are unavailable.");
    return deps.ssh;
  }

  function sshConsent(hostId: string): SshHostToolConsent {
    return sshStored.toolConsent[hostId] ?? NO_SSH_CONSENT;
  }

  async function saveSshStore(next: StoredSshHosts): Promise<void> {
    await writeSshHosts(deps.baseDir, next);
    sshStored = next;
  }

  function setSsh(entry: SshEntry, next: DeviceHostState): void {
    if (ssh.get(entry.config.id) !== entry) return;
    entry.state = next;
    emit();
  }

  function dropSshDevices(entry: SshEntry): void {
    entry.devices = [];
    sessions = sessions.filter((session) => session.hostId !== entry.config.id);
    closePeerStreams(entry.config.id);
  }

  function addSshEntry(config: SshDeviceHostConfig): SshEntry {
    const entry: SshEntry = {
      config,
      host: sshPort().create(config),
      state: { ...SSH_IDLE },
      devices: [],
      unsubscribe: () => undefined,
    };
    entry.unsubscribe = entry.host.onHealth((health, detail) => {
      if (!consent.streaming || ssh.get(config.id) !== entry) return;
      if (health === "restarting") setSsh(entry, { status: "starting", detail: detail ?? `Reconnecting to ${config.label}…` });
      else if (health === "ready") setSsh(entry, { status: "ready" });
      else {
        dropSshDevices(entry);
        setSsh(entry, { status: "error", detail: detail ?? `Lost the connection to ${config.label}.` });
      }
    });
    ssh.set(config.id, entry);
    return entry;
  }

  async function forgetSshEntry(entry: SshEntry): Promise<void> {
    entry.unsubscribe();
    if (ssh.get(entry.config.id) === entry) ssh.delete(entry.config.id);
    dropSshDevices(entry);
    await withinBudget(entry.host.stop(), SSH_STOP_BUDGET_MS);
    await rm(agentDeviceConfigPath(deps.baseDir, entry.config.id), { force: true }).catch(() => undefined);
  }

  /** Tears every tunnel down and stops the helpers Aiden started on each host. */
  async function disconnectSsh(options: { forgetToolConsent: boolean }): Promise<void> {
    sshEpoch += 1;
    const entries = [...ssh.values()];
    for (const entry of entries) {
      dropSshDevices(entry);
      entry.state = { ...SSH_IDLE };
      entry.toolInspectionError = undefined;
    }
    await withinBudget(Promise.all(entries.map((entry) => entry.host.stop())), SSH_STOP_BUDGET_MS);
    if (options.forgetToolConsent && Object.keys(sshStored.toolConsent).length > 0) {
      await saveSshStore({ ...sshStored, toolConsent: {} }).catch(() => undefined);
    }
  }

  function requireSsh(hostId: string): { entry: SshEntry; ready: DeviceHostReady } {
    if (!consent.streaming) throw new Error(STREAMING_OFF);
    const entry = ssh.get(hostId);
    if (!entry) throw new Error(`Unknown device host ${hostId}.`);
    const ready = entry.host.current();
    if (entry.state.status !== "ready" || !ready) {
      throw new Error(entry.state.detail && entry.state.status !== "stopped"
        ? entry.state.detail
        : `Connect ${entry.config.label} first.`);
    }
    return { entry, ready };
  }

  async function listSsh(entry: SshEntry, ready: DeviceHostReady): Promise<void> {
    const result = await ready.run("xcrun", ["simctl", "list", "devices", "--json"], {
      timeoutMs: SIMCTL_LIST_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(`Could not list simulators on ${entry.config.label}. Open Xcode there once, then try again.`);
    }
    entry.devices = parseSimctlDevices(result.stdout, entry.config.id);
    const known = new Set(entry.devices.map((device) => device.id));
    sessions = sessions.filter((session) => session.hostId !== entry.config.id || known.has(session.deviceId));
  }

  /**
   * Connects one host and lists its simulators. With the user's earlier
   * approval for this host, a missing or outdated pinned helper is installed
   * here, with progress; without it, the host asks for Install.
   */
  async function connectSsh(entry: SshEntry, options: { allowInstall?: boolean } = {}): Promise<void> {
    if (!consent.streaming) throw new Error(STREAMING_OFF);
    const id = entry.config.id;
    const epoch = sshEpoch;
    const live = () => epoch === sshEpoch && consent.streaming && ssh.get(id) === entry;
    setSsh(entry, { status: "starting", detail: `Connecting to ${entry.config.label}…` });
    if (await sshPort().isLocalTarget(entry.config).catch(() => false)) {
      dropSshDevices(entry);
      setSsh(entry, {
        status: "unavailable",
        detail: `${entry.config.label} is this Mac. Its simulators already appear under This Mac.`,
      });
      return;
    }
    if (!live()) return;
    const approved = sshConsent(id);
    try {
      const ready = await entry.host.ensureReady(
        (phase, detail) => {
          if (live()) setSsh(entry, { status: phase, ...(detail ? { detail } : {}) });
        },
        { allowInstall: options.allowInstall === true || approved.hub },
      );
      if (!live()) return;
      // Approved agent tools that are out of date update with the same action.
      if (consent.agentAccess && approved.agent && toolNeedsUpdate(entry.host.tools()?.agent)) {
        await entry.host.ensureAgentReady(
          (phase, detail) => {
            if (live()) setSsh(entry, { status: phase, ...(detail ? { detail } : {}) });
          },
          { allowInstall: true },
        );
        if (!live()) return;
      }
      await listSsh(entry, ready);
      if (!live()) return;
      entry.toolInspectionError = undefined;
      setSsh(entry, { status: "ready" });
    } catch (error) {
      if (!live()) return;
      dropSshDevices(entry);
      if (error instanceof DeviceToolsMissingError) {
        setSsh(entry, {
          status: "needs-consent",
          detail: `Install the simulator helpers on ${entry.config.label} in Settings → Simulator to use its simulators.`,
        });
      } else {
        setSsh(entry, { status: "error", detail: errorMessage(error) });
      }
    }
  }

  async function connectAllSsh(): Promise<void> {
    if (!consent.streaming || !deps.ssh) return;
    await Promise.all([...ssh.values()].map((entry) => connectSsh(entry).catch(() => undefined)));
  }

  async function reclaimLocal(specs: ToolMaintenanceSpec[]): Promise<void> {
    // Keeps the newest previous install as a fallback; never touches a version a running helper uses.
    await maintain({ nodePath, toolsRoot: path.join(deps.baseDir, "tools"), specs, policy: "reclaim" }).catch(
      () => undefined,
    );
  }

  /** Installs one pinned helper on this Mac. Callers have checked the matching consent. */
  async function installLocalTool(tool: "hub" | "agent"): Promise<void> {
    if (!host.installTool) throw new Error("This Mac cannot update simulator helpers.");
    const spec = tool === "hub" ? DEVICE_HUB : AGENT_DEVICE;
    const before = localTools ?? (await readLocalTools());
    setHost({
      status: "installing",
      detail: deviceToolInstallMessage(tool === "hub" ? "the device hub" : "agent tools", before[tool]),
    });
    try {
      await host.installTool(tool);
    } catch (error) {
      await refreshLocalTools();
      if (error instanceof DeviceHostUnavailableError) setHost({ status: "error", detail: error.reason });
      else setHost({ status: "error", detail: `Updating ${spec.name} failed: ${errorMessage(error)}` });
      throw error instanceof DeviceHostUnavailableError ? new Error(error.reason) : error;
    }
    // A daemon an older agent-device started must not keep serving; the next agent call starts the new one.
    if (tool === "agent") await host.stopAgent().catch(() => undefined);
    await reclaimLocal([spec]);
    await refreshLocalTools();
    setHost(host.current() ? { status: "ready" } : await idleStatus());
  }

  /** The explicit Start, Try again, or Retry for this Mac. */
  async function startLocal(): Promise<void> {
    if (!consent.streaming) throw new Error(STREAMING_OFF);
    await removing?.catch(() => undefined);
    await refreshLocalTools();
    const hubUpdate = toolNeedsUpdate(localTools?.hub);
    const ready = await start(
      hubUpdate,
      hubUpdate ? deviceToolInstallMessage("the device hub", localTools?.hub) : undefined,
    );
    if (!ready) {
      await refreshLocalTools();
      emit();
      return;
    }
    if (hubUpdate) await reclaimLocal([DEVICE_HUB]);
    if (consent.agentAccess && toolNeedsUpdate(localTools?.agent)) {
      await installLocalTool("agent").catch(() => undefined);
    }
    await listDevices(ready).catch((error) => setHost({ status: "error", detail: errorMessage(error) }));
    await refreshLocalTools();
    emit();
  }

  async function sshAgentTarget(input: { chatId: string; hostId: string; deviceId: string }) {
    const { entry } = requireSsh(input.hostId);
    if (!(await isToolInstalled(deps.baseDir, AGENT_DEVICE))) {
      throw new Error(
        `${AGENT_DEVICE.name} is not installed on this Mac. Ask the user to turn agent access off and on in the Simulator tab.`,
      );
    }
    const epoch = consentEpoch;
    const preparing = entry.host.ensureAgentReady(undefined, { allowInstall: false });
    agentStarts.add(preparing);
    let ready: Awaited<typeof preparing>;
    try {
      ready = await preparing;
    } catch (error) {
      if (error instanceof DeviceToolsMissingError) {
        throw new Error(
          `Agent tools are not installed on ${entry.config.label}. Ask the user to install them in Settings → Simulator.`,
        );
      }
      throw error;
    } finally {
      agentStarts.delete(preparing);
    }
    if (epoch !== consentEpoch || !consent.streaming || !consent.agentAccess || ssh.get(input.hostId) !== entry) {
      await entry.host.stopAgent().catch(() => undefined);
      throw new Error(AGENT_ACCESS_OFF);
    }
    // The local agent-device CLI drives the host's daemon through the forwarded port.
    const shim = await ensureAgentDeviceShim({
      baseDir: deps.baseDir,
      nodePath,
      entryPath: deviceToolPaths(deps.baseDir, AGENT_DEVICE).entryPath,
    });
    shimDir = shim.shimDir;
    const config = agentDeviceConfigPath(deps.baseDir, input.hostId);
    await writeAgentDeviceConfig(config, ready.agentDevice);
    return {
      command: shim.command,
      args: ["--config", config, "--session", agentDeviceSession(input.chatId, input.hostId, input.deviceId)],
    };
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
      if (kind === "mobileSharing" && !consent.streaming) {
        throw new Error("Set up simulator streaming before sharing with Aiden On The Go.");
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
      // Under the maintenance lock; a version a running helper was started from stays.
      await maintain({
        nodePath,
        toolsRoot: path.join(deps.baseDir, "tools"),
        specs: [DEVICE_HUB, AGENT_DEVICE],
        policy: "prune",
      });
      await refreshLocalTools();
      emit();
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
          await refreshLocalTools();
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
      const sshDone = connectAllSsh();
      await refreshLocalHost();
      await peersDone;
      await sshDone;
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
      if (ssh.has(hostId)) {
        const { entry, ready } = requireSsh(hostId);
        const epoch = sshEpoch;
        const closed = closeCount(input.chatId, hostId, input.deviceId);
        let device = entry.devices.find((candidate) => candidate.id === input.deviceId);
        if (!device) {
          await listSsh(entry, ready);
          device = entry.devices.find((candidate) => candidate.id === input.deviceId);
        }
        if (!device) throw new Error("That simulator is no longer available.");
        const attached = await attach(ready, device);
        if (epoch !== sshEpoch || !consent.streaming || ssh.get(hostId) !== entry) {
          throw new Error("Simulator streaming was turned off while opening.");
        }
        if (closeCount(input.chatId, hostId, input.deviceId) !== closed) {
          throw new Error("The simulator was closed while it was opening.");
        }
        entry.devices = entry.devices.map((candidate) => (candidate.id === attached.id ? attached : candidate));
        const existing = sessions.find(
          (session) => session.chatId === input.chatId && session.hostId === hostId && session.deviceId === device.id,
        );
        if (existing) {
          emit();
          return { ...existing };
        }
        const session: DeviceSession = { chatId: input.chatId, hostId, deviceId: device.id, openedBy: input.openedBy };
        sessions = [...sessions, session];
        emit();
        return { ...session };
      }
      if (hostId !== host.id) {
        const entry = requirePeer(hostId);
        const requested = entry.devices.find((device) => device.id === input.deviceId);
        if (!requested) throw new Error("That simulator is no longer available.");
        const epoch = peerEpoch;
        const closed = closeCount(input.chatId, hostId, input.deviceId);
        const opened = await peerPort().open(hostId, input.deviceId);
        if (epoch !== peerEpoch || !consent.streaming || peers.get(hostId) !== entry) {
          throw new Error("Simulator streaming was turned off while opening.");
        }
        if (closeCount(input.chatId, hostId, input.deviceId) !== closed) {
          throw new Error("The simulator was closed while it was opening.");
        }
        // Only an Android AVD that was not running may come back under a new id, its emulator
        // serial, and only a serial no other listed device already has.
        const renamedAvd =
          requested.platform === "android" &&
          !requested.booted &&
          opened.platform === "android" &&
          isEmulatorSerial(opened.id) &&
          !entry.devices.some((device) => device.id === opened.id);
        if (opened.id !== input.deviceId && !renamedAvd) {
          throw new Error("The paired Mac answered with a different device. Refresh and try again.");
        }
        entry.devices = entry.devices.map((device) => (device.id === input.deviceId ? { ...opened, hostId } : device));
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
      const closed = closeCount(input.chatId, hostId, input.deviceId);
      let device = devices.find((candidate) => candidate.hostId === hostId && candidate.id === input.deviceId);
      if (!device) {
        await listDevices(ready);
        device = devices.find((candidate) => candidate.hostId === hostId && candidate.id === input.deviceId);
      }
      if (!device) throw new Error("That simulator is no longer available.");
      const attached = await attach(ready, device);
      // A revoke while the simulator booted wins; never register a session after it.
      if (epoch !== streamingEpoch || !consent.streaming) {
        throw new Error("Simulator streaming was turned off while opening.");
      }
      if (closeCount(input.chatId, hostId, input.deviceId) !== closed) {
        throw new Error("The simulator was closed while it was opening.");
      }
      // Looked up after the boot, so concurrent opens share one session and a close meanwhile sticks.
      const existing = sessions.find(
        (session) =>
          session.chatId === input.chatId && session.hostId === hostId && session.deviceId === attached.id,
      );
      if (existing) {
        emit();
        return { ...existing };
      }
      const session: DeviceSession = { chatId: input.chatId, hostId, deviceId: attached.id, openedBy: input.openedBy };
      sessions = [...sessions, session];
      emit();
      return { ...session };
    },
    async close(input) {
      await load();
      bumpClose(sessionKey(input.chatId, input.hostId, input.deviceId));
      sessions = sessions.filter(
        (session) =>
          !(session.chatId === input.chatId && session.hostId === input.hostId && session.deviceId === input.deviceId),
      );
      if (input.shutdown && ssh.has(input.hostId)) {
        const { entry, ready } = requireSsh(input.hostId);
        const result = await ready.run("xcrun", ["simctl", "shutdown", input.deviceId], {
          timeoutMs: SIMCTL_SHUTDOWN_TIMEOUT_MS,
        });
        if (result.code !== 0) throw new Error("The simulator did not shut down.");
        entry.devices = entry.devices.map((device) =>
          device.id === input.deviceId ? { ...device, booted: false } : device,
        );
      } else if (input.shutdown && input.hostId !== host.id) {
        const entry = requirePeer(input.hostId);
        await peerPort().shutdown(input.hostId, input.deviceId);
        entry.devices = entry.devices.map((device) =>
          device.id === input.deviceId ? { ...device, booted: false } : device,
        );
      } else if (input.shutdown) {
        const ready = requireReady(input.hostId);
        const device = devices.find((candidate) => candidate.hostId === input.hostId && candidate.id === input.deviceId);
        if (device?.platform === "android") {
          await shutdownLocal(ready, input.deviceId);
        } else {
          await ready.run("xcrun", ["simctl", "shutdown", input.deviceId], { timeoutMs: SIMCTL_SHUTDOWN_TIMEOUT_MS });
          devices = devices.map((candidate) =>
            candidate.hostId === input.hostId && candidate.id === input.deviceId ? { ...candidate, booted: false } : candidate,
          );
        }
      }
      emit();
    },
    closeChat(chatId) {
      void rm(path.join(deps.baseDir, "screenshots", chatKey(chatId)), { recursive: true, force: true }).catch(
        () => undefined,
      );
      bumpClose(chatCloseKey(chatId));
      const remaining = sessions.filter((session) => session.chatId !== chatId);
      if (remaining.length === sessions.length) return;
      sessions = remaining;
      emit();
    },
    async action(input) {
      await load();
      if (input.hostId !== host.id && !ssh.has(input.hostId)) {
        requirePeerDevice(input.hostId, input.deviceId);
        return peerPort().action(input.hostId, input);
      }
      const ready = requireReady(input.hostId);
      return localAction(ready, requireKnownDevice(input.hostId, input.deviceId), input);
    },
    async settings(input) {
      await load();
      if (input.hostId !== host.id && !ssh.has(input.hostId)) {
        requirePeerDevice(input.hostId, input.deviceId);
        return peerPort().settings(input.hostId, input.deviceId);
      }
      const ready = requireReady(input.hostId);
      return localSettings(ready, requireKnownDevice(input.hostId, input.deviceId));
    },
    sessionsForChat: (chatId) =>
      sessions.filter((session) => session.chatId === chatId).map((session) => ({ ...session })),
    async screenshot(input) {
      await load();
      if (input.hostId !== host.id && !ssh.has(input.hostId)) {
        const platform = requirePeer(input.hostId).devices.find((device) => device.id === input.deviceId)?.platform;
        return peerPort().screenshot(input.hostId, input.deviceId, platform ?? "ios");
      }
      const ready = requireReady(input.hostId);
      const android =
        devices.find((device) => device.hostId === input.hostId && device.id === input.deviceId)?.platform === "android";
      const response = android
        ? await deps.fetch(
            `${ready.hub.origin}/vendor/serve-emu/api/screenshot?${new URLSearchParams({ device: input.deviceId })}`,
            { method: "GET", signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS) },
          )
        : await postHub(ready, "/vendor/serve-sim/api/screenshot", { udid: input.deviceId }, HUB_REQUEST_TIMEOUT_MS);
      if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("image/png")) {
        throw new Error(android ? "The emulator screenshot failed." : "The simulator screenshot failed.");
      }
      return Buffer.from(await response.arrayBuffer());
    },
    async localTarget(input) {
      await load();
      if (input.hostId !== host.id) throw new Error("This works only with simulators on this Mac.");
      const ready = requireReady(input.hostId);
      const device = devices.find((candidate) => candidate.hostId === input.hostId && candidate.id === input.deviceId);
      if (!device) throw new Error("That simulator is no longer available.");
      if (input.booted && !device.booted) throw new Error("Open the simulator first.");
      return { ready, device: { ...device } };
    },
    async shutdownLocal(input) {
      await load();
      if (input.hostId !== host.id) throw new Error("This works only with simulators on this Mac.");
      const ready = requireReady(input.hostId);
      if (!devices.some((candidate) => candidate.id === input.deviceId)) {
        throw new Error("That simulator is no longer available.");
      }
      try {
        await shutdownLocal(ready, input.deviceId);
      } finally {
        emit();
      }
    },
    async streamGrant() {
      await load();
      const localReady = consent.streaming && host.current() !== null;
      const peerReady = consent.streaming && [...peers.values()].some((entry) => entry.state.status === "ready");
      const sshReady = consent.streaming && [...ssh.values()].some((entry) => entry.state.status === "ready");
      if (!localReady && !peerReady && !sshReady) requireReady(host.id);
      proxy ??= deps.startProxy((hostId) => {
        if (hostId === host.id) return consent.streaming ? (host.current()?.hub.origin ?? null) : null;
        // An SSH host's hub is reached through its forwarded loopback port, never directly.
        const sshEntry = ssh.get(hostId);
        if (sshEntry) {
          return consent.streaming && sshEntry.state.status === "ready" ? (sshEntry.host.current()?.hub.origin ?? null) : null;
        }
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
      if (removing) throw new Error(AGENT_ACCESS_OFF);
      if (ssh.has(input.hostId)) return sshAgentTarget(input);
      if (input.hostId !== host.id) throw new Error(`Unknown device host ${input.hostId}.`);
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
    reveal(chatId, target) {
      for (const listener of revealListeners) listener(chatId, target);
    },
    onReveal(listener) {
      revealListeners.add(listener);
      return () => revealListeners.delete(listener);
    },
    shareHost: (audience = "desktop") => shares[audience],
    async startHost(hostId) {
      await load();
      if (hostId === host.id) {
        await startLocal();
        return snapshot();
      }
      const entry = ssh.get(hostId);
      if (!entry) throw new Error(`Unknown device host ${hostId}.`);
      await connectSsh(entry);
      return snapshot();
    },
    async updateTool({ hostId, tool }) {
      await load();
      await removing?.catch(() => undefined);
      if (!consent.streaming) throw new Error(STREAMING_OFF);
      if (tool === "agent" && !consent.agentAccess) {
        throw new Error("Turn on agent access before installing agent tools.");
      }
      if (hostId === host.id) {
        // Local consent toggles are the install approval for this Mac.
        const run = granting.then(async () => {
          await installLocalTool(tool);
          if (tool === "hub" && !host.current()) {
            const ready = await start(false);
            if (ready) await listDevices(ready).catch(() => undefined);
          }
          return snapshot();
        });
        granting = run.catch(() => undefined);
        return run;
      }
      const entry = ssh.get(hostId);
      if (!entry) throw new Error(`Unknown device host ${hostId}.`);
      // Pressing Install or Update on an SSH host is the approval to install there.
      const approved = sshConsent(hostId);
      const nextConsent: SshHostToolConsent = tool === "hub" ? { ...approved, hub: true } : { hub: true, agent: true };
      await saveSshStore({ ...sshStored, toolConsent: { ...sshStored.toolConsent, [hostId]: nextConsent } });
      if (tool === "hub" || entry.state.status !== "ready") await connectSsh(entry, { allowInstall: true });
      if (tool === "agent" && ssh.get(hostId) === entry && entry.state.status === "ready") {
        try {
          await entry.host.ensureAgentReady(
            (phase, detail) => setSsh(entry, { status: phase, ...(detail ? { detail } : {}) }),
            { allowInstall: true },
          );
          setSsh(entry, { status: "ready" });
        } catch (error) {
          setSsh(entry, { status: "error", detail: errorMessage(error) });
        }
      }
      if (entry.state.status === "error" && entry.state.detail) throw new Error(entry.state.detail);
      return snapshot();
    },
    async inspectTools() {
      await load();
      await refreshLocalTools();
      emit();
      // Each SSH host is checked independently, so one failure never hides another host's versions.
      await Promise.all(
        [...ssh.values()].map(async (entry) => {
          try {
            await entry.host.inspect();
            entry.toolInspectionError = undefined;
          } catch (error) {
            entry.toolInspectionError = `Could not check versions: ${errorMessage(error)} Installed tools were not changed.`;
          }
          if (ssh.get(entry.config.id) === entry) emit();
        }),
      );
      return snapshot();
    },
    async saveSshHost(config) {
      await load();
      sshPort();
      const hosts = updateSshDeviceHosts(sshStored.hosts, config);
      const existing = ssh.get(config.id);
      await saveSshStore({ ...sshStored, hosts });
      if (existing) {
        const moved =
          existing.config.target !== config.target ||
          existing.config.port !== config.port ||
          existing.config.identityFile !== config.identityFile;
        if (moved || existing.state.status !== "ready") {
          // A new destination is a different machine: its approval and its helpers start over.
          await forgetSshEntry(existing);
          if (moved) {
            const { [config.id]: _dropped, ...toolConsent } = sshStored.toolConsent;
            await saveSshStore({ ...sshStored, toolConsent });
          }
          addSshEntry(config);
        } else {
          existing.config = config;
        }
      } else {
        addSshEntry(config);
      }
      // Map order follows the saved order, so a re-added entry keeps its place.
      const ordered = sshStored.hosts.map((saved) => [saved.id, ssh.get(saved.id)!] as const);
      ssh.clear();
      for (const [id, entry] of ordered) ssh.set(id, entry);
      emit();
      return snapshot();
    },
    async removeSshHost(hostId) {
      await load();
      const entry = ssh.get(hostId);
      if (!entry) throw new Error(`Unknown device host ${hostId}.`);
      const { [hostId]: _dropped, ...toolConsent } = sshStored.toolConsent;
      await saveSshStore({ hosts: sshStored.hosts.filter((saved) => saved.id !== hostId), toolConsent });
      await forgetSshEntry(entry);
      emit();
      return snapshot();
    },
    async testSshHost(config) {
      await load();
      const port = sshPort();
      if (await port.isLocalTarget(config).catch(() => false)) return { status: "local" };
      const entry = ssh.get(config.id);
      const sameDestination =
        entry &&
        entry.config.target === config.target &&
        entry.config.port === config.port &&
        entry.config.identityFile === config.identityFile;
      const probeHost = sameDestination ? entry.host : port.create(config);
      try {
        const probe = await probeHost.inspect();
        if (sameDestination && ssh.get(config.id) === entry) {
          entry.toolInspectionError = undefined;
          emit();
        }
        return {
          status: "connected",
          nodeVersion: probe.nodeVersion,
          platforms: probe.platforms,
          ...(probe.tools ? { tools: probe.tools } : {}),
        };
      } catch (error) {
        return { status: "failed", error: errorMessage(error) };
      }
    },
    async stop() {
      const entries = [...ssh.values()];
      for (const entry of entries) entry.unsubscribe();
      ssh.clear();
      // Every tunnel closes immediately; each host's own helpers get a bounded chance to stop.
      await withinBudget(Promise.all(entries.map((entry) => entry.host.stop())), SSH_STOP_BUDGET_MS);
      for (const audience of SHARE_AUDIENCES) {
        for (const listener of sharingListeners[audience]) listener(false);
        sharingListeners[audience].clear();
      }
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
