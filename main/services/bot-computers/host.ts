import { randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  BOT_COMPUTER_SHARED_DEFAULT_NAME,
  BOT_COMPUTER_SHARED_ID,
  parseBotComputerAssignTarget,
  parseBotComputerId,
  parseBotComputerName,
  parseBotComputersSettingsPatch,
  type BotComputerMaxRunning,
  type BotComputerRunState,
  type BotComputerSetupState,
  type BotComputersSettings,
  type BotComputersStatus,
  type BotComputerStatus,
  type BotComputerVmStatus,
} from "../../../renderer/shared/bot-computers.js";
import { reportAnalyticsEvent } from "../analytics/analytics-report.js";
import { quoteRemoteArg } from "../devices/ssh-device-script.js";
import { CUA_DRIVER_VERSION } from "../computer-use/contract.js";
import type { CuaDriverHostFactory, CuaDriverSessionLike } from "../computer-use/controller.js";
import { writeCloudInitSeedIso } from "./cloud-init-iso.js";
import { createBotComputerControl, type BotComputerControlRegistry } from "./control.js";
import { createGuestCuaDriverHostFactory, guestDriverSshBridge, type GuestDriverBridgeCommand } from "./guest-driver.js";
import {
  installGuestDriver,
  LINUX_GUEST_DRIVER_PIN,
  type GuestDriverLocation,
} from "./guest-driver-install.js";
import { guestDriverReady, probeGuestDriver } from "./guest-driver-readiness.js";
import { prepareLinuxBaseDisk } from "./linux-base.js";
import { lumeEnvironment, runLume, type LumeCommand, type LumeInvocation, type LumeRunResult } from "./lume-cli.js";
import { classifyLumeError, isLoopbackHost, parseLumeVmInfo, parseLumeVmList, type LumeErrorKind, type LumeVmInfo } from "./lume-output.js";
import {
  BOT_COMPUTER_LINUX_DESKTOP_PACKAGES,
  BOT_COMPUTER_LINUX_VNC_SOCKET,
  buildLinuxBaseVm,
  generateGuestPassword,
  linuxGuestVncStartScript,
  type LinuxProvisionContext,
} from "./provision.js";
import {
  BOT_COMPUTER_LINUX_BASE_DISK_RESERVE_BYTES,
  BOT_COMPUTER_LINUX_BASE_SIZE_BYTES,
  BOT_COMPUTER_LINUX_CPU_COUNT,
  BOT_COMPUTER_LINUX_DISK_BYTES,
  BOT_COMPUTER_LINUX_DISK_GB,
  BOT_COMPUTER_LINUX_DISPLAY,
  BOT_COMPUTER_LINUX_IMAGE,
  BOT_COMPUTER_LINUX_MEMORY_BYTES,
  BOT_COMPUTER_LINUX_MEMORY_GB,
  BOT_COMPUTER_LINUX_MIN_MEMORY_BYTES,
} from "./release.js";
import { allocatedBytes, requireResources, systemResourceProbe, type BotComputerResourceProbe } from "./resources.js";
import { createRestoreImageDownloader, type RestoreImagePin } from "./restore-image-download.js";
import { createBotComputerActivity, type BotComputerActivity } from "./sessions.js";
import {
  BOT_COMPUTER_GUEST_USER,
  ensureKeyPair,
  guestSshEnvironment,
  guestSshPaths,
  openGuestVncTunnel,
  runGuestCommand as runSshCommand,
  scanGuestHostKey,
  writeKnownHost,
  type GuestSshTarget,
  type GuestVncTunnel,
  type ProcessRunner,
} from "./ssh.js";
import {
  createBotComputersStore,
  type BotComputerGuestDriverRecord,
  type BotComputerVmRecord,
  type BotComputersState,
} from "./store.js";
import {
  BOT_COMPUTER_GUEST_PASSWORD_SECRET,
  BOT_COMPUTER_LINUX_MIGRATION_BOT_NOTE,
  BOT_COMPUTER_SECRET_FAMILY,
  BotComputerError,
  type BotComputerConnection,
  type BotComputerGuestCommandResult,
  type BotComputerHost,
  type BotComputerLeaseRelease,
  type BotComputerStartReason,
  type BotComputerStopReason,
} from "./types.js";
import { vncReachableBeyondLoopback } from "./vnc-exposure.js";
import {
  BOT_COMPUTER_BASE_VM,
  BOT_COMPUTER_SHARED_VM,
  BOT_COMPUTER_STAGING_BASE_VM,
  botComputerPoolVmName,
  botComputerVmName,
  botComputerWorkspaceDirName,
  isAidenVmName,
} from "./vm-names.js";

export interface BotComputerSecrets {
  /** The stored value, or null when there is none. Throws when the store can't be read. */
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  deleteFamily(prefix: string): Promise<void>;
}

export interface BotComputerHostDependencies {
  /** `<userData>/bot-computers`. */
  root: string;
  /** The verified vendored Lume (resolved once, on first use). */
  lume(): Promise<LumeInvocation>;
  /** Whether this Mac can host Bot computers at all. */
  support(): { ok: true } | { ok: false; reason: "platform" | "host_os" };
  /** `<botHome>/Computer`, shared read-write into the guest. */
  botComputerDir(botId: string): Promise<string>;
  botName?(botId: string): string | Promise<string>;
  secrets: BotComputerSecrets;
  env?: NodeJS.ProcessEnv;
  resources?: BotComputerResourceProbe;
  fetchImpl?: typeof fetch;
  image?: RestoreImagePin;
  now?(): number;
  /** Idle timers; tests drive them by hand. */
  schedule?(callback: () => void, ms: number): () => void;
  /** Poll gap while a VM starts or stops. */
  pollIntervalMs?: number;
  startTimeoutMs?: number;
  /**
   * How long a start that failed after `lume run` keeps watching for the VM to come up
   * (Lume's detached run can return before the VM it launched is up), to turn it off.
   */
  launchSettleMs?: number;
  /** `/usr/bin/ssh`, `/usr/bin/ssh-keygen`, and `/usr/bin/ssh-keyscan`, or fakes. */
  sshCommand?: string;
  keygenCommand?: string;
  keyscanCommand?: string;
  runProcess?: ProcessRunner;
  vncExposed?(port: number): Promise<boolean>;
  /** Open the host-loopback SSH VNC tunnel for a Linux Bot computer (test seam). */
  openVncTunnel?(
    target: GuestSshTarget,
    remoteSocket: string,
    options: { signal?: AbortSignal },
  ): Promise<GuestVncTunnel>;
  control?: BotComputerControlRegistry;
  activity?: BotComputerActivity;
  /**
   * The vendored Linux arm64 cua-driver to copy into a base, verified against Aiden's pin
   * (the guest driver lane). Without it, or when it can't be resolved, bases
   * are made for the VNC lane only.
   */
  guestDriverExecutable?(signal: AbortSignal): Promise<string>;
  /** cua-driver's licence notice from the same helper bundle, copied beside the driver in the guest. */
  guestDriverNotice?(): string | undefined;
  /** The guest lane's host factory over a bridge; tests swap in the fake driver. */
  guestDriverHost?(bridge: () => Promise<GuestDriverBridgeCommand>): CuaDriverHostFactory;
  /** Setup finished: the Bot runtime may now offer computers. */
  onSetupReady?(): void;
  /** Remove everything or macOS cleanup finished. */
  onRemoved?(): void;
  /** Called once per Bot whose legacy macOS computer was removed during first-launch migration. */
  onMacosComputerMigrated?(botId: string, note: string): Promise<void> | void;
  log?(message: string, error?: unknown): void;
}

/**
 * One start, shared by every caller that asked for the computer while it was
 * starting (a Bot's tool call, a routine, the person's Computer tab). It is
 * abandoned only when every caller has given up.
 */
interface SharedStart {
  promise: Promise<BotComputerConnection>;
  controller: AbortController;
  callers: number;
  progress: Set<(text: string) => void>;
}

interface QueueWaiter {
  botId: string;
  resolve(release: BotComputerLeaseRelease): void;
  reject(error: unknown): void;
  cleanup(): void;
}

/** Per-VM runtime state keyed by `computerId` (`"shared"` or a dedicated id). */
interface Runtime {
  state: BotComputerRunState;
  connection?: BotComputerConnection;
  vncTunnel?: GuestVncTunnel;
  start?: SharedStart;
  stopping?: Promise<void>;
  cancelIdle?: () => void;
  lastUsedAt?: number;
  leases: number;
  /** Bot currently holding the FIFO turn lease on this computer. */
  activeBotId?: string;
  /** Re-entrant hold depth for `activeBotId`. */
  activeCount: number;
  /** AbortController aborted if the active lease is revoked (reassignment, forced reset/delete). */
  activeLeaseAbort?: AbortController;
  /** Monotonic generation bumped when an active lease is forcibly cleared (delete/remove/shutdown). */
  leaseEpoch: number;
  /** Bots queued behind `activeBotId` in FIFO order. */
  waiters: QueueWaiter[];
}

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
const LINUX_BASE_BUILD_PATTERN = /^\d{8}-\d+$/u;
const SAFE_BOT_WORKSPACE_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const GUEST_SHARED_BOTS_MOUNT = "/mnt/aiden-shared/Computer/bots";

function assignedComputerId(state: BotComputersState, botId: string): string | undefined {
  return hasOwn(state.assignments, botId) ? state.assignments[botId] : undefined;
}

function isLinuxBuild(build: string | undefined): boolean {
  return build !== undefined && LINUX_BASE_BUILD_PATTERN.test(build);
}

function isLegacyMacosVmRecord(vm: BotComputerVmRecord, state: BotComputersState): boolean {
  if (vm.migratedFromMacos) return true;
  if (state.setup.guestOs === "linux") return false;
  return vm.baseBuild.length > 0 && !isLinuxBuild(vm.baseBuild);
}

const SLOT_STATES: ReadonlySet<BotComputerRunState> = new Set(["starting", "running", "stopping"]);
/** A computer used this recently is in use, not idle, even between actions. */
const ACTIVE_USE_MS = 60_000;
const START_DISK_BYTES = 5 * 1024 ** 3;
const VNC_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
/** The line Lume's detached launch writes to its log when it fails: the VM isn't coming up. */
const LUME_LOG_ERROR = /^Error:/mu;
const LOG_TAIL_BYTES = 16_384;

function vncPassword(): string {
  let value = "";
  for (let index = 0; index < 32; index += 1) value += VNC_PASSWORD_ALPHABET[randomInt(VNC_PASSWORD_ALPHABET.length)];
  return value;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BotComputerError("cancelled", "Starting the computer was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new BotComputerError("cancelled", "Starting the computer was cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof BotComputerError) return error.message;
  return "Something went wrong setting up Bot computers.";
}

export function createBotComputerHost(deps: BotComputerHostDependencies): BotComputerHost & {
  /** For tests and the main wiring. */
  readonly control: BotComputerControlRegistry;
  readonly activity: BotComputerActivity;
} {
  const root = deps.root;
  const dirs = {
    vms: path.join(root, "vms"),
    computers: path.join(root, "computers"),
    home: path.join(root, "home"),
    logs: path.join(root, "logs"),
    images: path.join(root, "restore-images"),
    baseShared: path.join(root, "base-shared"),
  };
  const sshPaths = guestSshPaths(root);
  const image = deps.image ?? BOT_COMPUTER_LINUX_IMAGE;
  const store = createBotComputersStore(path.join(root, "state.json"));
  const resources = deps.resources ?? systemResourceProbe;
  const now = deps.now ?? Date.now;
  const schedule =
    deps.schedule ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  const pollMs = deps.pollIntervalMs ?? 1_000;
  const startTimeoutMs = deps.startTimeoutMs ?? 240_000;
  const launchSettleMs = deps.launchSettleMs ?? 10_000;
  const control = deps.control ?? createBotComputerControl();
  const activity = deps.activity ?? createBotComputerActivity();
  const exposed = deps.vncExposed ?? ((port: number) => vncReachableBeyondLoopback(port));
  const openVncTunnel =
    deps.openVncTunnel ??
    ((target: GuestSshTarget, remoteSocket: string, options: { signal?: AbortSignal }) =>
      openGuestVncTunnel(target, remoteSocket, options, {
        paths: sshPaths,
        env: guestSshEnvironment(deps.env ?? process.env, dirs.home),
        sshCommand: deps.sshCommand,
      }));
  const log = deps.log ?? (() => undefined);
  const downloader = createRestoreImageDownloader({
    dir: dirs.images,
    image,
    filename: `debian-${image.build}.raw`,
    label: "Debian Linux",
    serverLabel: "Debian's download server",
    allowHttpsRedirects: true,
    fetchImpl: deps.fetchImpl,
    freeDiskBytes: (dir) => resources.freeDiskBytes(dir),
    reserveBytes: BOT_COMPUTER_LINUX_BASE_DISK_RESERVE_BYTES,
  });

  /** Per-VM runtimes keyed by `computerId`. */
  const runtimes = new Map<string, Runtime>();
  /** Per-VM stale set keyed by `computerId`. */
  const stale = new Set<string>();
  /** Mirror of `state.assignments` (`botId -> computerId`) for synchronous control/connection lookups. */
  const assignmentCache = new Map<string, string>();
  const syncAssignmentCache = (state: BotComputersState): BotComputersState => {
    assignmentCache.clear();
    for (const [botId, computerId] of Object.entries(state.assignments)) {
      assignmentCache.set(botId, computerId);
    }
    return state;
  };
  const readState = async (): Promise<BotComputersState> => syncAssignmentCache(await store.read());
  const updateState = async (change: (draft: BotComputersState) => void): Promise<BotComputersState> =>
    syncAssignmentCache(await store.update(change));
  const assignedBotsFromCache = (computerId: string): string[] => {
    const out: string[] = [];
    for (const [botId, assignedId] of assignmentCache) {
      if (assignedId === computerId) out.push(botId);
    }
    return out;
  };
  const assignedBotsInState = (state: BotComputersState, computerId: string): string[] =>
    Object.entries(state.assignments)
      .filter(([, assignedId]) => assignedId === computerId)
      .map(([botId]) => botId);
  control.setScopeResolver(
    (botId) => assignmentCache.get(botId) ?? botId,
    (scope) => assignedBotsFromCache(scope),
  );
  const listeners = new Set<(botId: string | undefined) => void>();
  const slotWaiters = new Set<() => void>();
  let setupState: BotComputerSetupState | undefined;
  let setupTask: Promise<void> | undefined;
  let setupAbort: AbortController | undefined;
  let shuttingDown = false;
  /** Aborted first when Aiden quits: it ends any `lume run` still launching, at once. */
  const quitting = new AbortController();
  let diskCache: { at: number; bytes: number; vmBytes: Map<string, number> } | undefined;
  /** A base being built boots as a VM too, so it holds one of the running places. */
  let baseHoldsSlot = false;
  /**
   * Give and Reset copying the base's disk right now. Set up and Update base
   * wait for them before they boot or replace the base, so no copy reads a
   * disk that is running or being swapped.
   */
  const copies = new Set<Promise<unknown>>();
  const guestHostFor =
    deps.guestDriverHost ?? ((bridge: () => Promise<GuestDriverBridgeCommand>) => createGuestCuaDriverHostFactory({ bridge }));

  const emit = (botId?: string) => {
    diskCache = undefined;
    for (const listener of listeners) {
      try {
        listener(botId);
      } catch (error) {
        log("A Bot computer listener failed.", error);
      }
    }
  };
  const emitVm = (computerId: string) => {
    const members = assignedBotsFromCache(computerId);
    if (members.length === 1) emit(members[0]);
    else emit();
  };
  control.onChange((botId) => emit(botId));
  activity.onChange((botId) => emit(botId));

  const runtime = (computerId: string): Runtime => {
    let found = runtimes.get(computerId);
    if (!found) {
      found = { state: "stopped", leases: 0, activeCount: 0, leaseEpoch: 0, waiters: [] };
      runtimes.set(computerId, found);
    }
    return found;
  };
  const occupied = () =>
    [...runtimes.values()].filter((entry) => SLOT_STATES.has(entry.state)).length + (baseHoldsSlot ? 1 : 0);
  /** Count only already-running VMs so concurrent cold starts don't double-count unallocated RAM. */
  const runningCount = () => [...runtimes.values()].filter((entry) => entry.state === "running").length;

  /** Upper bound on concurrent Linux Bot computers: 1–4 based on host available memory. */
  async function currentMaxRunningLimit(): Promise<BotComputerMaxRunning> {
    try {
      const available = await resources.availableMemoryBytes();
      const effective = available + runningCount() * BOT_COMPUTER_LINUX_MEMORY_BYTES;
      return Math.max(1, Math.min(4, Math.floor(effective / BOT_COMPUTER_LINUX_MEMORY_BYTES))) as BotComputerMaxRunning;
    } catch {
      return 2;
    }
  }
  const wakeSlotWaiters = () => {
    const waiters = [...slotWaiters];
    slotWaiters.clear();
    for (const wake of waiters) wake();
  };
  const name = async (botId: string) => (await deps.botName?.(botId)) ?? "the Bot";
  const possessive = async (botId: string) => `${await name(botId)}'s`;

  let lumeInvocation: Promise<LumeInvocation> | undefined;
  const invocation = () => {
    lumeInvocation ??= deps.lume().catch((error: unknown) => {
      lumeInvocation = undefined;
      throw error;
    });
    return lumeInvocation;
  };
  const lumeEnv = () => lumeEnvironment(deps.env ?? process.env, dirs.home);

  async function lume(
    command: LumeCommand,
    timeoutMs: number,
    signal?: AbortSignal,
    onSpawn?: () => void,
    killOnAbort?: boolean,
  ): Promise<LumeRunResult> {
    // Verified first: Aiden's VM storage only appears once Lume can run, so a
    // Mac whose helper is missing never makes later deletes or startups run it.
    const resolved = await invocation();
    await mkdir(dirs.vms, { recursive: true, mode: 0o700 });
    await mkdir(dirs.home, { recursive: true, mode: 0o700 });
    return runLume(resolved, command, { storage: dirs.vms, env: lumeEnv(), timeoutMs, signal, onSpawn, killOnAbort });
  }

  const failureKind = (result: LumeRunResult): LumeErrorKind =>
    classifyLumeError(`${result.stderr}\n${result.stdout}`, result.exitCode);

  async function lumeOrThrow(command: LumeCommand, timeoutMs: number, message: string, signal?: AbortSignal): Promise<LumeRunResult> {
    const result = await lume(command, timeoutMs, signal);
    if (result.exitCode !== 0) {
      log(`lume ${command.op} failed: ${result.stderr.slice(-600)}`);
      throw new BotComputerError("lume_failed", message);
    }
    return result;
  }

  /**
   * Delete a VM; one Lume no longer has counts as deleted. A VM still running
   * (one an earlier launch left on, or whose stop failed) is turned off first:
   * Lume refuses to delete it, and Remove everything would otherwise delete
   * its files underneath it and leave it running where nothing can see it.
   */
  async function deleteVm(vmName: string): Promise<void> {
    if (!existsSync(dirs.vms)) return;
    const info = await getVm(vmName).catch(() => undefined);
    if (info?.state === "running") await stopVm(vmName, true);
    const result = await lume({ op: "delete", name: vmName }, 300_000);
    if (result.exitCode === 0 || failureKind(result) === "not_found") return;
    log(`lume delete failed: ${result.stderr.slice(-600)}`);
    throw new BotComputerError("lume_failed", "Aiden couldn't delete the computer. Try again.");
  }

  /**
   * Resolves what Lume found: a VM it turned off, one that wasn't running, or none by that name.
   * `owner` ("Ada's") names the computer when even the forced stop fails, so a start that needed
   * its place says whose computer it was.
   */
  async function stopVm(vmName: string, force: boolean, owner = "the"): Promise<"stopped" | "not_running" | "not_found"> {
    const result = await lume({ op: "stop", name: vmName, force, timeoutSeconds: force ? 0 : 30 }, force ? 30_000 : 75_000);
    if (result.exitCode === 0) return "stopped";
    const kind = failureKind(result);
    if (kind === "not_running" || kind === "not_found") return kind;
    if (!force) return stopVm(vmName, true, owner);
    log(`lume stop failed: ${result.stderr.slice(-600)}`);
    throw new BotComputerError("lume_failed", `Aiden couldn't stop ${owner} computer.`);
  }

  async function getVm(vmName: string, signal?: AbortSignal): Promise<LumeVmInfo | undefined> {
    const result = await lume({ op: "get", name: vmName }, 30_000, signal);
    if (result.exitCode !== 0) {
      if (failureKind(result) === "not_found") return undefined;
      throw new BotComputerError("lume_failed", "Aiden couldn't read the computer's state.");
    }
    return parseLumeVmInfo(result.stdout);
  }

  /** The log's last 16 KiB, read from the end: the launch watch polls it while Lume's log grows. */
  async function logTail(file: string): Promise<string> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(file, "r");
      const { size } = await handle.stat();
      const length = Math.min(size, LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } catch {
      return "";
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  function startFailure(kind: LumeErrorKind, owner: string): BotComputerError {
    switch (kind) {
      case "vm_limit":
        return new BotComputerError(
          "vm_limit",
          "Another virtual machine is using the last available slot. Stop another virtual machine or Bot's computer, then try again.",
        );
      case "low_disk":
        return new BotComputerError(
          "low_disk",
          `${owner} computer didn't start because this Mac doesn't have enough free disk space. Free up space and try again.`,
        );
      case "not_found":
      case "stale":
        return new BotComputerError("stale", `${owner} computer is missing or incomplete. Reset it in the Bot's profile.`);
      default:
        return new BotComputerError("start_failed", `${owner} computer didn't start.`);
    }
  }

  /**
   * Turn off what a failed start may have launched, and resolve whether Lume still runs it.
   * While the VM may come up (`launchLog` names the log of a launch not known to have failed:
   * Lume's detached run can return, or fail, before the VM it launched is up), one that isn't
   * running yet is watched for `launchSettleMs` and turned off once it is, until that log shows
   * Lume's error. A forced stop that fails counts the VM as off only if Lume says so once the
   * watch is over, and an unreadable state counts as on.
   */
  async function stopFailedStart(vmName: string, launchLog?: string): Promise<boolean> {
    const watchUntil = launchLog === undefined ? 0 : performance.now() + launchSettleMs;
    const watching = async () => launchLog !== undefined && performance.now() < watchUntil && !LUME_LOG_ERROR.test(await logTail(launchLog));
    for (;;) {
      try {
        // Lume turned off what came up, or has no such VM: nothing else this start launched can run.
        if ((await stopVm(vmName, true)) !== "not_running" || !(await watching())) return false;
      } catch (error) {
        log("Stopping a failed start did not finish.", error);
        const running = await getVm(vmName).then(
          (info) => info?.state === "running",
          () => true,
        );
        if (running || !(await watching())) return running;
      }
      await delay(pollMs);
    }
  }

  /**
   * Start a VM detached and wait for it to be running with an IP (and, when
   * Lume's VNC is enabled on macOS, a loopback-only VNC endpoint). When
   * `vncDisabled` is true (Linux VMs), Lume is started with `--vnc disabled` so
   * macOS's `_VZVNCServer` never binds a wildcard `*:port` socket on the host.
   * A start that fails or is cancelled once Lume has begun launching the VM
   * turns it off before it rejects, and `onLeftRunning` hears when Lume still runs it.
   */
  async function runAndWait(
    vmName: string,
    sharedDir: string,
    owner: string,
    signal: AbortSignal | undefined,
    requireSsh: boolean,
    onLeftRunning?: () => void,
    mount?: string,
    vncDisabled = false,
  ): Promise<{ info: LumeVmInfo & { ip: string; vnc?: { host: string; port: number } }; password: string }> {
    const password = vncDisabled ? "" : vncPassword();
    await mkdir(dirs.logs, { recursive: true, mode: 0o700 });
    const logFile = path.join(dirs.logs, `${vmName}.log`);
    await rm(logFile, { force: true });
    let polls = 0;
    /** `none` until Lume's `run` has started; `ended` once its launch is known to have failed. */
    let launch = "none" as "none" | "launching" | "ended";
    try {
      if (signal?.aborted) throw new BotComputerError("cancelled", "Starting the computer was cancelled.");
      // `run --detach` launches the VM in the background before it returns, and the VM can
      // come up after that. So a cancel doesn't cut it short, which could stop it partway
      // through launching: it is bounded, and the cancel is honoured once it returns. Quit does
      // end it, at once: a `run` still starting up would launch the VM after Aiden has gone,
      // with nobody left to turn it off. A run that fails, times out or is ended by quit may
      // still have launched the VM: the catch turns it off.
      const started = await lume(
        vncDisabled
          ? { op: "run", name: vmName, vnc: "disabled", sharedDir, ...(mount ? { mount } : {}), logFile }
          : { op: "run", name: vmName, vncPassword: password, sharedDir, ...(mount ? { mount } : {}), logFile },
        60_000,
        quitting.signal,
        () => {
          launch = "launching";
        },
        true,
      );
      const refusal = started.exitCode === 0 ? undefined : failureKind(started);
      // Lume refused this VM (it has none by that name, it is still being made, the host lacks
      // disk space, or macOS's limit is reached): nothing is coming up. Any other failure may have
      // launched it.
      if (refusal === "not_found" || refusal === "stale" || refusal === "vm_limit" || refusal === "low_disk") launch = "ended";
      if (signal?.aborted) throw new BotComputerError("cancelled", "Starting the computer was cancelled.");
      if (refusal !== undefined) throw startFailure(refusal, owner);
      const deadline = now() + startTimeoutMs;
      for (;;) {
        polls += 1;
        const info = await getVm(vmName, signal);
        if (!info) throw startFailure("not_found", owner);
        if (info.stale) throw startFailure("stale", owner);
        if (info.state === "running" && info.ip && (vncDisabled || info.vnc) && (!requireSsh || info.sshAvailable === true)) {
          if (!vncDisabled) {
            if (!info.vnc || !isLoopbackHost(info.vnc.host)) {
              throw new BotComputerError("vnc_not_loopback", `${owner} computer offered its screen beyond this Mac, so Aiden stopped it.`);
            }
            if (await exposed(info.vnc.port)) {
              throw new BotComputerError("vnc_not_loopback", `${owner} computer's screen was reachable from the network, so Aiden stopped it.`);
            }
          }
          return { info: { ...info, ip: info.ip, ...(info.vnc ? { vnc: info.vnc } : {}) }, password };
        }
        if (info.state !== "running" && polls > 1) {
          const tail = await logTail(logFile);
          if (LUME_LOG_ERROR.test(tail)) {
            // Lume's background launch reported its failure: the VM isn't coming up.
            launch = "ended";
            throw startFailure(classifyLumeError(tail, 1), owner);
          }
        }
        if (now() > deadline) throw new BotComputerError("start_failed", `${owner} computer didn't start in time.`);
        await delay(pollMs, signal);
      }
    } catch (error) {
      // A Lume that never started (missing, or refused by the OS) launched nothing.
      if (launch !== "none" && (await stopFailedStart(vmName, launch === "launching" ? logFile : undefined))) onLeftRunning?.();
      throw error;
    }
  }

  function isVmBusy(computerId: string, entry: Runtime): boolean {
    return (
      entry.leases > 0 ||
      entry.activeBotId !== undefined ||
      entry.waiters.length > 0 ||
      control.controllerForScope(computerId) === "person" ||
      control.activeActionsForScope(computerId) > 0
    );
  }

  function idleCandidate(exceptComputerId?: string): string | undefined {
    let candidate: { computerId: string; lastUsedAt: number } | undefined;
    const current = now();
    for (const [computerId, entry] of runtimes) {
      if (computerId === exceptComputerId || entry.state !== "running" || isVmBusy(computerId, entry)) continue;
      const lastUsedAt = entry.lastUsedAt ?? 0;
      if (current - lastUsedAt < ACTIVE_USE_MS) continue;
      if (!candidate || lastUsedAt < candidate.lastUsedAt) candidate = { computerId, lastUsedAt };
    }
    return candidate?.computerId;
  }

  async function acquireSlot(computerId: string, entry: Runtime, signal: AbortSignal, onProgress?: (text: string) => void): Promise<void> {
    for (;;) {
      if (signal.aborted) throw new BotComputerError("cancelled", "Starting the computer was cancelled.");
      if (shuttingDown) throw new BotComputerError("busy", "Aiden is quitting.");
      const { settings } = await readState();
      const cap = Math.min(settings.maxRunning, await currentMaxRunningLimit());
      if (occupied() < cap) {
        entry.state = "starting";
        return;
      }
      const idle = idleCandidate(computerId);
      if (idle) {
        await stopVmRuntime(idle, "limit");
        continue;
      }
      if (entry.state !== "waiting_for_slot") {
        entry.state = "waiting_for_slot";
        emitVm(computerId);
      }
      onProgress?.("Waiting for another Bot's computer");
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          slotWaiters.delete(wake);
          reject(new BotComputerError("cancelled", "Starting the computer was cancelled."));
        };
        slotWaiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }

  /**
   * Lume's unattended install and the provisioning after it boot the base, so a
   * base build takes one of the running places. An idle computer gives up its
   * place, as at the cap; when every running computer is in use the build is
   * refused rather than pushed past macOS's limit or left waiting silently.
   * Bot computers that start meanwhile wait for the place like any other.
   */
  async function acquireBaseSlot(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw new BotComputerError("cancelled", "Setting up Bot computers was cancelled.");
      if (shuttingDown) throw new BotComputerError("busy", "Aiden is quitting.");
      const { settings } = await readState();
      const cap = Math.min(settings.maxRunning, await currentMaxRunningLimit());
      if (occupied() < cap) {
        baseHoldsSlot = true;
        return;
      }
      const idle = idleCandidate();
      if (!idle) {
        throw new BotComputerError(
          "busy",
          "Building the base computer needs one of the places Bot computers run in, and they're all in use. Stop a Bot's computer in its profile, then try again.",
        );
      }
      await stopVmRuntime(idle, "limit");
    }
  }

  function releaseBaseSlot(): void {
    if (!baseHoldsSlot) return;
    baseHoldsSlot = false;
    wakeSlotWaiters();
  }

  /**
   * Wait on a shared start for one caller. Its own signal only ends its own
   * wait; the start itself is abandoned once every caller has gone.
   */
  function joinStart(
    start: SharedStart,
    options: { signal?: AbortSignal; onProgress?(text: string): void },
  ): Promise<BotComputerConnection> {
    const { signal, onProgress } = options;
    start.callers += 1;
    if (onProgress) start.progress.add(onProgress);
    return new Promise<BotComputerConnection>((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return false;
        left = true;
        signal?.removeEventListener("abort", giveUp);
        if (onProgress) start.progress.delete(onProgress);
        start.callers -= 1;
        return true;
      };
      const giveUp = () => {
        if (!leave()) return;
        if (start.callers <= 0) start.controller.abort();
        reject(new BotComputerError("cancelled", "Starting the computer was cancelled."));
      };
      start.promise.then(
        (connection) => {
          if (leave()) resolve(connection);
        },
        (error: unknown) => {
          if (leave()) reject(error);
        },
      );
      if (signal?.aborted) giveUp();
      else signal?.addEventListener("abort", giveUp, { once: true });
    });
  }

  /**
   * The VMs this launch is using right now: computers starting, running or
   * stopping (Lume reports a starting VM as running before Aiden holds its
   * connection), and the base while Set up or Update base builds it.
   */
  async function vmsInUse(): Promise<Set<string>> {
    const names = new Set<string>();
    if (setupTask || baseHoldsSlot) {
      names.add(BOT_COMPUTER_BASE_VM);
      names.add(BOT_COMPUTER_STAGING_BASE_VM);
    }
    const { vms } = await readState();
    for (const [computerId, entry] of runtimes) {
      if (entry.state === "stopped" && !entry.start && !entry.stopping) continue;
      const vmName = entry.connection?.vmName ?? vms[computerId]?.vmName;
      if (vmName) names.add(vmName);
    }
    return names;
  }

  function armIdle(computerId: string, entry: Runtime, minutes: number): void {
    entry.cancelIdle?.();
    entry.cancelIdle = schedule(() => {
      entry.cancelIdle = undefined;
      if (entry.state !== "running") return;
      if (isVmBusy(computerId, entry)) {
        armIdle(computerId, entry, minutes);
        return;
      }
      void stopVmRuntime(computerId, "idle").catch((error: unknown) => log("Idle stop did not finish.", error));
    }, minutes * 60_000);
  }

  function removeBotFromQueue(computerId: string, botId: string): void {
    const entry = runtimes.get(computerId);
    if (!entry) return;
    let changed = false;
    const remaining: QueueWaiter[] = [];
    for (const waiter of entry.waiters) {
      if (waiter.botId === botId) {
        waiter.cleanup();
        waiter.reject(new BotComputerError("cancelled", "Waiting for the computer was cancelled."));
        changed = true;
      } else {
        remaining.push(waiter);
      }
    }
    entry.waiters = remaining;
    if (changed) emitVm(computerId);
  }

  function clearQueue(computerId: string, message: string, options?: { forceActive?: boolean }): void {
    const entry = runtimes.get(computerId);
    if (!entry) return;
    const waiters = entry.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.cleanup();
      waiter.reject(new BotComputerError("cancelled", message));
    }
    if (options?.forceActive) {
      entry.leaseEpoch += 1;
      const abort = entry.activeLeaseAbort;
      entry.activeLeaseAbort = undefined;
      entry.activeBotId = undefined;
      entry.activeCount = 0;
      abort?.abort(new BotComputerError("cancelled", message));
    }
  }

  function revokeBotLease(
    computerId: string,
    botId: string,
    reason = "The Bot was reassigned to another computer.",
  ): void {
    removeBotFromQueue(computerId, botId);
    const entry = runtimes.get(computerId);
    if (!entry || entry.activeBotId !== botId) return;
    entry.leaseEpoch += 1;
    const abort = entry.activeLeaseAbort;
    const next = entry.waiters.shift();
    if (next) {
      next.cleanup();
      entry.activeBotId = next.botId;
      entry.activeCount = 1;
      entry.activeLeaseAbort = new AbortController();
      emitVm(computerId);
      next.resolve(makeLeaseRelease(computerId, entry, next.botId, entry.leaseEpoch, entry.activeLeaseAbort.signal));
    } else {
      entry.activeBotId = undefined;
      entry.activeCount = 0;
      entry.activeLeaseAbort = undefined;
      emitVm(computerId);
    }
    abort?.abort(new BotComputerError("cancelled", reason));
  }

  function releaseOrphanedControlScope(computerId: string, state: BotComputersState): void {
    if (assignedBotsInState(state, computerId).length > 0) return;
    if (control.controllerForScope(computerId) === "person" && control.takenOverByScope(computerId) !== "sign_in") {
      control.giveBackScope(computerId);
    }
  }

  async function assertNotSymlinkDir(target: string): Promise<void> {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new BotComputerError("invalid", "The Bot's Computer folder contains an unsafe symbolic link or non-directory.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw error;
    }
  }

  function isPoolWorkspaceId(computerId: string): boolean {
    return (
      computerId === BOT_COMPUTER_SHARED_ID ||
      computerId.startsWith("vm-") ||
      computerId.startsWith("aiden-vm-")
    );
  }

  function isVmLive(computerId: string): boolean {
    const entry = runtimes.get(computerId);
    return entry !== undefined && (SLOT_STATES.has(entry.state) || entry.start !== undefined || entry.stopping !== undefined);
  }

  async function runGuestWorkspaceScript(computerId: string, script: string): Promise<void> {
    const connection = runtimes.get(computerId)?.connection;
    if (!connection) return;
    await runSshCommand(
      connection.ssh,
      script,
      { timeoutMs: 15_000, maxOutputBytes: 4_096 },
      {
        paths: sshPaths,
        env: guestSshEnvironment(deps.env ?? process.env, dirs.home),
        sshCommand: deps.sshCommand,
        run: deps.runProcess,
      },
    ).catch((error: unknown) => log("Updating guest Bot workspace folder did not finish.", error));
  }

  async function removeComputerWorkspace(computerId: string): Promise<void> {
    if (!isPoolWorkspaceId(computerId)) return;
    const dir = path.join(dirs.computers, computerId);
    try {
      const info = await lstat(dir);
      if (info.isSymbolicLink()) return;
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log("Removing computer workspace folder did not finish.", error);
      }
    }
  }

  async function removeBotWorkspaceSubfolder(computerId: string, botId: string): Promise<void> {
    if (!isPoolWorkspaceId(computerId)) return;
    const workspaceName = botComputerWorkspaceDirName(botId);
    if (!SAFE_BOT_WORKSPACE_DIR_PATTERN.test(workspaceName) || workspaceName.includes("..")) return;
    const guestPath = `${GUEST_SHARED_BOTS_MOUNT}/${workspaceName}`;
    const guestCleanScript = `if [ -d ${quoteRemoteArg(GUEST_SHARED_BOTS_MOUNT)} ] && [ ! -L ${quoteRemoteArg(GUEST_SHARED_BOTS_MOUNT)} ]; then rm -rf -- ${quoteRemoteArg(guestPath)}; fi`;
    const stillAssigned = () => assignedBotsFromCache(computerId).includes(botId);
    const cleanOnHost = async (): Promise<void> => {
      if (stillAssigned() || isVmLive(computerId)) return;
      const rootDir = path.join(dirs.computers, computerId, "Computer");
      const botsRoot = path.join(rootDir, "bots");
      const botDir = path.join(botsRoot, workspaceName);
      try {
        const rootInfo = await lstat(rootDir);
        const botsInfo = await lstat(botsRoot);
        const botInfo = await lstat(botDir);
        if (rootInfo.isSymbolicLink() || botsInfo.isSymbolicLink() || botInfo.isSymbolicLink()) return;
        const realBotsRoot = await realpath(botsRoot);
        const realBotDir = await realpath(botDir);
        if (!realBotDir.startsWith(`${realBotsRoot}${path.sep}`)) return;
        await rm(botDir, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          log("Removing Bot workspace folder did not finish.", error);
        }
      }
    };
    const entry = runtimes.get(computerId);
    if (entry?.stopping) {
      await entry.stopping.catch(() => undefined);
    }
    if (stillAssigned()) return;
    const current = runtimes.get(computerId);
    if (current?.start && !current.connection) {
      await current.start.promise.then(
        async () => {
          if (!stillAssigned()) await runGuestWorkspaceScript(computerId, guestCleanScript);
        },
        async () => {
          await cleanOnHost();
        },
      );
      return;
    }
    // Never run path-based recursive rm from the Mac host inside a live guest-writable
    // virtiofs mount (a guest symlink swap could escape into macOS /Users). While the VM
    // is running, remove the folder inside the Linux guest over SSH so any symlink resolves
    // strictly inside the guest VFS.
    if (isVmLive(computerId)) {
      await runGuestWorkspaceScript(computerId, guestCleanScript);
      return;
    }
    await cleanOnHost();
  }

  /**
   * Resolve and ensure the host shared directory mounted via `virtiofs` at
   * `/mnt/aiden-shared/Computer`.
   * - Legacy per-Bot VMs (`aiden-bot-*`) mount `<botHome>/Computer`.
   * - Shared (`shared`) and pool VMs (`vm-*`) mount `<root>/computers/<id>/Computer`.
   * Subdirectories under `bots/<dir>` are created from the host ONLY when the VM
   * is stopped (zero guest writers); while a VM is live, subdirectory creation runs
   * inside the Linux guest over SSH so a guest-planted symlink can never escape to
   * the macOS host filesystem.
   */
  async function sharedDirForVm(
    vm: BotComputerVmRecord,
    assignedBotIds: readonly string[],
    primaryBotId?: string,
    options?: { vmStopped?: boolean },
  ): Promise<string> {
    let dir: string;
    if (vm.kind === "dedicated" && vm.id.startsWith("aiden-bot-")) {
      const ownerBot =
        vm.legacyOwnerBotId ??
        assignedBotIds.find((id) => botComputerVmName(id) === vm.id) ??
        (primaryBotId && botComputerVmName(primaryBotId) === vm.id ? primaryBotId : undefined) ??
        primaryBotId ??
        assignedBotIds[0];
      dir = ownerBot ? await deps.botComputerDir(ownerBot) : path.join(dirs.computers, vm.id, "Computer");
    } else {
      dir = path.join(dirs.computers, vm.id, "Computer");
    }
    if (!path.isAbsolute(dir) || dir.includes(":")) {
      throw new BotComputerError("invalid", "The Bot's Computer folder path can't contain a colon.");
    }
    await assertNotSymlinkDir(dir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const botDirs = new Set(assignedBotIds);
    if (primaryBotId) botDirs.add(primaryBotId);
    const live = !options?.vmStopped && isVmLive(vm.id);
    if (live) {
      const dirsToCreate = [...botDirs]
        .map((botId) => botComputerWorkspaceDirName(botId))
        .filter((entry) => SAFE_BOT_WORKSPACE_DIR_PATTERN.test(entry) && !entry.includes(".."));
      if (dirsToCreate.length > 0 && runtimes.get(vm.id)?.state === "running") {
        const quoted = dirsToCreate.map((entry) => quoteRemoteArg(`${GUEST_SHARED_BOTS_MOUNT}/${entry}`)).join(" ");
        await runGuestWorkspaceScript(
          vm.id,
          `if [ ! -L ${quoteRemoteArg(GUEST_SHARED_BOTS_MOUNT)} ]; then mkdir -p -- ${quoted}; fi`,
        );
      }
      return dir;
    }
    const realDir = await realpath(dir);
    const botsRoot = path.join(dir, "bots");
    await assertNotSymlinkDir(botsRoot);
    await mkdir(botsRoot, { recursive: true, mode: 0o700 });
    const realBotsRoot = await realpath(botsRoot);
    if (!realBotsRoot.startsWith(`${realDir}${path.sep}`)) {
      throw new BotComputerError("invalid", "The Bot's Computer folder escaped its root directory.");
    }
    for (const botId of botDirs) {
      const botDir = path.join(botsRoot, botComputerWorkspaceDirName(botId));
      await assertNotSymlinkDir(botDir);
      await mkdir(botDir, { recursive: true, mode: 0o700 });
      const realBotDir = await realpath(botDir);
      if (!realBotDir.startsWith(`${realBotsRoot}${path.sep}`)) {
        throw new BotComputerError("invalid", "The Bot's workspace folder escaped its root directory.");
      }
    }
    return dir;
  }

  async function startVmRuntime(
    computerId: string,
    record: BotComputerVmRecord,
    entry: Runtime,
    options: { reason: BotComputerStartReason; signal: AbortSignal; onProgress?(text: string): void; botId?: string },
  ): Promise<BotComputerConnection> {
    const owner = options.botId ? await possessive(options.botId) : `${record.name}'s`;
    let leftRunning = false;
    let vmStarted = false;
    let vncTunnel: GuestVncTunnel | undefined;
    try {
      await acquireSlot(computerId, entry, options.signal, options.onProgress);
      emitVm(computerId);
      await requireResources(resources, {
        dir: root,
        diskBytes: START_DISK_BYTES,
        memoryBytes: occupied() <= 1 ? BOT_COMPUTER_LINUX_MIN_MEMORY_BYTES : BOT_COMPUTER_LINUX_MEMORY_BYTES,
        signal: options.signal,
      });
      options.onProgress?.(`Starting ${record.kind === "shared" ? record.name : `${owner} computer`}…`);
      const latestState = await readState();
      const assigned = assignedBotsInState(latestState, computerId);
      const sharedDir = await sharedDirForVm(record, assigned, options.botId, { vmStopped: true });
      const { info } = await runAndWait(
        record.vmName,
        sharedDir,
        owner,
        options.signal,
        true,
        () => {
          leftRunning = true;
        },
        undefined,
        true,
      );
      vmStarted = true;
      const sshTarget: GuestSshTarget = { host: info.ip, user: BOT_COMPUTER_GUEST_USER };
      const password = vncPassword();
      const startedVnc = await runSshCommand(
        sshTarget,
        linuxGuestVncStartScript(),
        { timeoutMs: 60_000, maxOutputBytes: 16 * 1024, signal: options.signal, stdin: `${password}\n` },
        {
          paths: sshPaths,
          env: guestSshEnvironment(deps.env ?? process.env, dirs.home),
          sshCommand: deps.sshCommand,
          run: deps.runProcess,
        },
      );
      if (startedVnc.exitCode !== 0 || startedVnc.timedOut) {
        throw new BotComputerError("start_failed", `${owner} computer's screen service didn't start.`);
      }
      vncTunnel = await openVncTunnel(sshTarget, BOT_COMPUTER_LINUX_VNC_SOCKET, { signal: options.signal });
      if (!isLoopbackHost(vncTunnel.host)) {
        throw new BotComputerError("vnc_not_loopback", `${owner} computer offered its screen beyond this Mac, so Aiden stopped it.`);
      }
      if (await exposed(vncTunnel.port)) {
        throw new BotComputerError("vnc_not_loopback", `${owner} computer's screen was reachable from the network, so Aiden stopped it.`);
      }
      const connection: BotComputerConnection = {
        vmName: record.vmName,
        ip: info.ip,
        vnc: { host: "127.0.0.1", port: vncTunnel.port, password },
        ssh: sshTarget,
      };
      entry.state = "running";
      entry.connection = connection;
      entry.vncTunnel = vncTunnel;
      entry.lastUsedAt = now();
      const state = await updateState((draft) => {
        const current = draft.vms[computerId];
        if (current) current.lastUsedAt = entry.lastUsedAt;
      });
      armIdle(computerId, entry, state.settings.idleStopMinutes);
      emitVm(computerId);
      return connection;
    } catch (error) {
      if (vncTunnel && entry.vncTunnel !== vncTunnel) {
        await vncTunnel.close().catch(() => undefined);
      }
      if (vmStarted && entry.state !== "running") {
        if (await stopFailedStart(record.vmName)) leftRunning = true;
      }
      if (entry.state !== "running") {
        entry.connection = undefined;
        entry.vncTunnel = undefined;
        if (leftRunning) {
          log("A Bot computer whose start failed did not stop; it is still running.");
          entry.state = "running";
          const minutes = await readState()
            .then((state) => state.settings.idleStopMinutes)
            .catch(() => undefined);
          if (minutes !== undefined && entry.state === "running") armIdle(computerId, entry, minutes);
        } else {
          entry.state = "stopped";
          wakeSlotWaiters();
        }
        emitVm(computerId);
      }
      throw error;
    }
  }

  async function stopVmRuntime(computerId: string, reason: BotComputerStopReason, botIdForLabel?: string): Promise<void> {
    const entry = runtimes.get(computerId);
    if (!entry) return;
    if (entry.start) {
      const start = entry.start;
      start.controller.abort();
      await start.promise.catch(() => undefined);
    }
    if (entry.stopping) return entry.stopping;
    if (entry.state !== "running") return;
    const connection = entry.connection;
    const tunnel = entry.vncTunnel;
    const vmName = connection?.vmName ?? (await readState()).vms[computerId]?.vmName;
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    entry.state = "stopping";
    entry.connection = undefined;
    emitVm(computerId);
    entry.stopping = (async () => {
      let stillRunning = false;
      try {
        if (vmName) await stopVm(vmName, reason === "quit" || connection === undefined);
      } catch (error) {
        stillRunning = vmName !== undefined && (await getVm(vmName).then((info) => info?.state === "running", () => true));
        if (error instanceof BotComputerError && error.code === "lume_failed") {
          const assigned = assignedBotsFromCache(computerId);
          const ownerBot = botIdForLabel ?? (assigned.length === 1 ? assigned[0] : undefined);
          const label = ownerBot ? `${await possessive(ownerBot)} computer` : "the computer";
          throw new BotComputerError("lume_failed", `Aiden couldn't stop ${label}.`);
        }
        throw error;
      } finally {
        entry.stopping = undefined;
        if (stillRunning) {
          log("A Bot computer did not stop; it is still running.");
          entry.state = "running";
          entry.connection = connection;
          entry.vncTunnel = tunnel;
          const minutes = await readState()
            .then((state) => state.settings.idleStopMinutes)
            .catch(() => undefined);
          if (minutes !== undefined && entry.state === "running") armIdle(computerId, entry, minutes);
        } else {
          entry.vncTunnel = undefined;
          await tunnel?.close().catch(() => undefined);
          entry.state = "stopped";
          for (const member of assignedBotsFromCache(computerId)) {
            activity.set(member, undefined);
          }
          if (control.controllerForScope(computerId) === "person" && control.takenOverByScope(computerId) !== "sign_in") {
            control.giveBackScope(computerId);
          }
          if (entry.lastUsedAt !== undefined) {
            const lastUsedAt = entry.lastUsedAt;
            await updateState((draft) => {
              const current = draft.vms[computerId];
              if (current) current.lastUsedAt = lastUsedAt;
            }).catch(() => undefined);
          }
          wakeSlotWaiters();
        }
        emitVm(computerId);
      }
    })();
    return entry.stopping;
  }

  /** Counts `copy` as reading the base until it settles. Call it with no await since the setup check. */
  function copyingBase<T>(copy: Promise<T>): Promise<T> {
    copies.add(copy);
    void copy.then(
      () => copies.delete(copy),
      () => copies.delete(copy),
    );
    return copy;
  }

  async function copiesSettled(): Promise<void> {
    while (copies.size > 0) await Promise.allSettled([...copies]);
  }

  /**
   * Per-Bot (`bot:<id>`) and per-VM (`vm:<id>`) lifecycle ops take turns in the
   * order asked for within an epoch. Remove everything (`undefined`) advances
   * the epoch, waits for every earlier op in the previous epoch, and blocks
   * every later top-level op until it finishes. Nested `bot:*` -> `vm:*` calls
   * pass their enclosing `parentEpoch` so they serialize with same-epoch VM
   * ops without ever waiting on a newer `removeEverything` barrier (avoiding
   * `bot:*` -> `undefined` -> `bot:*` deadlocks).
   */
  let turnEpoch = 0;
  let globalTurn: Promise<void> | undefined;
  const epochTurns = new Map<number, Map<string, Promise<void>>>();
  const botTurnKey = (botId: string) => `bot:${botId}`;
  const vmTurnKey = (computerId: string) => `vm:${computerId}`;

  function getEpochMap(epoch: number): Map<string, Promise<void>> {
    let map = epochTurns.get(epoch);
    if (!map) {
      map = new Map();
      epochTurns.set(epoch, map);
    }
    return map;
  }

  function hasActiveTurn(key: string | undefined): boolean {
    if (key === undefined) return globalTurn !== undefined;
    for (const map of epochTurns.values()) {
      if (map.has(key)) return true;
    }
    return false;
  }

  function activeTurnFor(key: string): Promise<void> | undefined {
    let latest: Promise<void> | undefined;
    for (const map of epochTurns.values()) {
      const hit = map.get(key);
      if (hit) latest = hit;
    }
    return latest;
  }

  function inTurn<T>(key: string | undefined, work: (epoch: number) => Promise<T>, parentEpoch?: number): Promise<T> {
    if (key === undefined) {
      const prevEpoch = turnEpoch;
      turnEpoch += 1;
      const myEpoch = turnEpoch;
      const prevMap = epochTurns.get(prevEpoch);
      const before: Array<Promise<void> | undefined> = [globalTurn, ...(prevMap ? prevMap.values() : [])];
      const result = Promise.all(before).then(() => work(myEpoch));
      const done = result.then(
        () => undefined,
        () => undefined,
      );
      globalTurn = done;
      void done.then(() => {
        if (globalTurn === done) globalTurn = undefined;
      });
      return result;
    }
    const myEpoch = parentEpoch ?? turnEpoch;
    const map = getEpochMap(myEpoch);
    const before: Array<Promise<void> | undefined> =
      parentEpoch !== undefined ? [map.get(key)] : [globalTurn, map.get(key)];
    const result = Promise.all(before).then(() => work(myEpoch));
    const done = result.then(
      () => undefined,
      () => undefined,
    );
    map.set(key, done);
    void done.then(() => {
      if (map.get(key) === done) {
        map.delete(key);
        if (map.size === 0) epochTurns.delete(myEpoch);
      }
    });
    return result;
  }

  /**
   * What a start of this computer waits for first: Remove everything, or a Give, Assign,
   * Reset or Delete of the Bot or its assigned VM.
   */
  const startsHeld = (botId: string, computerId?: string): Promise<void> | undefined =>
    globalTurn ??
    activeTurnFor(botTurnKey(botId)) ??
    (computerId ? activeTurnFor(vmTurnKey(computerId)) : undefined);

  const assignmentDrifted = (botId: string, computerId: string, entry: Runtime): boolean =>
    Boolean(startsHeld(botId, computerId)) ||
    assignmentCache.get(botId) !== computerId ||
    (runtimes.has(computerId) && runtimes.get(computerId) !== entry);

  function untilDone(
    gate: Promise<void>,
    signal?: AbortSignal,
    cancelMessage = "Starting the computer was cancelled.",
  ): Promise<void> {
    if (!signal) return gate;
    return new Promise<void>((resolve, reject) => {
      const cancel = () => reject(new BotComputerError("cancelled", cancelMessage));
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener("abort", cancel, { once: true });
      void gate.then(() => {
        signal.removeEventListener("abort", cancel);
        resolve();
      });
    });
  }

  function ensureSupported(): void {
    const support = deps.support();
    if (!support.ok) {
      throw new BotComputerError(
        "unsupported",
        support.reason === "host_os"
          ? "Bot computers need macOS 14 or later."
          : "Bot computers need a Mac with Apple silicon.",
      );
    }
  }

  function ready(state: BotComputersState): boolean {
    return (
      state.setup.baseBuild !== undefined &&
      (state.setup.guestOs === "linux" || isLinuxBuild(state.setup.baseBuild))
    );
  }

  function currentSetup(state: BotComputersState): BotComputerSetupState {
    const support = deps.support();
    if (!support.ok) return { kind: "unsupported", reason: support.reason };
    if (setupState) return setupState;
    if (ready(state) && state.setup.baseBuild) {
      return {
        kind: "ready",
        baseVersion: state.setup.baseVersion ?? image.version,
        baseBuild: state.setup.baseBuild,
        updateAvailable: state.setup.baseBuild !== image.build,
      };
    }
    return { kind: "not_set_up" };
  }

  function vmStatus(vm: BotComputerVmRecord, state: BotComputersState, diskUsedBytes?: number): BotComputerVmStatus {
    const entry = runtimes.get(vm.id);
    const assignedBotIds = assignedBotsInState(state, vm.id);
    const queuedBotIds = entry ? entry.waiters.map((waiter) => waiter.botId) : [];
    const activeBotId = entry?.activeBotId;
    const lastUsedAt = entry?.lastUsedAt ?? vm.lastUsedAt;
    const activeActivity =
      (activeBotId ? activity.get(activeBotId) : undefined) ??
      assignedBotIds.map((botId) => activity.get(botId)).find((text) => text !== undefined);
    const legacy = isLegacyMacosVmRecord(vm, state);
    return {
      id: vm.id,
      name: vm.name,
      kind: vm.kind,
      vmName: vm.vmName,
      state: stale.has(vm.id) ? "stale" : (entry?.state ?? "stopped"),
      baseBuild: vm.baseBuild,
      outdated: !legacy && ready(state) && vm.baseBuild !== state.setup.baseBuild,
      assignedBotIds,
      ...(activeBotId ? { activeBotId } : {}),
      queuedBotIds,
      ...(diskUsedBytes !== undefined ? { diskUsedBytes } : {}),
      ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
      controller: control.controllerForScope(vm.id),
      ...(activeActivity ? { activity: activeActivity } : {}),
    };
  }

  function computerStatus(botId: string, state: BotComputersState): BotComputerStatus | undefined {
    const computerId = assignedComputerId(state, botId);
    if (!computerId || !hasOwn(state.vms, computerId)) return undefined;
    const vm = state.vms[computerId];
    if (!vm) return undefined;
    const entry = runtimes.get(computerId);
    const assigned = assignedBotsInState(state, computerId);
    const shared = vm.kind === "shared" || assigned.length > 1;
    const queueIndex = entry ? entry.waiters.findIndex((waiter) => waiter.botId === botId) : -1;
    const queuePosition = queueIndex >= 0 ? queueIndex + 1 : undefined;
    const activeBotId = entry?.activeBotId;
    const lastUsedAt = entry?.lastUsedAt ?? vm.lastUsedAt;
    const text = activity.get(botId) ?? (activeBotId ? activity.get(activeBotId) : undefined);
    const legacy = isLegacyMacosVmRecord(vm, state);
    return {
      botId,
      vmName: vm.vmName,
      computerId: vm.id,
      computerName: vm.name,
      shared,
      state: stale.has(vm.id) ? "stale" : (entry?.state ?? "stopped"),
      baseBuild: vm.baseBuild,
      outdated: !legacy && ready(state) && vm.baseBuild !== state.setup.baseBuild,
      ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
      controller: control.controllerForScope(vm.id),
      ...(text ? { activity: text } : {}),
      ...(activeBotId ? { activeBotId } : {}),
      ...(queuePosition !== undefined ? { queuePosition } : {}),
    };
  }

  function createDedicatedVmId(existingVms: Record<string, BotComputerVmRecord>): string {
    for (;;) {
      const candidate = `vm-${randomBytes(6).toString("hex")}`;
      if (!hasOwn(existingVms, candidate)) return candidate;
    }
  }

  function nextDedicatedComputerName(state: BotComputersState, preferredBotName?: string): string {
    const existing = new Set(Object.values(state.vms).map((vm) => vm.name.toLowerCase()));
    if (preferredBotName && preferredBotName.trim().length > 0) {
      const base = `${preferredBotName.trim()}'s computer`.slice(0, 64);
      if (!existing.has(base.toLowerCase())) return base;
      for (let index = 2; index < 1000; index += 1) {
        const suffix = ` ${index}`;
        const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
        if (!existing.has(candidate.toLowerCase())) return candidate;
      }
    }
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = `Computer ${index}`;
      if (!existing.has(candidate.toLowerCase())) return candidate;
    }
    return `Computer ${now()}`;
  }

  async function cloneVmFromBase(
    spec: {
      id: string;
      name: string;
      kind: "shared" | "dedicated";
      vmName?: string;
      legacyOwnerBotId?: string;
      assignedBotIds?: readonly string[];
      primaryBotId?: string;
    },
    state: BotComputersState,
  ): Promise<BotComputerVmRecord> {
    const vmName = spec.vmName ?? botComputerPoolVmName(spec.id);
    const guestDriver = state.setup.guestDriver;
    const record: BotComputerVmRecord = {
      id: spec.id,
      name: spec.name,
      kind: spec.kind,
      vmName,
      baseBuild: state.setup.baseBuild ?? image.build,
      createdAt: now(),
      ...(spec.legacyOwnerBotId ? { legacyOwnerBotId: spec.legacyOwnerBotId } : {}),
      ...(guestDriver ? { guestDriver: { ...guestDriver } } : {}),
    };
    await sharedDirForVm(record, spec.assignedBotIds ?? [], spec.primaryBotId, { vmStopped: true });
    await deleteVm(vmName);
    await lumeOrThrow(
      { op: "clone", source: BOT_COMPUTER_BASE_VM, target: vmName },
      600_000,
      "Aiden couldn't make the computer from the base. Try again.",
    );
    return record;
  }

  /** Lazily clone the canonical `"shared"` Linux VM if needed and assign `forBotId` inside the `vm:shared` turn. */
  async function ensureSharedVmAndAssign(forBotId: string, parentEpoch?: number): Promise<BotComputersState> {
    return inTurn(
      vmTurnKey(BOT_COMPUTER_SHARED_ID),
      async () => {
        const state = await readState();
        const existing = hasOwn(state.vms, BOT_COMPUTER_SHARED_ID) ? state.vms[BOT_COMPUTER_SHARED_ID] : undefined;
        if (existing && !existing.migratedFromMacos) {
          await sharedDirForVm(existing, [...assignedBotsInState(state, BOT_COMPUTER_SHARED_ID), forBotId], forBotId);
          return updateState((draft) => {
            draft.assignments[forBotId] = BOT_COMPUTER_SHARED_ID;
          });
        }
        if (!ready(state)) throw new BotComputerError("not_set_up", "Set up Bot computers in Settings first.");
        if (setupTask) throw new BotComputerError("busy", "Wait for the base computer to finish updating.");
        const record = await copyingBase(
          cloneVmFromBase(
            {
              id: BOT_COMPUTER_SHARED_ID,
              name: existing?.name ?? BOT_COMPUTER_SHARED_DEFAULT_NAME,
              kind: "shared",
              vmName: BOT_COMPUTER_SHARED_VM,
              assignedBotIds: [...assignedBotsInState(state, BOT_COMPUTER_SHARED_ID), forBotId],
              primaryBotId: forBotId,
            },
            state,
          ),
        );
        const next = await updateState((draft) => {
          draft.vms[BOT_COMPUTER_SHARED_ID] = record;
          draft.assignments[forBotId] = BOT_COMPUTER_SHARED_ID;
        });
        stale.delete(BOT_COMPUTER_SHARED_ID);
        return next;
      },
      parentEpoch,
    );
  }

  function makeLeaseRelease(
    computerId: string,
    entry: Runtime,
    botId: string,
    leaseEpoch: number,
    signal?: AbortSignal,
  ): BotComputerLeaseRelease {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (entry.leaseEpoch !== leaseEpoch || entry.activeBotId !== botId) return;
      entry.activeCount = Math.max(0, entry.activeCount - 1);
      if (entry.activeCount > 0) return;
      const next = entry.waiters.shift();
      if (next) {
        next.cleanup();
        entry.activeBotId = next.botId;
        entry.activeCount = 1;
        entry.activeLeaseAbort = new AbortController();
        emitVm(computerId);
        next.resolve(makeLeaseRelease(computerId, entry, next.botId, entry.leaseEpoch, entry.activeLeaseAbort.signal));
      } else {
        entry.activeBotId = undefined;
        entry.activeCount = 0;
        entry.activeLeaseAbort = undefined;
        emitVm(computerId);
        host.touch(botId);
      }
    };
    return Object.assign(release, signal ? { signal } : {});
  }

  /** A clean guest shutdown, so the disk every clone copies is consistent. */
  async function shutDownBase(vmName: string, signal?: AbortSignal): Promise<void> {
    const result = await lume({ op: "stop", name: vmName, timeoutSeconds: 120 }, 180_000, signal);
    if (result.exitCode !== 0) throw new BotComputerError("start_failed", "The base computer didn't shut down.");
  }

  const setupCancelled = () => new BotComputerError("cancelled", "Setting up Bot computers was cancelled.");

  function guestSshTo(target: GuestSshTarget, signal: AbortSignal) {
    return (command: string, options: { stdin?: string; stdinFile?: string; timeoutMs: number }): Promise<BotComputerGuestCommandResult> =>
      runSshCommand(
        target,
        command,
        { timeoutMs: options.timeoutMs, maxOutputBytes: 64 * 1024, signal, stdin: options.stdin, stdinFile: options.stdinFile },
        { paths: sshPaths, env: guestSshEnvironment(deps.env ?? process.env, dirs.home), sshCommand: deps.sshCommand, run: deps.runProcess },
      );
  }

  /** One guest driver session to a running VM, and the way to close it. */
  async function openGuestDriver(
    target: GuestSshTarget,
    location: GuestDriverLocation,
    signal: AbortSignal,
  ): Promise<{ session: CuaDriverSessionLike; close(): Promise<void> }> {
    const factory = guestHostFor(async () =>
      guestDriverSshBridge(target, location, {
        paths: sshPaths,
        env: guestSshEnvironment(deps.env ?? process.env, dirs.home),
        sshCommand: deps.sshCommand,
      }),
    );
    const driverHost = await factory(signal);
    try {
      return { session: await driverHost.createSession(signal), close: () => driverHost.shutdown() };
    } catch (error) {
      await driverHost.shutdown().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Install and probe Aiden's pinned Linux arm64 `cua-driver` inside the base VM.
   * Never fails the base: if the binary isn't available or the probe fails, the
   * base still finishes on the VNC lane.
   */
  async function installAndProbeLinuxGuestDriver(
    ip: string,
    signal: AbortSignal,
  ): Promise<BotComputerGuestDriverRecord | undefined> {
    if (!deps.guestDriverExecutable) return undefined;
    setupState = { kind: "building_base", step: "guest_driver" };
    emit();
    const target: GuestSshTarget = { host: ip, user: BOT_COMPUTER_GUEST_USER };
    let openDriver: { session: CuaDriverSessionLike; close(): Promise<void> } | undefined;
    try {
      const driverPath = await deps.guestDriverExecutable(signal);
      const noticePath = deps.guestDriverNotice?.();
      const location = await installGuestDriver({
        guestSsh: guestSshTo(target, signal),
        driverPath,
        ...(noticePath === undefined ? {} : { noticePath }),
        pin: LINUX_GUEST_DRIVER_PIN,
        signal,
      });
      openDriver = await openGuestDriver(target, location, signal);
      const probe = await probeGuestDriver(openDriver.session, signal);
      if (!probe.ready) {
        log(`The Linux guest driver probe did not pass (${probe.reason}).`);
        return undefined;
      }
      return { version: CUA_DRIVER_VERSION, home: location.home, uid: location.uid };
    } catch (error) {
      if (signal.aborted) throw setupCancelled();
      log("Installing the Linux guest driver did not finish; Bot computers act on the screen only.", error);
      return undefined;
    } finally {
      await openDriver?.close().catch(() => undefined);
    }
  }

  async function performSetup(mode: "setup" | "update", signal: AbortSignal): Promise<void> {
    const target = mode === "setup" ? BOT_COMPUTER_BASE_VM : BOT_COMPUTER_STAGING_BASE_VM;
    // An update swaps the base at the end: a copy of the old one finishes first.
    await copiesSettled();
    // The bundled Lume is checked before downloading the Debian image.
    await invocation();
    // Booting the base needs a running computer's memory. Say so before downloading;
    // with Bot computers running, their memory is not free yet (an idle one may stop
    // for the base), so only the check before the install applies.
    if (occupied() === 0) {
      await requireResources(resources, { dir: root, memoryBytes: BOT_COMPUTER_LINUX_MIN_MEMORY_BYTES, signal });
    }
    setupState = { kind: "downloading", receivedBytes: await downloader.partialBytes(), totalBytes: image.bytes };
    emit();
    const downloadedImage = await downloader.download({
      onProgress: (progress) => {
        setupState =
          progress.phase === "verifying"
            ? { kind: "verifying" }
            : { kind: "downloading", receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes };
        emit();
      },
    });
    if (signal.aborted) throw setupCancelled();
    await updateState((draft) => {
      draft.setup.ipswPath = downloadedImage;
    });
    await acquireBaseSlot(signal);
    let guestDriver: BotComputerGuestDriverRecord | undefined;
    try {
      await requireResources(resources, { dir: root, memoryBytes: BOT_COMPUTER_LINUX_MIN_MEMORY_BYTES, signal });
      guestDriver = await buildAndInstallLinuxBase(mode, target, downloadedImage, signal);
    } finally {
      releaseBaseSlot();
    }
    await updateState((draft) => {
      draft.setup = {
        guestOs: "linux",
        baseBuild: image.build,
        baseVersion: image.version,
        ...(guestDriver ? { guestDriver } : {}),
      };
      if (draft.macosMigration?.completedAt !== undefined) {
        draft.macosMigration.noticeDismissed = true;
      } else if (draft.macosMigration === undefined) {
        draft.macosMigration = {
          completedAt: now(),
          freedBytes: 0,
          noticeDismissed: true,
        };
      }
    });
    setupState = undefined;
    deps.onSetupReady?.();
  }

  /** Install Debian Linux into `target`, provision it via cloud-init + SSH, and (for an update) swap it in as the base. */
  async function buildAndInstallLinuxBase(
    mode: "setup" | "update",
    target: string,
    downloadedImage: string,
    signal: AbortSignal,
  ): Promise<BotComputerGuestDriverRecord | undefined> {
    setupState = { kind: "building_base", step: "create" };
    emit();
    const sshEnv = guestSshEnvironment(deps.env ?? process.env, dirs.home);
    await mkdir(dirs.home, { recursive: true, mode: 0o700 });
    const publicKey = await ensureKeyPair(sshPaths, {
      env: sshEnv,
      run: deps.runProcess,
      keygenCommand: deps.keygenCommand,
      signal,
    });
    await mkdir(dirs.baseShared, { recursive: true, mode: 0o700 });
    const stored = await deps.secrets.get(BOT_COMPUTER_GUEST_PASSWORD_SECRET);
    const guestPassword = stored !== null && /^[A-Za-z0-9]{16,128}$/u.test(stored) ? stored : generateGuestPassword();
    await deps.secrets.set(BOT_COMPUTER_GUEST_PASSWORD_SECRET, guestPassword);
    const seedIsoPath = path.join(dirs.images, `${target}-cidata.iso`);
    const targetDiskPath = path.join(dirs.vms, target, "disk.img");
    let guestDriverRecord: BotComputerGuestDriverRecord | undefined;

    await buildLinuxBaseVm({
      signal,
      deleteVm: () => deleteVm(target),
      create: async () => {
        const result = await lume(
          {
            op: "create",
            os: "linux",
            name: target,
            cpu: BOT_COMPUTER_LINUX_CPU_COUNT,
            memoryGb: BOT_COMPUTER_LINUX_MEMORY_GB,
            diskSizeGb: BOT_COMPUTER_LINUX_DISK_GB,
            display: BOT_COMPUTER_LINUX_DISPLAY,
          },
          120_000,
          signal,
        );
        if (result.exitCode !== 0) {
          log(`lume create (linux) failed: ${result.stderr.slice(-600)}`);
          const kind = failureKind(result);
          if (kind === "vm_limit" || kind === "low_disk") throw startFailure(kind, "The base");
          throw new BotComputerError("lume_failed", "Creating the Linux base computer failed. Choose Set up to try again.");
        }
        await prepareLinuxBaseDisk({
          sourceImagePath: downloadedImage,
          targetDiskPath,
          targetBytes: BOT_COMPUTER_LINUX_DISK_BYTES,
        });
        await writeCloudInitSeedIso(seedIsoPath, {
          instanceId: target,
          hostname: target,
          sshAuthorizedKey: publicKey,
          password: guestPassword,
          packages: BOT_COMPUTER_LINUX_DESKTOP_PACKAGES,
        });
      },
      start: async () => {
        const { info } = await runAndWait(target, dirs.baseShared, "The base", signal, true, undefined, seedIsoPath, true);
        return { ip: info.ip };
      },
      provisionContext: (ip): LinuxProvisionContext => ({
        signal,
        publicKey,
        password: guestPassword,
        scanHostKey: () =>
          scanGuestHostKey(ip, {
            env: sshEnv,
            run: deps.runProcess,
            keyscanCommand: deps.keyscanCommand,
            signal,
          }),
        writeKnownHost: (line) => writeKnownHost(sshPaths, line),
        guestSsh: (command, options) =>
          runSshCommand(
            { host: ip, user: BOT_COMPUTER_GUEST_USER },
            command,
            { timeoutMs: options.timeoutMs, maxOutputBytes: 64 * 1024, signal, stdin: options.stdin },
            { paths: sshPaths, env: sshEnv, sshCommand: deps.sshCommand, run: deps.runProcess },
          ),
        guestDriver: {
          install: async () => {
            guestDriverRecord = await installAndProbeLinuxGuestDriver(ip, signal);
          },
        },
        stopBase: () => shutDownBase(target, signal),
      }),
      stop: async () => {
        await stopVm(target, true);
      },
      removeSeedIso: async () => {
        await rm(seedIsoPath, { force: true });
      },
      removeImage: async () => {
        await downloader.remove();
      },
      onStep: (step, detail) => {
        if (detail === "guest_driver") return;
        setupState = { kind: "building_base", step };
        emit();
      },
    });
    if (mode === "update") {
      await deleteVm(BOT_COMPUTER_BASE_VM);
      await lumeOrThrow(
        { op: "clone", source: BOT_COMPUTER_STAGING_BASE_VM, target: BOT_COMPUTER_BASE_VM },
        600_000,
        "Aiden couldn't swap in the new base.",
      );
      await deleteVm(BOT_COMPUTER_STAGING_BASE_VM);
    }
    return guestDriverRecord;
  }

  function startSetup(mode: "setup" | "update"): Promise<void> {
    if (setupTask) return setupTask;
    ensureSupported();
    if (shuttingDown) return Promise.reject(new BotComputerError("busy", "Aiden is quitting."));
    const controller = new AbortController();
    setupAbort = controller;
    const task = (async () => {
      try {
        await performSetup(mode, controller.signal);
        if (mode === "setup") {
          // In the background: a failed read must not turn a finished setup into a failure.
          void readState().then(
            ({ setup }) => reportAnalyticsEvent("bot_computer_set_up", { element_control: guestDriverReady(setup.guestDriver) }),
            () => undefined,
          );
        }
      } catch (error) {
        const resumable = (await downloader.partialBytes()) > 0 || existsSync(downloader.paths().final);
        const cancelled = error instanceof BotComputerError && error.code === "cancelled";
        const state = await readState();
        if (cancelled && (ready(state) || !resumable)) setupState = undefined;
        else {
          setupState = {
            kind: "failed",
            message: cancelled ? "Set up was cancelled. Choose Set up to continue where it stopped." : errorMessage(error),
            resumable,
          };
        }
        if (!cancelled) log("Bot computer setup failed.", error);
        if (!cancelled) throw error;
      } finally {
        setupTask = undefined;
        setupAbort = undefined;
        emit();
      }
    })();
    setupTask = task;
    return task;
  }

  async function diskUsage(state: BotComputersState): Promise<{ totalBytes: number; vmBytes: Map<string, number> }> {
    if (diskCache && now() - diskCache.at < 30_000) {
      return { totalBytes: diskCache.bytes, vmBytes: diskCache.vmBytes };
    }
    const totalBytes = existsSync(root) ? await allocatedBytes(root) : 0;
    const vmBytes = new Map<string, number>();
    for (const vm of Object.values(state.vms)) {
      const vmDir = path.join(dirs.vms, vm.vmName);
      if (existsSync(vmDir)) {
        const bytes = await allocatedBytes(vmDir).catch(() => 0);
        vmBytes.set(vm.id, bytes);
      }
    }
    diskCache = { at: now(), bytes: totalBytes, vmBytes };
    return { totalBytes, vmBytes };
  }

  async function resetComputerInner(
    computerId: string,
    options?: { force?: boolean },
    parentEpoch?: number,
  ): Promise<BotComputerVmStatus> {
    ensureSupported();
    const id = parseBotComputerId(computerId);
    const force = options?.force === true;
    return inTurn(
      vmTurnKey(id),
      async () => {
        const state = await readState();
        const vm = hasOwn(state.vms, id) ? state.vms[id] : undefined;
        if (!vm) throw new BotComputerError("no_computer", "That computer doesn't exist.");
        if (!ready(state)) throw new BotComputerError("not_set_up", "Set up Bot computers in Settings first.");
        if (setupTask) throw new BotComputerError("busy", "Wait for the base computer to finish updating.");
        if (runtimes.get(id)?.activeBotId !== undefined && !force) {
          throw new BotComputerError("busy", `${vm.name} is currently in use. Wait for the Bot to finish before resetting it.`);
        }
        const assigned = assignedBotsInState(state, id);
        const fresh = await copyingBase(
          (async () => {
            clearQueue(id, `${vm.name} is being reset.`, { forceActive: force });
            if (force) control.forgetScope(id);
            await stopVmRuntime(id, "person");
            await deleteVm(vm.vmName);
            return cloneVmFromBase(
              {
                id: vm.id,
                name: vm.name,
                kind: vm.kind,
                vmName: vm.vmName,
                ...(vm.legacyOwnerBotId ? { legacyOwnerBotId: vm.legacyOwnerBotId } : {}),
                assignedBotIds: assigned,
                primaryBotId: assigned[0],
              },
              state,
            );
          })(),
        );
        const next = await updateState((draft) => {
          if (hasOwn(draft.vms, id)) draft.vms[id] = fresh;
        });
        stale.delete(id);
        emitVm(id);
        return vmStatus(fresh, next);
      },
      parentEpoch,
    );
  }

  const host: BotComputerHost & { readonly control: BotComputerControlRegistry; readonly activity: BotComputerActivity } = {
    control,
    activity,

    async status(): Promise<BotComputersStatus> {
      const state = await readState();
      const freeDiskBytes = await resources.freeDiskBytes(root).catch(() => undefined);
      const maxRunningLimit = await currentMaxRunningLimit();
      const { totalBytes, vmBytes } = await diskUsage(state);
      const migrationNotice =
        state.macosMigration?.completedAt !== undefined && !state.macosMigration.noticeDismissed
          ? { freedBytes: state.macosMigration.freedBytes }
          : undefined;
      const sortedVms = Object.values(state.vms).sort((left, right) => {
        if (left.id === BOT_COMPUTER_SHARED_ID) return -1;
        if (right.id === BOT_COMPUTER_SHARED_ID) return 1;
        return left.createdAt - right.createdAt;
      });
      const computers: BotComputerStatus[] = [];
      for (const botId of Object.keys(state.assignments)) {
        const status = computerStatus(botId, state);
        if (status) computers.push(status);
      }
      return {
        setup: currentSetup(state),
        settings: { ...state.settings },
        diskUsedBytes: totalBytes,
        ...(freeDiskBytes !== undefined ? { freeDiskBytes } : {}),
        vms: sortedVms.map((vm) => vmStatus(vm, state, vmBytes.get(vm.id))),
        computers,
        requirements: {
          downloadBytes: image.bytes,
          baseDiskBytes: BOT_COMPUTER_LINUX_BASE_SIZE_BYTES,
          setupFreeBytes: image.bytes + BOT_COMPUTER_LINUX_BASE_DISK_RESERVE_BYTES,
          memoryPerComputerBytes: BOT_COMPUTER_LINUX_MEMORY_BYTES,
          baseVersion: image.version,
          maxRunningLimit,
        },
        ...(migrationNotice ? { migrationNotice } : {}),
      };
    },

    async baseReady() {
      return deps.support().ok && ready(await readState());
    },

    async computer(botId) {
      const state = await readState();
      return computerStatus(botId, state);
    },

    async setUp() {
      // With a working base, Set up (which is also Settings' "Try again" after a
      // failed update) retries the update beside it. It never rebuilds, in place,
      // the base the Bots' computers came from.
      if (!setupTask && ready(await readState())) return host.updateBase();
      return startSetup("setup");
    },

    cancelSetUp() {
      setupAbort?.abort();
      downloader.cancel();
    },

    async updateBase() {
      const state = await readState();
      if (!ready(state)) return startSetup("setup");
      if (state.setup.baseBuild === image.build) return;
      return startSetup("update");
    },

    removeEverything: () =>
      // Every Give, Assign, Reset and Delete asked for first finishes, and no start may begin while
      // the files go; a call that waited finds no computer afterwards.
      inTurn(undefined, async () => {
        host.cancelSetUp();
        await setupTask?.catch(() => undefined);
        const stateBeforeClear = await readState().catch(() => undefined);
        const ids = [...runtimes.keys()];
        const allVmIds = new Set([...ids, ...(stateBeforeClear ? Object.keys(stateBeforeClear.vms) : [])]);
        for (const id of ids) clearQueue(id, "Bot computers were removed.", { forceActive: true });
        await Promise.all(ids.map((computerId) => stopVmRuntime(computerId, "quit").catch(() => undefined)));
        if (existsSync(dirs.vms)) {
          try {
            const listed = await lume({ op: "list" }, 30_000);
            if (listed.exitCode === 0) {
              for (const info of parseLumeVmList(listed.stdout)) {
                if (isAidenVmName(info.name) || info.name === BOT_COMPUTER_STAGING_BASE_VM) {
                  await deleteVm(info.name).catch((error: unknown) => log("Deleting a VM did not finish.", error));
                }
              }
            }
          } catch (error) {
            log("Listing VMs before removal did not finish.", error);
          }
        }
        await downloader.remove();
        for (const dir of Object.values(dirs)) await rm(dir, { recursive: true, force: true });
        for (const file of [sshPaths.privateKey, sshPaths.publicKey, sshPaths.knownHosts]) await rm(file, { force: true });
        await deps.secrets.deleteFamily(BOT_COMPUTER_SECRET_FAMILY);
        const previousBots = [...assignmentCache.keys()];
        // Clear control/scopes BEFORE clearing assignmentCache so resolveScope sees every Bot's old scope.
        for (const computerId of allVmIds) control.forgetScope(computerId);
        for (const botId of previousBots) {
          control.forget(botId);
          activity.set(botId, undefined);
        }
        await store.clear();
        assignmentCache.clear();
        runtimes.clear();
        stale.clear();
        setupState = undefined;
        emit();
        deps.onRemoved?.();
      }),

    async updateSettings(patch) {
      const parsed = parseBotComputersSettingsPatch(patch, await currentMaxRunningLimit());
      const state = await updateState((draft) => {
        Object.assign(draft.settings, parsed);
      });
      if (parsed.idleStopMinutes !== undefined) {
        for (const [computerId, entry] of runtimes) {
          if (entry.state === "running") armIdle(computerId, entry, state.settings.idleStopMinutes);
        }
      }
      wakeSlotWaiters();
      emit();
      return { ...state.settings } satisfies BotComputersSettings;
    },

    async give(botId) {
      ensureSupported();
      return inTurn(botTurnKey(botId), async (epoch) => {
        const state = await readState();
        const existing = computerStatus(botId, state);
        if (existing) return existing;
        if (!ready(state)) throw new BotComputerError("not_set_up", "Set up Bot computers in Settings first.");
        if (setupTask) throw new BotComputerError("busy", "Wait for the base computer to finish updating.");
        if (state.settings.defaultComputerMode === "shared") {
          const next = await ensureSharedVmAndAssign(botId, epoch);
          emit();
          return computerStatus(botId, next)!;
        }
        const legacyId = botComputerVmName(botId);
        const id = hasOwn(state.vms, legacyId) ? createDedicatedVmId(state.vms) : legacyId;
        const vmName = id === legacyId ? legacyId : botComputerPoolVmName(id);
        const label = nextDedicatedComputerName(state, await deps.botName?.(botId));
        const record = await copyingBase(
          cloneVmFromBase(
            {
              id,
              name: label,
              kind: "dedicated",
              vmName,
              ...(id === legacyId ? { legacyOwnerBotId: botId } : {}),
              assignedBotIds: [botId],
              primaryBotId: botId,
            },
            state,
          ),
        );
        const next = await updateState((draft) => {
          draft.vms[id] = record;
          draft.assignments[botId] = id;
        });
        stale.delete(id);
        emit(botId);
        return computerStatus(botId, next)!;
      });
    },

    async assignComputer(botId, target) {
      ensureSupported();
      const parsed = parseBotComputerAssignTarget(target);
      return inTurn(botTurnKey(botId), async (epoch) => {
        const state = await readState();
        const oldComputerId = assignedComputerId(state, botId);
        if (parsed.kind === "shared") {
          if (oldComputerId === BOT_COMPUTER_SHARED_ID && hasOwn(state.vms, BOT_COMPUTER_SHARED_ID)) {
            return computerStatus(botId, state)!;
          }
          if (!ready(state)) throw new BotComputerError("not_set_up", "Set up Bot computers in Settings first.");
          if (setupTask) throw new BotComputerError("busy", "Wait for the base computer to finish updating.");
          if (oldComputerId) {
            revokeBotLease(oldComputerId, botId);
            control.forget(botId);
          }
          const next = await ensureSharedVmAndAssign(botId, epoch);
          if (oldComputerId && oldComputerId !== BOT_COMPUTER_SHARED_ID) {
            releaseOrphanedControlScope(oldComputerId, next);
          }
          emit();
          return computerStatus(botId, next)!;
        }
        if (parsed.kind === "existing") {
          const targetId = parsed.computerId;
          const next = await inTurn(
            vmTurnKey(targetId),
            async () => {
              const latest = await readState();
              const targetVm = hasOwn(latest.vms, targetId) ? latest.vms[targetId] : undefined;
              if (!targetVm) throw new BotComputerError("no_computer", "That computer doesn't exist.");
              const currentOldId = assignedComputerId(latest, botId);
              if (currentOldId === targetVm.id) return latest;
              if (currentOldId) {
                revokeBotLease(currentOldId, botId);
                control.forget(botId);
              }
              await sharedDirForVm(targetVm, [...assignedBotsInState(latest, targetVm.id), botId], botId);
              const updated = await updateState((draft) => {
                draft.assignments[botId] = targetVm.id;
              });
              if (currentOldId) releaseOrphanedControlScope(currentOldId, updated);
              return updated;
            },
            epoch,
          );
          emit();
          return computerStatus(botId, next)!;
        }
        // parsed.kind === "new"
        if (!ready(state)) throw new BotComputerError("not_set_up", "Set up Bot computers in Settings first.");
        if (setupTask) throw new BotComputerError("busy", "Wait for the base computer to finish updating.");
        if (oldComputerId) {
          revokeBotLease(oldComputerId, botId);
          control.forget(botId);
        }
        const id = createDedicatedVmId(state.vms);
        const label = parsed.name ?? nextDedicatedComputerName(state, await deps.botName?.(botId));
        const record = await copyingBase(
          cloneVmFromBase({ id, name: label, kind: "dedicated", assignedBotIds: [botId], primaryBotId: botId }, state),
        );
        const next = await updateState((draft) => {
          draft.vms[id] = record;
          draft.assignments[botId] = id;
        });
        if (oldComputerId) releaseOrphanedControlScope(oldComputerId, next);
        stale.delete(id);
        emit();
        return computerStatus(botId, next)!;
      });
    },

    async createComputer(computerName) {
      ensureSupported();
      const parsedName = computerName === undefined ? undefined : parseBotComputerName(computerName);
      const initial = await readState();
      const id = createDedicatedVmId(initial.vms);
      return inTurn(vmTurnKey(id), async () => {
        const state = await readState();
        if (!ready(state)) throw new BotComputerError("not_set_up", "Set up Bot computers in Settings first.");
        if (setupTask) throw new BotComputerError("busy", "Wait for the base computer to finish updating.");
        const label = parsedName ?? nextDedicatedComputerName(state);
        const record = await copyingBase(cloneVmFromBase({ id, name: label, kind: "dedicated" }, state));
        const next = await updateState((draft) => {
          draft.vms[id] = record;
        });
        stale.delete(id);
        emit();
        return vmStatus(record, next);
      });
    },

    async renameComputer(computerId, computerName) {
      const id = parseBotComputerId(computerId);
      const label = parseBotComputerName(computerName);
      return inTurn(vmTurnKey(id), async () => {
        const state = await readState();
        if (!hasOwn(state.vms, id)) throw new BotComputerError("no_computer", "That computer doesn't exist.");
        const next = await updateState((draft) => {
          if (hasOwn(draft.vms, id) && draft.vms[id]) draft.vms[id].name = label;
        });
        emit();
        return vmStatus(next.vms[id]!, next);
      });
    },

    async deleteComputer(computerId, options) {
      const id = parseBotComputerId(computerId);
      return inTurn(vmTurnKey(id), async () => {
        const state = await readState();
        const vm = hasOwn(state.vms, id) ? state.vms[id] : undefined;
        if (!vm) throw new BotComputerError("no_computer", "That computer doesn't exist.");
        const assigned = assignedBotsInState(state, id);
        if (assigned.length > 0 && !options?.force) {
          throw new BotComputerError(
            "busy",
            `${vm.name} is still assigned to ${assigned.length === 1 ? "1 Bot" : `${assigned.length} Bots`}. Reassign or confirm deletion first.`,
          );
        }
        if (runtimes.get(id)?.activeBotId !== undefined && !options?.force) {
          throw new BotComputerError(
            "busy",
            `${vm.name} is currently in use. Wait for the Bot to finish or confirm deletion.`,
          );
        }
        clearQueue(id, `${vm.name} was deleted.`, { forceActive: true });
        await stopVmRuntime(id, "person");
        await deleteVm(vm.vmName);
        await removeComputerWorkspace(id);
        await updateState((draft) => {
          delete draft.vms[id];
          for (const botId of Object.keys(draft.assignments)) {
            if (draft.assignments[botId] === id) delete draft.assignments[botId];
          }
        });
        runtimes.get(id)?.cancelIdle?.();
        runtimes.delete(id);
        stale.delete(id);
        control.forgetScope(id);
        for (const botId of assigned) activity.set(botId, undefined);
        emit();
      });
    },

    async resetComputer(computerId, options) {
      return resetComputerInner(computerId, options);
    },

    async reset(botId, options) {
      ensureSupported();
      return inTurn(botTurnKey(botId), async (epoch) => {
        // Read in its turn: a Delete or Remove everything asked for first has already finished.
        const state = await readState();
        const computerId = assignedComputerId(state, botId);
        if (!computerId || !hasOwn(state.vms, computerId)) {
          throw new BotComputerError("no_computer", `${await name(botId)} doesn't have a computer yet.`);
        }
        await resetComputerInner(computerId, options, epoch);
        const next = await readState();
        const status = computerStatus(botId, next);
        if (!status) throw new BotComputerError("no_computer", `${await name(botId)} doesn't have a computer yet.`);
        return status;
      });
    },

    deleteForBot: (botId) =>
      inTurn(botTurnKey(botId), async (epoch) => {
        const state = await readState();
        const computerId = assignedComputerId(state, botId);
        const initialVm = computerId && hasOwn(state.vms, computerId) ? state.vms[computerId] : undefined;
        if (!computerId || !initialVm) {
          // A clone that never reached the store can still exist, so the derived
          // name is tried too; that guess never holds up deleting a Bot that had
          // no computer, even when Lume can't run.
          await deleteVm(botComputerVmName(botId)).catch((error: unknown) =>
            log("Deleting a VM no record names did not finish.", error),
          );
          control.forget(botId);
          activity.set(botId, undefined);
          emit(botId);
          return;
        }
        await inTurn(
          vmTurnKey(computerId),
          async () => {
            const latest = await readState();
            const currentId = assignedComputerId(latest, botId);
            const vm = currentId && hasOwn(latest.vms, currentId) ? latest.vms[currentId] : undefined;
            if (!currentId || !vm) {
              control.forget(botId);
              return;
            }
            const otherAssigned = assignedBotsInState(latest, currentId).filter((id) => id !== botId);
            if (vm.kind === "dedicated" && otherAssigned.length === 0) {
              clearQueue(currentId, `${vm.name} was deleted.`, { forceActive: true });
              await stopVmRuntime(currentId, "quit", botId).catch((error: unknown) =>
                log("Stopping a deleted Bot's computer did not finish.", error),
              );
              await deleteVm(vm.vmName);
              await removeComputerWorkspace(currentId);
              await updateState((draft) => {
                delete draft.assignments[botId];
                delete draft.vms[currentId];
              });
              runtimes.get(currentId)?.cancelIdle?.();
              runtimes.delete(currentId);
              stale.delete(currentId);
              control.forgetScope(currentId);
            } else {
              // Shared computer or another Bot still uses this VM: unassign only.
              revokeBotLease(currentId, botId, "The Bot was removed from this computer.");
              control.forget(botId);
              const updated = await updateState((draft) => {
                delete draft.assignments[botId];
              });
              releaseOrphanedControlScope(currentId, updated);
              await removeBotWorkspaceSubfolder(currentId, botId);
            }
          },
          epoch,
        );
        activity.set(botId, undefined);
        emit();
      }),

    async acquireLease(botId, options) {
      const signal = options?.signal;
      for (
        let held = startsHeld(botId, assignmentCache.get(botId));
        held;
        held = startsHeld(botId, assignmentCache.get(botId))
      ) {
        await untilDone(held, signal, "Waiting for the computer was cancelled.");
      }
      if (shuttingDown) throw new BotComputerError("busy", "Aiden is quitting.");
      const state = await readState();
      const computerId = assignedComputerId(state, botId);
      const vm = computerId && hasOwn(state.vms, computerId) ? state.vms[computerId] : undefined;
      if (!computerId || !vm) {
        throw new BotComputerError("no_computer", `${await name(botId)} doesn't have a computer yet.`);
      }
      const heldForVm = startsHeld(botId, computerId);
      if (heldForVm) {
        await untilDone(heldForVm, signal, "Waiting for the computer was cancelled.");
        return host.acquireLease(botId, options);
      }
      const entry = runtime(computerId);
      if (entry.activeBotId === undefined) {
        entry.activeBotId = botId;
        entry.activeCount = 1;
        entry.activeLeaseAbort = new AbortController();
        emitVm(computerId);
        return makeLeaseRelease(computerId, entry, botId, entry.leaseEpoch, entry.activeLeaseAbort.signal);
      }
      if (entry.activeBotId === botId) {
        entry.activeCount += 1;
        return makeLeaseRelease(computerId, entry, botId, entry.leaseEpoch, entry.activeLeaseAbort?.signal);
      }
      if (signal?.aborted) {
        throw new BotComputerError("cancelled", "Waiting for the computer was cancelled.");
      }
      const activeLabel = await name(entry.activeBotId);
      if (signal?.aborted) {
        throw new BotComputerError("cancelled", "Waiting for the computer was cancelled.");
      }
      if (assignmentDrifted(botId, computerId, entry)) {
        return host.acquireLease(botId, options);
      }
      if (entry.activeBotId === undefined) {
        entry.activeBotId = botId;
        entry.activeCount = 1;
        entry.activeLeaseAbort = new AbortController();
        emitVm(computerId);
        return makeLeaseRelease(computerId, entry, botId, entry.leaseEpoch, entry.activeLeaseAbort.signal);
      }
      if (entry.activeBotId === botId) {
        entry.activeCount += 1;
        return makeLeaseRelease(computerId, entry, botId, entry.leaseEpoch, entry.activeLeaseAbort?.signal);
      }
      return new Promise<BotComputerLeaseRelease>((resolve, reject) => {
        const onAbort = () => {
          const index = entry.waiters.indexOf(waiter);
          if (index >= 0) {
            entry.waiters.splice(index, 1);
            emitVm(computerId);
          }
          waiter.cleanup();
          reject(new BotComputerError("cancelled", "Waiting for the computer was cancelled."));
        };
        const waiter: QueueWaiter = {
          botId,
          resolve,
          reject,
          cleanup: () => {
            signal?.removeEventListener("abort", onAbort);
          },
        };
        entry.waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
        const position = entry.waiters.length;
        options?.onProgress?.(
          position === 1
            ? `Waiting for ${activeLabel} to finish using ${vm.name}…`
            : `Waiting in queue (#${position}) for ${vm.name}…`,
        );
        emitVm(computerId);
      });
    },

    async ensureRunning(botId, options) {
      // Remove everything, or a Give, Assign, Reset or Delete of this Bot or VM, finishes first.
      for (let held = startsHeld(botId, assignmentCache.get(botId)); held; held = startsHeld(botId, assignmentCache.get(botId))) {
        await untilDone(held, options.signal);
      }
      if (shuttingDown) throw new BotComputerError("busy", "Aiden is quitting.");
      ensureSupported();
      const initialState = await readState();
      const computerId = assignedComputerId(initialState, botId);
      let vm = computerId && hasOwn(initialState.vms, computerId) ? initialState.vms[computerId] : undefined;
      if (!computerId || !vm) throw new BotComputerError("no_computer", `${await name(botId)} doesn't have a computer yet.`);
      for (let held = startsHeld(botId, computerId); held; held = startsHeld(botId, computerId)) {
        await untilDone(held, options.signal);
      }
      if (isLegacyMacosVmRecord(vm, initialState)) {
        if (!ready(initialState)) {
          throw new BotComputerError(
            "not_set_up",
            "Bot computers now run Linux. Set up Bot computers in Settings → Computers & VMs to continue.",
          );
        }
        if (setupTask) throw new BotComputerError("busy", "Wait for the base computer to finish updating.");
        // Automatically clone a fresh Linux VM from the newly set-up base so each migrated
        // Bot keeps its "has a computer" setting without manual Reset.
        vm = await inTurn(vmTurnKey(computerId), async () => {
          const latest = await readState();
          const current = hasOwn(latest.vms, computerId) ? latest.vms[computerId] : undefined;
          if (!current) throw new BotComputerError("no_computer", `${await name(botId)} doesn't have a computer yet.`);
          if (!isLegacyMacosVmRecord(current, latest)) return current;
          if (!ready(latest)) {
            throw new BotComputerError(
              "not_set_up",
              "Bot computers now run Linux. Set up Bot computers in Settings → Computers & VMs to continue.",
            );
          }
          const assigned = assignedBotsInState(latest, computerId);
          const cloned = await copyingBase(
            cloneVmFromBase(
              {
                id: current.id,
                name: current.name,
                kind: current.kind,
                vmName: current.vmName,
                ...(current.legacyOwnerBotId ? { legacyOwnerBotId: current.legacyOwnerBotId } : {}),
                assignedBotIds: assigned,
                primaryBotId: botId,
              },
              latest,
            ),
          );
          await updateState((draft) => {
            if (hasOwn(draft.vms, computerId)) draft.vms[computerId] = cloned;
          });
          stale.delete(computerId);
          emitVm(computerId);
          return cloned;
        });
      }
      if (stale.has(computerId)) {
        throw new BotComputerError("stale", `${await possessive(botId)} computer didn't finish being made. Reset it in the Bot's profile.`);
      }
      const entry = runtime(computerId);
      for (;;) {
        if (entry.stopping) await entry.stopping;
        if (assignmentDrifted(botId, computerId, entry) || stale.has(computerId)) {
          return host.ensureRunning(botId, options);
        }
        if (entry.state === "running" && entry.connection) {
          await sharedDirForVm(vm, assignedBotsInState(initialState, computerId), botId);
          if (assignmentDrifted(botId, computerId, entry) || stale.has(computerId)) {
            return host.ensureRunning(botId, options);
          }
          host.touch(botId);
          return entry.connection;
        }
        // Running with no connection: a failed start Lume couldn't turn off. It is turned off
        // first; a stop that fails again rejects, and the computer keeps its place.
        if (entry.state === "running") {
          await stopVmRuntime(computerId, "person", botId);
          continue;
        }
        // A start every earlier caller gave up on is ending; this caller starts afresh once it has.
        const ending = entry.start?.controller.signal.aborted ? entry.start : undefined;
        if (!ending) break;
        await ending.promise.catch(() => undefined);
      }
      // One of those began while this caller waited above: it starts whatever is there once that is done.
      if (assignmentDrifted(botId, computerId, entry) || stale.has(computerId)) {
        return host.ensureRunning(botId, options);
      }
      if (!entry.start) {
        const controller = new AbortController();
        const progress = new Set<(text: string) => void>();
        const start: SharedStart = {
          controller,
          progress,
          callers: 0,
          promise: startVmRuntime(computerId, vm, entry, {
            reason: options.reason,
            signal: controller.signal,
            botId,
            onProgress: (text) => {
              for (const listener of [...progress]) {
                try {
                  listener(text);
                } catch {
                  // Progress is advisory.
                }
              }
            },
          }).finally(() => {
            if (entry.start === start) entry.start = undefined;
          }),
        };
        entry.start = start;
      }
      return joinStart(entry.start, options);
    },

    async stop(botId, options) {
      const reason = options?.reason ?? "person";
      const state = await readState();
      const computerId = assignedComputerId(state, botId);
      if (!computerId) return;
      removeBotFromQueue(computerId, botId);
      if (reason === "pause") {
        const otherAssigned = assignedBotsInState(state, computerId).some((id) => id !== botId);
        if (otherAssigned) return;
      }
      return stopVmRuntime(computerId, reason, botId);
    },

    runningConnection(botId) {
      const computerId = assignmentCache.get(botId);
      if (!computerId) return undefined;
      const entry = runtimes.get(computerId);
      return entry?.state === "running" && entry.connection ? entry.connection : undefined;
    },

    touch(botId) {
      const computerId = assignmentCache.get(botId);
      if (!computerId) return;
      const entry = runtimes.get(computerId);
      if (!entry || entry.state !== "running") return;
      entry.lastUsedAt = now();
      void readState()
        .then((state) => {
          if (entry.state === "running") armIdle(computerId, entry, state.settings.idleStopMinutes);
        })
        .catch(() => undefined);
    },

    async runGuestCommand(botId, command, options) {
      const connection = await host.ensureRunning(botId, { reason: "tool", signal: options.signal });
      const computerId = assignmentCache.get(botId) ?? assignedComputerId(await readState(), botId);
      const entry = computerId ? runtime(computerId) : undefined;
      if (entry) entry.leases += 1;
      try {
        return await runSshCommand(
          connection.ssh,
          command,
          { timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, signal: options.signal },
          {
            paths: sshPaths,
            env: guestSshEnvironment(deps.env ?? process.env, dirs.home),
            sshCommand: deps.sshCommand,
            run: deps.runProcess,
          },
        );
      } finally {
        if (entry) entry.leases -= 1;
        host.touch(botId);
      }
    },

    async guestDriver(botId) {
      const state = await readState();
      const computerId = assignedComputerId(state, botId);
      const vm = computerId && hasOwn(state.vms, computerId) ? state.vms[computerId] : undefined;
      const legacy = vm ? isLegacyMacosVmRecord(vm, state) : false;
      const driver =
        (!legacy ? vm?.guestDriver : undefined) ?? (legacy && ready(state) ? state.setup.guestDriver : undefined);
      if (!driver || !guestDriverReady(driver)) return undefined;
      const location: GuestDriverLocation = { home: driver.home, uid: driver.uid };
      return guestHostFor(async () => {
        const connection = await host.ensureRunning(botId, { reason: "tool" });
        return guestDriverSshBridge(connection.ssh, location, {
          paths: sshPaths,
          env: guestSshEnvironment(deps.env ?? process.env, dirs.home),
          sshCommand: deps.sshCommand,
        });
      });
    },

    async dismissMigrationNotice() {
      const state = await readState();
      if (state.macosMigration?.completedAt === undefined || state.macosMigration.noticeDismissed) return;
      await updateState((draft) => {
        if (draft.macosMigration?.completedAt !== undefined) draft.macosMigration.noticeDismissed = true;
      });
      emit();
    },

    async reconcile() {
      if (!deps.support().ok || !existsSync(root)) return;
      let state = await readState();
      const hasVmsDir = existsSync(dirs.vms);
      let vms: LumeVmInfo[] = [];
      let lumeListed = false;
      if (hasVmsDir) {
        const listed = await lume({ op: "list" }, 30_000);
        if (listed.exitCode !== 0) {
          log(`lume ls failed: ${listed.stderr.slice(-600)}`);
        } else {
          vms = parseLumeVmList(listed.stdout);
          lumeListed = true;
        }
      }
      const byName = new Map(vms.map((info) => [info.name, info]));

      // One-time first-launch migration from legacy macOS Bot computers to Linux:
      // stop & delete Aiden's own macOS VMs and any Apple .ipsw files, clear the
      // old guest password, reset setup to "not set up", keep every Bot's
      // "has a computer" setting, add a one-line note to each Bot's memory, and
      // persist the Settings notice with freed space. Never touches non-Aiden VMs.
      if (!state.macosMigration?.completedAt) {
        // Do not mark migration complete if dirs.vms exists and Lume could not
        // list VMs; retry cleanly on the next reconcile().
        if (hasVmsDir && !lumeListed) {
          emit();
          return;
        }
        const legacyIpswPaths: string[] = [];
        if (existsSync(dirs.images)) {
          const entries = await readdir(dirs.images).catch(() => []);
          for (const entry of entries) {
            if (/\.ipsw(\.part)?$/iu.test(entry)) legacyIpswPaths.push(path.join(dirs.images, entry));
          }
        }
        const macosVms = vms.filter(
          (info) =>
            (isAidenVmName(info.name) || info.name === BOT_COMPUTER_STAGING_BASE_VM) &&
            (info.os === "macOS" ||
              (info.os === undefined &&
                state.setup.guestOs !== "linux" &&
                state.setup.baseBuild !== undefined &&
                !/^\d{8}-\d+$/u.test(state.setup.baseBuild))),
        );
        const hasLegacyState =
          state.setup.guestOs !== "linux" &&
          ((state.setup.ipswPath !== undefined && /\.ipsw$/iu.test(state.setup.ipswPath)) ||
            (state.setup.baseBuild !== undefined && !/^\d{8}-\d+$/u.test(state.setup.baseBuild)));
        const hasPendingMigration =
          state.macosMigration !== undefined && state.macosMigration.completedAt === undefined;
        if (macosVms.length > 0 || legacyIpswPaths.length > 0 || hasLegacyState || hasPendingMigration) {
          await inTurn(undefined, async () => {
            let freedThisPass = 0;
            let allRemoved = true;
            for (const info of macosVms) {
              if ((await vmsInUse()).has(info.name)) {
                allRemoved = false;
                continue;
              }
              const vmDir = path.join(dirs.vms, info.name);
              const dirBytes = existsSync(vmDir) ? await allocatedBytes(vmDir).catch(() => 0) : 0;
              const vmBytes = dirBytes > 0 ? dirBytes : (info.diskAllocatedBytes ?? 0);
              if (info.state === "running") {
                await stopVm(info.name, true).catch((error: unknown) =>
                  log("Stopping a legacy macOS Bot computer did not finish.", error),
                );
              }
              try {
                await deleteVm(info.name);
                freedThisPass += vmBytes;
                byName.delete(info.name);
              } catch (error: unknown) {
                allRemoved = false;
                log("Deleting a legacy macOS Bot computer did not finish.", error);
              }
            }
            for (const file of legacyIpswPaths) {
              const alloc = await allocatedBytes(file).catch(() => 0);
              const size = alloc > 0 ? alloc : await stat(file).then((entry) => entry.size).catch(() => 0);
              try {
                await rm(file, { force: true });
                freedThisPass += size;
              } catch (error: unknown) {
                allRemoved = false;
                log("Deleting a legacy Apple restore image did not finish.", error);
              }
            }
            const latestBeforeClear = await readState();
            const clearLegacySetup = latestBeforeClear.setup.guestOs !== "linux";
            if (clearLegacySetup) {
              await deps.secrets
                .deleteFamily(BOT_COMPUTER_SECRET_FAMILY)
                .catch((error: unknown) => log("Removing old guest password did not finish.", error));
            }
            const migratedBotIds: string[] = [];
            const migratedVmIds: string[] = [];
            state = await updateState((draft) => {
              if (draft.setup.guestOs !== "linux") {
                draft.setup = {};
                for (const [computerId, rec] of Object.entries(draft.vms)) {
                  if (rec.migratedFromMacos) continue;
                  migratedVmIds.push(computerId);
                  draft.vms[computerId] = {
                    id: rec.id,
                    name: rec.name,
                    kind: rec.kind,
                    vmName: rec.vmName,
                    baseBuild: "",
                    createdAt: rec.createdAt,
                    ...(rec.lastUsedAt !== undefined ? { lastUsedAt: rec.lastUsedAt } : {}),
                    migratedFromMacos: true,
                  };
                  for (const botId of assignedBotsInState(draft, computerId)) {
                    migratedBotIds.push(botId);
                  }
                }
              }
              const totalFreedBytes = (draft.macosMigration?.freedBytes ?? 0) + freedThisPass;
              draft.macosMigration = allRemoved
                ? {
                    completedAt: now(),
                    freedBytes: totalFreedBytes,
                    noticeDismissed: false,
                  }
                : {
                    freedBytes: totalFreedBytes,
                  };
            });
            for (const computerId of migratedVmIds) stale.delete(computerId);
            for (const botId of migratedBotIds) {
              await Promise.resolve(deps.onMacosComputerMigrated?.(botId, BOT_COMPUTER_LINUX_MIGRATION_BOT_NOTE)).catch(
                (error: unknown) => log("Writing Linux migration note to Bot memory did not finish.", error),
              );
            }
            if (allRemoved || freedThisPass > 0 || migratedBotIds.length > 0) {
              deps.onRemoved?.();
            }
          });
        } else if (state.setup.guestOs === "linux") {
          state = await updateState((draft) => {
            if (!draft.macosMigration?.completedAt) {
              draft.macosMigration = {
                completedAt: now(),
                freedBytes: 0,
                noticeDismissed: true,
              };
            }
          });
        }
      }

      if (!lumeListed) {
        emit();
        return;
      }

      const vmNameToComputerId = new Map(Object.values(state.vms).map((vm) => [vm.vmName, vm.id]));
      for (const info of byName.values()) {
        if (!(isAidenVmName(info.name) || info.name === BOT_COMPUTER_STAGING_BASE_VM)) continue;
        const computerId = vmNameToComputerId.get(info.name);
        const turnBusy = () =>
          hasActiveTurn(undefined) || (computerId !== undefined && hasActiveTurn(vmTurnKey(computerId)));
        // Checked per VM, after the listing: a start, lifecycle op, or base build may have begun meanwhile.
        if (turnBusy() || (await vmsInUse()).has(info.name)) continue;
        if (info.state === "running") {
          if (turnBusy() || (await vmsInUse()).has(info.name)) continue;
          // Left running by an earlier Aiden that quit or crashed.
          await stopVm(info.name, true).catch((error: unknown) => log("Stopping an orphaned VM did not finish.", error));
        }
        if (info.state === "provisioning" && info.stale && (info.name === BOT_COMPUTER_BASE_VM || info.name === BOT_COMPUTER_STAGING_BASE_VM)) {
          if (turnBusy() || (await vmsInUse()).has(info.name)) continue;
          await deleteVm(info.name).catch((error: unknown) => log("Deleting an interrupted base did not finish.", error));
          if (info.name === BOT_COMPUTER_BASE_VM && !ready(state)) {
            setupState = { kind: "failed", message: "Set up was interrupted. Choose Set up to try again.", resumable: true };
          }
        }
      }
      if (ready(state) && !byName.has(BOT_COMPUTER_BASE_VM) && !setupTask) {
        const staging = byName.get(BOT_COMPUTER_STAGING_BASE_VM);
        let recoveredBase = false;
        if (staging && staging.state !== "provisioning" && !staging.stale) {
          try {
            if (staging.state === "running") await stopVm(BOT_COMPUTER_STAGING_BASE_VM, true);
            await lumeOrThrow(
              { op: "clone", source: BOT_COMPUTER_STAGING_BASE_VM, target: BOT_COMPUTER_BASE_VM },
              600_000,
              "Aiden couldn't recover the base computer.",
            );
            await deleteVm(BOT_COMPUTER_STAGING_BASE_VM).catch((error: unknown) =>
              log("Deleting recovered staging base did not finish.", error),
            );
            byName.delete(BOT_COMPUTER_STAGING_BASE_VM);
            byName.set(BOT_COMPUTER_BASE_VM, { ...staging, name: BOT_COMPUTER_BASE_VM, state: "stopped" });
            recoveredBase = true;
          } catch (error: unknown) {
            log("Recovering base computer from staging copy did not finish.", error);
          }
        }
        if (!recoveredBase) {
          state = await updateState((draft) => {
            draft.setup = draft.setup.guestOs ? { guestOs: draft.setup.guestOs } : {};
          });
        }
      }
      for (const [computerId, record] of Object.entries(state.vms)) {
        if (hasActiveTurn(undefined) || hasActiveTurn(vmTurnKey(computerId))) continue;
        if (record.migratedFromMacos) {
          stale.delete(computerId);
          continue;
        }
        const info = byName.get(record.vmName);
        if (!info || (info.state === "provisioning" && info.stale)) stale.add(computerId);
        else stale.delete(computerId);
      }
      emit();
    },

    beginQuit() {
      shuttingDown = true;
      // A `lume run` still starting up is ended now, so it can't launch a computer once
      // Aiden has gone. No new one can start after this.
      quitting.abort();
    },

    async shutdown(timeoutMs) {
      host.beginQuit();
      host.cancelSetUp();
      for (const wake of [...slotWaiters]) wake();
      for (const computerId of runtimes.keys()) clearQueue(computerId, "Aiden is quitting.", { forceActive: true });
      const stops = [...runtimes.keys()].map((computerId) => stopVmRuntime(computerId, "quit").catch(() => undefined));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([...stops, setupTask?.catch(() => undefined)]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      for (const entry of runtimes.values()) {
        entry.cancelIdle?.();
        const tunnel = entry.vncTunnel;
        entry.vncTunnel = undefined;
        void tunnel?.close().catch(() => undefined);
      }
    },

    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return host;
}
