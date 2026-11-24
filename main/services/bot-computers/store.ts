import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BOT_COMPUTER_IDLE_STOP_CHOICES,
  BOT_COMPUTER_SHARED_DEFAULT_NAME,
  BOT_COMPUTER_SHARED_ID,
  DEFAULT_BOT_COMPUTERS_SETTINGS,
  type BotComputerKind,
  type BotComputersSettings,
} from "../../../renderer/shared/bot-computers.js";
import { writeJsonAtomic } from "../durable-fs.js";
import { isAidenVmName } from "./vm-names.js";

/** The guest driver a base passed its readiness probe with (and so every computer made from it). */
export interface BotComputerGuestDriverRecord {
  version: string;
  /** The guest user's home and uid the driver was installed under. */
  home: string;
  uid: number;
}

/** One first-class Linux computer (shared or dedicated). */
export interface BotComputerVmRecord {
  id: string;
  name: string;
  kind: BotComputerKind;
  vmName: string;
  baseBuild: string;
  createdAt: number;
  lastUsedAt?: number;
  /** Copied from the base at clone time: this computer's guest driver passed its probe. */
  guestDriver?: BotComputerGuestDriverRecord;
  /**
   * True when this computer's legacy macOS VM was removed during the one-time
   * upgrade to Linux: keeps the Bot's "has a computer" setting so a fresh
   * Linux VM is cloned once the Linux base is set up.
   */
  migratedFromMacos?: boolean;
}

/** One Bot's computer projection (kept mirrored for backward compatibility). */
export interface BotComputerRecord {
  vmName: string;
  baseBuild: string;
  createdAt: number;
  lastUsedAt?: number;
  /** Copied from the base at clone time: this computer's guest driver passed its probe. */
  guestDriver?: BotComputerGuestDriverRecord;
  migratedFromMacos?: boolean;
}

export interface BotComputersSetupRecord {
  /** The guest OS of the current base (`"linux"` for Debian 13; omitted on legacy macOS state). */
  guestOs?: "linux";
  /** The Debian build the current base was made from; unset until a base is ready. */
  baseBuild?: string;
  baseVersion?: string;
  /** The verified disk image waiting to become a base, kept so a failed build retries without a download. */
  ipswPath?: string;
  /** Set when the base's guest driver passed its probe; unset keeps every computer on the VNC lane. */
  guestDriver?: BotComputerGuestDriverRecord;
}

/** Recorded during and after the one-time first-launch removal of legacy macOS Bot computers. */
export interface BotComputersMacosMigrationRecord {
  /** Set only once every targeted legacy macOS VM and .ipsw file has been removed. */
  completedAt?: number;
  freedBytes: number;
  /** True once the person sets up Linux, removes everything, or dismisses the Settings notice. */
  noticeDismissed?: boolean;
}

export interface BotComputersState {
  version: 1;
  settings: BotComputersSettings;
  setup: BotComputersSetupRecord;
  /** First-class Linux computers keyed by `computerId` (`"shared"` or a dedicated id). */
  vms: Record<string, BotComputerVmRecord>;
  /** Bot -> assigned `computerId`. */
  assignments: Record<string, string>;
  /** Legacy/compat per-Bot view mirrored from `assignments` + `vms`. */
  computers: Record<string, BotComputerRecord>;
  macosMigration?: BotComputersMacosMigrationRecord;
}

export function emptyBotComputersState(): BotComputersState {
  return {
    version: 1,
    settings: { ...DEFAULT_BOT_COMPUTERS_SETTINGS },
    setup: {},
    vms: {},
    assignments: {},
    computers: {},
  };
}

const COMPUTER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function vmRecordToComputerRecord(vm: BotComputerVmRecord): BotComputerRecord {
  return {
    vmName: vm.vmName,
    baseBuild: vm.baseBuild,
    createdAt: vm.createdAt,
    ...(vm.lastUsedAt !== undefined ? { lastUsedAt: vm.lastUsedAt } : {}),
    ...(vm.guestDriver ? { guestDriver: { ...vm.guestDriver } } : {}),
    ...(vm.migratedFromMacos === true ? { migratedFromMacos: true } : {}),
  };
}

/** Rebuild the mirrored `computers` map from `assignments` and `vms` (dropping dangling assignments). */
export function syncBotComputersProjection(state: BotComputersState): void {
  const nextComputers: Record<string, BotComputerRecord> = {};
  for (const [botId, computerId] of Object.entries(state.assignments)) {
    const vm = state.vms[computerId];
    if (!vm) {
      delete state.assignments[botId];
      continue;
    }
    nextComputers[botId] = vmRecordToComputerRecord(vm);
  }
  state.computers = nextComputers;
}

function text(value: unknown, limit = 64): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

function time(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function guestDriver(value: unknown): BotComputerGuestDriverRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { version, home, uid } = value as Record<string, unknown>;
  if (typeof version !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,6}$/u.test(version)) return undefined;
  if (typeof home !== "string" || !/^\/(?:Users|home)\/[A-Za-z0-9._-]{1,64}$/u.test(home)) return undefined;
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0 || uid > 9_999_999) return undefined;
  return { version, home, uid };
}

function parseMigration(value: unknown): BotComputersMacosMigrationRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const freedBytes = time(input.freedBytes);
  if (freedBytes === undefined) return undefined;
  const completedAt = input.completedAt === undefined ? undefined : time(input.completedAt);
  if (input.completedAt !== undefined && completedAt === undefined) return undefined;
  return {
    ...(completedAt !== undefined ? { completedAt } : {}),
    freedBytes,
    ...(input.noticeDismissed === true ? { noticeDismissed: true } : {}),
  };
}

/** Read what is valid and drop the rest, so one bad field never strands every computer. */
export function parseBotComputersState(value: unknown): BotComputersState {
  const state = emptyBotComputersState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return state;
  const input = value as Record<string, unknown>;
  const settings = input.settings as Record<string, unknown> | undefined;
  if (settings && typeof settings === "object") {
    if (
      settings.maxRunning === 1 ||
      settings.maxRunning === 2 ||
      settings.maxRunning === 3 ||
      settings.maxRunning === 4
    ) {
      state.settings.maxRunning = settings.maxRunning;
    }
    if ((BOT_COMPUTER_IDLE_STOP_CHOICES as readonly unknown[]).includes(settings.idleStopMinutes)) {
      state.settings.idleStopMinutes = settings.idleStopMinutes as number;
    }
    if (settings.defaultComputerMode === "shared" || settings.defaultComputerMode === "dedicated") {
      state.settings.defaultComputerMode = settings.defaultComputerMode;
    }
  }
  const setup = input.setup as Record<string, unknown> | undefined;
  if (setup && typeof setup === "object") {
    if (setup.guestOs === "linux") state.setup.guestOs = "linux";
    const baseBuild = text(setup.baseBuild, 32);
    const baseVersion = text(setup.baseVersion, 32);
    const ipswPath = text(setup.ipswPath, 4096);
    if (baseBuild) state.setup.baseBuild = baseBuild;
    if (baseVersion) state.setup.baseVersion = baseVersion;
    if (ipswPath && path.isAbsolute(ipswPath)) state.setup.ipswPath = ipswPath;
    const driver = guestDriver(setup.guestDriver);
    if (driver && baseBuild) state.setup.guestDriver = driver;
  }
  const rawVms = input.vms as Record<string, unknown> | undefined;
  if (rawVms && typeof rawVms === "object" && !Array.isArray(rawVms)) {
    for (const [id, raw] of Object.entries(rawVms)) {
      if (!raw || typeof raw !== "object" || !COMPUTER_ID_PATTERN.test(id)) continue;
      const entry = raw as Record<string, unknown>;
      const vmName = text(entry.vmName);
      const kind = entry.kind === "shared" || entry.kind === "dedicated" ? entry.kind : undefined;
      const name =
        text(entry.name, 64) ?? (id === BOT_COMPUTER_SHARED_ID ? BOT_COMPUTER_SHARED_DEFAULT_NAME : "Dedicated computer");
      const baseBuild = typeof entry.baseBuild === "string" && entry.baseBuild.length <= 32 ? entry.baseBuild : undefined;
      const createdAt = time(entry.createdAt);
      if (!vmName || !isAidenVmName(vmName) || !kind || baseBuild === undefined || createdAt === undefined) continue;
      const lastUsedAt = time(entry.lastUsedAt);
      const driver = guestDriver(entry.guestDriver);
      state.vms[id] = {
        id,
        name,
        kind,
        vmName,
        baseBuild,
        createdAt,
        ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
        ...(driver ? { guestDriver: driver } : {}),
        ...(entry.migratedFromMacos === true ? { migratedFromMacos: true } : {}),
      };
    }
  }
  const rawAssignments = input.assignments as Record<string, unknown> | undefined;
  if (rawAssignments && typeof rawAssignments === "object" && !Array.isArray(rawAssignments)) {
    for (const [botId, computerId] of Object.entries(rawAssignments)) {
      if (botId.length === 0 || botId.length > 200 || typeof computerId !== "string") continue;
      if (state.vms[computerId]) state.assignments[botId] = computerId;
    }
  }
  // Backward-compatible migration of legacy `computers[botId]` entries into dedicated VMs + assignments.
  const computers = input.computers as Record<string, unknown> | undefined;
  if (computers && typeof computers === "object" && !Array.isArray(computers)) {
    for (const [botId, raw] of Object.entries(computers)) {
      if (!raw || typeof raw !== "object" || botId.length === 0 || botId.length > 200) continue;
      if (state.assignments[botId]) continue;
      const entry = raw as Record<string, unknown>;
      const vmName = text(entry.vmName);
      const baseBuild = typeof entry.baseBuild === "string" && entry.baseBuild.length <= 32 ? entry.baseBuild : undefined;
      const createdAt = time(entry.createdAt);
      if (!vmName || !isAidenVmName(vmName) || baseBuild === undefined || createdAt === undefined) continue;
      const lastUsedAt = time(entry.lastUsedAt);
      const driver = guestDriver(entry.guestDriver);
      const id = vmName;
      if (!state.vms[id]) {
        state.vms[id] = {
          id,
          name: "Dedicated computer",
          kind: "dedicated",
          vmName,
          baseBuild,
          createdAt,
          ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
          ...(driver ? { guestDriver: driver } : {}),
          ...(entry.migratedFromMacos === true ? { migratedFromMacos: true } : {}),
        };
      }
      state.assignments[botId] = id;
    }
  }
  syncBotComputersProjection(state);
  const migration = parseMigration(input.macosMigration);
  if (migration) state.macosMigration = migration;
  return state;
}

export interface BotComputersStore {
  read(): Promise<BotComputersState>;
  /** Serialized read-modify-write; the callback edits a copy. */
  update(change: (state: BotComputersState) => void): Promise<BotComputersState>;
  /** Forget everything (Remove everything). */
  clear(): Promise<void>;
}

/** `<userData>/bot-computers/state.json`, written atomically (0600). */
export function createBotComputersStore(file: string): BotComputersStore {
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  };
  async function load(): Promise<BotComputersState> {
    try {
      return parseBotComputersState(JSON.parse(await readFile(file, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
        return emptyBotComputersState();
      }
      throw error;
    }
  }
  async function save(state: BotComputersState): Promise<void> {
    await writeJsonAtomic(file, state, { mode: 0o600, mkdirMode: 0o700, space: 2, trailingNewline: true });
  }
  return {
    read: () => serialize(load),
    update: (change) =>
      serialize(async () => {
        const state = await load();
        change(state);
        syncBotComputersProjection(state);
        await save(state);
        return parseBotComputersState(state);
      }),
    clear: () => serialize(() => save(emptyBotComputersState())),
  };
}
