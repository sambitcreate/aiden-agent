/**
 * Bot computers (plan §8): a macOS VM per Bot, on Apple silicon only.
 *
 * These are the renderer-safe shapes main projects over IPC. Main owns every
 * decision (what is downloaded, which VM runs, when it stops); the renderer
 * only parses these and asks for the person's explicit actions.
 */

import { formatHarnessBytes } from "./acp-harness.js";

export type BotComputerSetupState =
  | { kind: "unsupported"; reason: "platform" | "host_os" }
  | { kind: "not_set_up" }
  | { kind: "downloading"; receivedBytes: number; totalBytes: number }
  | { kind: "verifying" }
  | { kind: "building_base"; step: "create" | "provision" | "guest_driver" | "permissions" }
  | { kind: "ready"; baseVersion: string; baseBuild: string; updateAvailable: boolean }
  | { kind: "failed"; message: string; resumable: boolean };

export type BotComputerRunState = "stopped" | "starting" | "running" | "stopping" | "waiting_for_slot" | "stale";

export interface BotComputerStatus {
  botId: string;
  vmName: string;
  state: BotComputerRunState;
  baseBuild: string;
  outdated: boolean;
  lastUsedAt?: number;
  controller: "bot" | "person";
  activity?: string;
}

export interface BotComputersSettings {
  maxRunning: 1 | 2;
  idleStopMinutes: number;
}

/** What Set up and each start need, stated up front on the Settings page. */
export interface BotComputersRequirements {
  /** The pinned macOS restore image download. */
  downloadBytes: number;
  /** About how much disk the finished base computer takes. */
  baseDiskBytes: number;
  /** Free disk Set up checks for before it downloads: the download plus the base and headroom. */
  setupFreeBytes: number;
  /** Free memory each running computer needs. */
  memoryPerComputerBytes: number;
  /** The macOS version the pinned base installs. */
  baseVersion: string;
}

export interface BotComputersStatus {
  setup: BotComputerSetupState;
  settings: BotComputersSettings;
  diskUsedBytes: number;
  freeDiskBytes?: number;
  computers: BotComputerStatus[];
  requirements: BotComputersRequirements;
}

/** Every Bot-computer IPC channel. Invoke channels share the `botComputers:` prefix. */
export const BOT_COMPUTER_CHANNELS = {
  status: "botComputers:status", // invoke() → BotComputersStatus
  setUp: "botComputers:setUp", // invoke() → BotComputersStatus (resolves when setup settles)
  cancelSetUp: "botComputers:cancelSetUp", // invoke() → void
  updateBase: "botComputers:updateBase", // invoke() → BotComputersStatus
  removeEverything: "botComputers:removeEverything", // invoke() → BotComputersStatus
  updateSettings: "botComputers:updateSettings", // invoke(Partial<BotComputersSettings>) → BotComputersSettings
  give: "botComputers:give", // invoke(botId) → BotComputerStatus
  reset: "botComputers:reset", // invoke(botId) → BotComputerStatus
  remove: "botComputers:remove", // invoke(botId) → void
  stop: "botComputers:stop", // invoke(botId) → void
} as const;

/** Broadcast with the whole `BotComputersStatus` whenever anything changes. */
export const BOT_COMPUTERS_CHANGED_CHANNEL = "botComputers:changed";

export const BOT_COMPUTER_MAX_RUNNING_CHOICES = [1, 2] as const;
export const BOT_COMPUTER_IDLE_STOP_CHOICES = [5, 10, 15, 30, 60] as const;
export const DEFAULT_BOT_COMPUTERS_SETTINGS: BotComputersSettings = Object.freeze({
  maxRunning: 2,
  idleStopMinutes: 10,
});

/**
 * Validate a settings change from the renderer. Unknown keys and values
 * outside the offered choices throw rather than being clamped.
 */
export function parseBotComputersSettingsPatch(value: unknown): Partial<BotComputersSettings> {
  const input = record(value);
  if (!input) throw new Error("Bot computer settings must be an object.");
  const patch: Partial<BotComputersSettings> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (key === "maxRunning") {
      if (entry !== 1 && entry !== 2) throw new Error("At most one or two Bot computers can run at once.");
      patch.maxRunning = entry;
    } else if (key === "idleStopMinutes") {
      if (!(BOT_COMPUTER_IDLE_STOP_CHOICES as readonly unknown[]).includes(entry)) {
        throw new Error("Choose one of the offered idle stop times.");
      }
      patch.idleStopMinutes = entry as number;
    } else {
      throw new Error(`Unknown Bot computer setting: ${key}`);
    }
  }
  return patch;
}

const RUN_STATES: ReadonlySet<string> = new Set([
  "stopped",
  "starting",
  "running",
  "stopping",
  "waiting_for_slot",
  "stale",
]);
const BUILD_STEPS: ReadonlySet<string> = new Set(["create", "provision", "guest_driver", "permissions"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

function parseSetup(value: unknown): BotComputerSetupState | undefined {
  const input = record(value);
  switch (input?.kind) {
    case "unsupported":
      return input.reason === "platform" || input.reason === "host_os"
        ? { kind: "unsupported", reason: input.reason }
        : undefined;
    case "not_set_up":
      return { kind: "not_set_up" };
    case "downloading": {
      const receivedBytes = count(input.receivedBytes);
      const totalBytes = count(input.totalBytes);
      return receivedBytes !== undefined && totalBytes !== undefined
        ? { kind: "downloading", receivedBytes, totalBytes }
        : undefined;
    }
    case "verifying":
      return { kind: "verifying" };
    case "building_base":
      return typeof input.step === "string" && BUILD_STEPS.has(input.step)
        ? { kind: "building_base", step: input.step as "create" | "provision" | "guest_driver" | "permissions" }
        : undefined;
    case "ready": {
      const baseVersion = text(input.baseVersion, 32);
      const baseBuild = text(input.baseBuild, 32);
      return baseVersion && baseBuild && typeof input.updateAvailable === "boolean"
        ? { kind: "ready", baseVersion, baseBuild, updateAvailable: input.updateAvailable }
        : undefined;
    }
    case "failed": {
      const message = text(input.message, 600);
      return message && typeof input.resumable === "boolean"
        ? { kind: "failed", message, resumable: input.resumable }
        : undefined;
    }
    default:
      return undefined;
  }
}

export function parseBotComputerStatus(value: unknown): BotComputerStatus | undefined {
  const input = record(value);
  const botId = text(input?.botId, 200);
  const vmName = text(input?.vmName, 64);
  const baseBuild = typeof input?.baseBuild === "string" && input.baseBuild.length <= 32 ? input.baseBuild : undefined;
  if (!input || !botId || !vmName || baseBuild === undefined) return undefined;
  if (typeof input.state !== "string" || !RUN_STATES.has(input.state)) return undefined;
  if (typeof input.outdated !== "boolean") return undefined;
  if (input.controller !== "bot" && input.controller !== "person") return undefined;
  const lastUsedAt = count(input.lastUsedAt);
  const activity = text(input.activity, 200);
  return {
    botId,
    vmName,
    state: input.state as BotComputerRunState,
    baseBuild,
    outdated: input.outdated,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    controller: input.controller,
    ...(activity ? { activity } : {}),
  };
}

/** The renderer accepts only this shape from main; anything else is dropped. */
export function parseBotComputersStatus(value: unknown): BotComputersStatus | undefined {
  const input = record(value);
  const setup = parseSetup(input?.setup);
  const settings = record(input?.settings);
  const requirements = record(input?.requirements);
  if (!input || !setup || !settings || !requirements || !Array.isArray(input.computers)) return undefined;
  if (settings.maxRunning !== 1 && settings.maxRunning !== 2) return undefined;
  const idleStopMinutes = count(settings.idleStopMinutes);
  const diskUsedBytes = count(input.diskUsedBytes);
  const freeDiskBytes = count(input.freeDiskBytes);
  const downloadBytes = count(requirements.downloadBytes);
  const baseDiskBytes = count(requirements.baseDiskBytes);
  const setupFreeBytes = count(requirements.setupFreeBytes);
  const memoryPerComputerBytes = count(requirements.memoryPerComputerBytes);
  const baseVersion = text(requirements.baseVersion, 32);
  if (
    idleStopMinutes === undefined ||
    diskUsedBytes === undefined ||
    downloadBytes === undefined ||
    baseDiskBytes === undefined ||
    setupFreeBytes === undefined ||
    memoryPerComputerBytes === undefined ||
    !baseVersion
  ) {
    return undefined;
  }
  const computers: BotComputerStatus[] = [];
  for (const entry of input.computers) {
    const computer = parseBotComputerStatus(entry);
    if (computer) computers.push(computer);
  }
  return {
    setup,
    settings: { maxRunning: settings.maxRunning, idleStopMinutes },
    diskUsedBytes,
    ...(freeDiskBytes !== undefined ? { freeDiskBytes } : {}),
    computers,
    requirements: { downloadBytes, baseDiskBytes, setupFreeBytes, memoryPerComputerBytes, baseVersion },
  };
}

/** "20 GB", "8.6 GB". Decimal units, as download pages and Finder show them. */
export function formatBotComputerBytes(bytes: number): string {
  if (bytes >= 1_000_000_000 && bytes % 1_000_000_000 < 50_000_000) return `${Math.round(bytes / 1_000_000_000)} GB`;
  return formatHarnessBytes(bytes);
}

/** "about 20 GB": sizes stated before anything is downloaded are approximate. */
export function approximateBotComputerBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `about ${Math.round(bytes / 1_000_000_000)} GB`;
  return `about ${formatHarnessBytes(bytes)}`;
}

const BUILD_STEP_COPY: Record<"create" | "provision" | "guest_driver" | "permissions", string> = {
  create: "Installing macOS on the base computer",
  provision: "Preparing the base computer",
  guest_driver: "Installing Aiden's helper in the base computer",
  permissions: "Waiting for permissions in the base computer",
};

/** One line describing setup, for the Settings row and screen readers. */
export function botComputerSetupSummary(setup: BotComputerSetupState): string {
  switch (setup.kind) {
    case "unsupported":
      return setup.reason === "host_os"
        ? "Bot computers need macOS 26 or later on this Mac."
        : "Bot computers need a Mac with Apple silicon.";
    case "not_set_up":
      return "Not set up.";
    case "downloading":
      return setup.totalBytes > 0
        ? `Downloading macOS ${formatHarnessBytes(setup.receivedBytes)} of ${formatHarnessBytes(setup.totalBytes)}…`
        : "Downloading macOS…";
    case "verifying":
      return "Checking the download…";
    case "building_base":
      return `${BUILD_STEP_COPY[setup.step]}…`;
    case "ready":
      return setup.updateAvailable
        ? `Ready. A newer base (macOS ${setup.baseVersion}) is available.`
        : `Ready (macOS ${setup.baseVersion}).`;
    case "failed":
      return setup.message;
  }
}

/** Download progress as a whole percentage, or null outside the download. */
export function botComputerSetupPercent(setup: BotComputerSetupState): number | null {
  if (setup.kind !== "downloading" || setup.totalBytes <= 0) return null;
  return Math.min(100, Math.floor((setup.receivedBytes / setup.totalBytes) * 100));
}

export function botComputerSetupBusy(setup: BotComputerSetupState): boolean {
  return setup.kind === "downloading" || setup.kind === "verifying" || setup.kind === "building_base";
}

/** The computer's state in plain words, naming the Bot ("Ada's computer is running."). */
export function botComputerStateLabel(state: BotComputerRunState, botName: string): string {
  const owner = `${botName}'s computer`;
  switch (state) {
    case "stopped":
      return `${owner} is off. It starts when ${botName} needs it.`;
    case "starting":
      return `Starting ${owner}…`;
    case "running":
      return `${owner} is running.`;
    case "stopping":
      return `Stopping ${owner}…`;
    case "waiting_for_slot":
      return "Waiting for another Bot's computer";
    case "stale":
      return `${owner} didn't finish being made. Reset it to start again.`;
  }
}
