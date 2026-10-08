/**
 * Adapted from t3code apps/server/src/device/DeviceHost.ts @ 1c127066 (MIT)
 *
 * A device host is a machine with simulators on it. The device service only
 * talks to this interface, so the Phase 5 SSH host slots in beside the local
 * host without touching discovery, the proxy, or agent tools.
 *
 * Every ready host presents a loopback origin where expo-device-hub answers.
 * A host adds an agent-device daemon endpoint only after agent access is
 * granted.
 */
import type {
  DeviceHostKind,
  DevicePlatform,
  DevicePlatformAvailability,
} from "../../../renderer/shared/devices.js";

export type { DevicePlatformAvailability };

export interface DeviceHubEndpoint {
  /** Loopback origin of expo-device-hub, e.g. `http://127.0.0.1:52011`. Never sent to the renderer. */
  origin: string;
}

export interface AgentDeviceEndpoint {
  baseUrl: string;
  token: string;
  entryPath: string;
}

export interface DeviceCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface DeviceCommandOptions {
  timeoutMs?: number;
  stdin?: string;
  /** Added to the host environment, e.g. `ELECTRON_RUN_AS_NODE` for a bundled Node script. */
  env?: Record<string, string>;
}

/** serve-sim programs bundled with the hub. A missing one leaves its settings unavailable. */
export interface DeviceHostHelpers {
  /** `serve-sim-ax-settings`, spawned inside a simulator for the accessibility switches. */
  axSettings: string | null;
  /** serve-sim's CLI, run with Node for notification permissions. */
  serveSimCli: string | null;
}

export interface DeviceHostReady {
  nodePath: string;
  hub: DeviceHubEndpoint;
  helpers: DeviceHostHelpers;
  /**
   * Runs a host command (`xcrun`, `adb`, `emulator`, or a helper) where the
   * devices live. The Android SDK's tools are on its PATH. Spawn failures return code 127.
   */
  run(
    command: string,
    args: readonly string[],
    options?: DeviceCommandOptions,
  ): Promise<DeviceCommandResult>;
  /**
   * The environment `run` gives its commands, for a long-running child the
   * caller supervises itself (an Android screen recording's `adb`). Only the
   * local host sets it.
   */
  env?: NodeJS.ProcessEnv;
}

export interface DeviceHostAgentReady extends DeviceHostReady {
  agentDevice: AgentDeviceEndpoint;
}

export type DeviceHostPhase = "installing" | "starting";

/**
 * Only an explicit consent action passes `allowInstall: true`. Every other
 * start (refresh, `device_open`) fails with `DeviceToolsMissingError` instead
 * of contacting npm.
 */
export interface DeviceHostStartOptions {
  allowInstall?: boolean;
}
export type DeviceHostHealth = "ready" | "restarting" | "failed";

export interface DeviceHost {
  id: string;
  kind: DeviceHostKind;
  /** Whether this host can run a platform, and a user-readable reason when it cannot. */
  platformAvailability(platform: DevicePlatform): Promise<DevicePlatformAvailability>;
  /** Whether the pinned hub is installed, so a start can proceed without contacting npm. */
  hubInstalled(): Promise<boolean>;
  /** Whether the pinned agent-device is installed, so agent tools never reach npm. */
  agentInstalled(): Promise<boolean>;
  /** Starts the hub, installing it first only when allowed. Concurrent callers share one start. */
  ensureReady(
    onPhase?: (phase: DeviceHostPhase, detail?: string) => void,
    options?: DeviceHostStartOptions,
  ): Promise<DeviceHostReady>;
  /** Starts agent-device, installing it first only when the user is granting agent access. */
  ensureAgentReady(
    onPhase?: (phase: DeviceHostPhase, detail?: string) => void,
    options?: DeviceHostStartOptions,
  ): Promise<DeviceHostAgentReady>;
  /** Current endpoints when already running, without starting anything. */
  current(): DeviceHostReady | null;
  /** Reports supervised hub restarts so the service can update the tab. */
  onHealth(listener: (health: DeviceHostHealth, detail?: string) => void): () => void;
  /**
   * Installs one pinned helper without starting it. Only an explicit Update,
   * or a Start the user approved for an outdated install, calls this.
   */
  installTool?(tool: "hub" | "agent"): Promise<void>;
  /** The helper versions running right now, without touching the disk or the network. */
  runningToolVersions?(): { hub: string | null; agent: string | null };
  /** Stops only agent-device. Manual viewing through the hub stays available. */
  stopAgent(): Promise<void>;
  /** Stops helpers. Simulators keep running; the user owns those. */
  stop(): Promise<void>;
}

/** A setup problem the user can fix, shown verbatim in the Simulator tab. */
export class DeviceHostUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "DeviceHostUnavailableError";
  }
}

/** A pinned tool is not installed and this start was not allowed to install it. */
export class DeviceToolsMissingError extends Error {
  constructor(readonly tool: string) {
    super(`${tool} is not installed.`);
    this.name = "DeviceToolsMissingError";
  }
}

export class DeviceHostError extends Error {
  declare readonly cause: unknown;
  constructor(
    readonly hostId: string,
    readonly step: string,
    options?: { cause?: unknown },
  ) {
    super(`Device host ${hostId} failed while ${step}.`);
    this.name = "DeviceHostError";
    this.cause = options?.cause;
  }
}
