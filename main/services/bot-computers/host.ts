import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  parseBotComputersSettingsPatch,
  type BotComputerRunState,
  type BotComputerSetupState,
  type BotComputersSettings,
  type BotComputersStatus,
  type BotComputerStatus,
} from "../../../renderer/shared/bot-computers.js";
import { CUA_DRIVER_UPSTREAM_PIN } from "../computer-use/binary.js";
import { CUA_DRIVER_VERSION } from "../computer-use/contract.js";
import type { CuaDriverHostFactory, CuaDriverSessionLike } from "../computer-use/controller.js";
import { createBotComputerControl, type BotComputerControlRegistry } from "./control.js";
import { createGuestCuaDriverHostFactory, guestDriverSshBridge, type GuestDriverBridgeCommand } from "./guest-driver.js";
import { guestDriverRestartScript, installGuestDriver, type GuestDriverLocation } from "./guest-driver-install.js";
import { guestDriverPermissions, guestDriverReady, probeGuestDriver, type GuestDriverPermissions } from "./guest-driver-readiness.js";
import { lumeEnvironment, runLume, type LumeCommand, type LumeInvocation, type LumeRunResult } from "./lume-cli.js";
import { classifyLumeError, isLoopbackHost, parseLumeVmInfo, parseLumeVmList, type LumeErrorKind, type LumeVmInfo } from "./lume-output.js";
import { buildBaseVm, generateGuestPassword, type ProvisionContext } from "./provision.js";
import {
  BOT_COMPUTER_RESTORE_IMAGE,
  BOT_COMPUTER_BASE_DISK_RESERVE_BYTES,
  BOT_COMPUTER_BASE_SIZE_BYTES,
  BOT_COMPUTER_VM_MEMORY_BYTES,
} from "./release.js";
import { allocatedBytes, requireResources, systemResourceProbe, type BotComputerResourceProbe } from "./resources.js";
import { createRestoreImageDownloader, type RestoreImagePin } from "./restore-image-download.js";
import { createBotComputerActivity, type BotComputerActivity } from "./sessions.js";
import {
  BOT_COMPUTER_GUEST_USER,
  ensureKeyPair,
  guestSshEnvironment,
  guestSshPaths,
  runGuestCommand as runSshCommand,
  writeKnownHost,
  type GuestSshTarget,
  type ProcessRunner,
} from "./ssh.js";
import {
  createBotComputersStore,
  type BotComputerGuestDriverRecord,
  type BotComputerRecord,
  type BotComputersState,
} from "./store.js";
import {
  BOT_COMPUTER_GUEST_PASSWORD_SECRET,
  BOT_COMPUTER_SECRET_FAMILY,
  BotComputerError,
  type BotComputerConnection,
  type BotComputerGuestCommandResult,
  type BotComputerHost,
  type BotComputerStartReason,
  type BotComputerStopReason,
} from "./types.js";
import { vncReachableBeyondLoopback } from "./vnc-exposure.js";
import { BOT_COMPUTER_BASE_VM, BOT_COMPUTER_STAGING_BASE_VM, botComputerVmName, isAidenVmName } from "./vm-names.js";

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
  /** `/usr/bin/ssh` and `/usr/bin/ssh-keygen`, or fakes. */
  sshCommand?: string;
  keygenCommand?: string;
  runProcess?: ProcessRunner;
  vncExposed?(port: number): Promise<boolean>;
  control?: BotComputerControlRegistry;
  activity?: BotComputerActivity;
  /**
   * The vendored cua-driver to copy into a base, verified against Aiden's pin
   * (the guest driver lane). Without it, or when it can't be resolved, bases
   * are made for the VNC lane only.
   */
  guestDriverExecutable?(signal: AbortSignal): Promise<string>;
  /** cua-driver's licence notice from the same helper bundle, copied beside the driver in the guest. */
  guestDriverNotice?(): string | undefined;
  /** The guest lane's host factory over a bridge; tests swap in the fake driver. */
  guestDriverHost?(bridge: () => Promise<GuestDriverBridgeCommand>): CuaDriverHostFactory;
  /** How long setup waits for the person's grants before it finishes without element control. */
  permissionWaitMs?: number;
  /** Gap between grant checks while setup waits. */
  permissionPollMs?: number;
  /** Setup finished: the Bot runtime may now offer computers. */
  onSetupReady?(): void;
  /** Remove everything finished. */
  onRemoved?(): void;
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

interface Runtime {
  state: BotComputerRunState;
  connection?: BotComputerConnection;
  start?: SharedStart;
  stopping?: Promise<void>;
  cancelIdle?: () => void;
  lastUsedAt?: number;
  leases: number;
  /** Reset or Delete replacing this computer's VM; a start waits until it is done. */
  replacing?: Promise<void>;
}

const SLOT_STATES: ReadonlySet<BotComputerRunState> = new Set(["starting", "running", "stopping"]);
/** A computer used this recently is in use, not idle, even between actions. */
const ACTIVE_USE_MS = 60_000;
const START_DISK_BYTES = 5 * 1024 ** 3;
const VNC_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

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
    home: path.join(root, "home"),
    logs: path.join(root, "logs"),
    images: path.join(root, "restore-images"),
    baseShared: path.join(root, "base-shared"),
  };
  const sshPaths = guestSshPaths(root);
  const image = deps.image ?? BOT_COMPUTER_RESTORE_IMAGE;
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
  const control = deps.control ?? createBotComputerControl();
  const activity = deps.activity ?? createBotComputerActivity();
  const exposed = deps.vncExposed ?? ((port: number) => vncReachableBeyondLoopback(port));
  const log = deps.log ?? (() => undefined);
  const downloader = createRestoreImageDownloader({
    dir: dirs.images,
    image,
    fetchImpl: deps.fetchImpl,
    freeDiskBytes: (dir) => resources.freeDiskBytes(dir),
    reserveBytes: BOT_COMPUTER_BASE_DISK_RESERVE_BYTES,
  });

  const runtimes = new Map<string, Runtime>();
  const stale = new Set<string>();
  const listeners = new Set<(botId: string | undefined) => void>();
  const slotWaiters = new Set<() => void>();
  let setupState: BotComputerSetupState | undefined;
  let setupTask: Promise<void> | undefined;
  let setupAbort: AbortController | undefined;
  let shuttingDown = false;
  let diskCache: { at: number; bytes: number } | undefined;
  /** A base being built boots as a VM too, so it holds one of the running places. */
  let baseHoldsSlot = false;
  /** The base while setup waits for the person's grants: Settings shows its screen. */
  let baseViewConnection: BotComputerConnection | undefined;
  let permissionWait: { check(): void; skip(): void } | undefined;
  /** Why the last element-control attempt ended without it; shown with the ready base. */
  let elementControlNote: string | undefined;
  /**
   * Give and Reset copying the base's disk right now. Set up, Update base and
   * Set up element control wait for them before they boot or replace the base,
   * so no copy reads a disk that is running or being swapped.
   */
  const copies = new Set<Promise<unknown>>();
  /** Remove everything in progress; a start waits until it is done (and then finds no computer). */
  let removing: Promise<void> | undefined;
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
  control.onChange((botId) => emit(botId));
  activity.onChange((botId) => emit(botId));

  const runtime = (botId: string): Runtime => {
    let found = runtimes.get(botId);
    if (!found) {
      found = { state: "stopped", leases: 0 };
      runtimes.set(botId, found);
    }
    return found;
  };
  const occupied = () =>
    [...runtimes.values()].filter((entry) => SLOT_STATES.has(entry.state)).length + (baseHoldsSlot ? 1 : 0);
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

  async function lume(command: LumeCommand, timeoutMs: number, signal?: AbortSignal): Promise<LumeRunResult> {
    // Verified first: Aiden's VM storage only appears once Lume can run, so a
    // Mac whose helper is missing never makes later deletes or startups run it.
    const resolved = await invocation();
    await mkdir(dirs.vms, { recursive: true, mode: 0o700 });
    await mkdir(dirs.home, { recursive: true, mode: 0o700 });
    return runLume(resolved, command, { storage: dirs.vms, env: lumeEnv(), timeoutMs, signal });
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

  async function stopVm(vmName: string, force: boolean): Promise<void> {
    const result = await lume({ op: "stop", name: vmName, force, timeoutSeconds: force ? 0 : 30 }, force ? 30_000 : 75_000);
    if (result.exitCode === 0) return;
    const kind = failureKind(result);
    if (kind === "not_running" || kind === "not_found") return;
    if (!force) {
      await stopVm(vmName, true);
      return;
    }
    log(`lume stop failed: ${result.stderr.slice(-600)}`);
    throw new BotComputerError("lume_failed", "Aiden couldn't stop the computer.");
  }

  async function getVm(vmName: string, signal?: AbortSignal): Promise<LumeVmInfo | undefined> {
    const result = await lume({ op: "get", name: vmName }, 30_000, signal);
    if (result.exitCode !== 0) {
      if (failureKind(result) === "not_found") return undefined;
      throw new BotComputerError("lume_failed", "Aiden couldn't read the computer's state.");
    }
    return parseLumeVmInfo(result.stdout);
  }

  async function logTail(file: string): Promise<string> {
    try {
      const text = await readFile(file, "utf8");
      return text.slice(-16_384);
    } catch {
      return "";
    }
  }

  function startFailure(kind: LumeErrorKind, owner: string): BotComputerError {
    switch (kind) {
      case "vm_limit":
        return new BotComputerError(
          "vm_limit",
          "macOS runs at most two virtual machines at once, and another app is using one. Quit it or stop another Bot's computer, then try again.",
        );
      case "not_found":
      case "stale":
        return new BotComputerError("stale", `${owner} computer is missing or incomplete. Reset it in the Bot's profile.`);
      default:
        return new BotComputerError("start_failed", `${owner} computer didn't start.`);
    }
  }

  /**
   * Start a VM detached and wait for it to be running with an IP and a VNC
   * endpoint. The endpoint must be loopback (G22) and its port must not answer
   * on any other interface; otherwise the VM is stopped and refused.
   */
  async function runAndWait(
    vmName: string,
    sharedDir: string,
    owner: string,
    signal: AbortSignal | undefined,
    requireSsh: boolean,
  ): Promise<{ info: LumeVmInfo & { ip: string; vnc: { host: string; port: number } }; password: string }> {
    const password = vncPassword();
    await mkdir(dirs.logs, { recursive: true, mode: 0o700 });
    const logFile = path.join(dirs.logs, `${vmName}.log`);
    await rm(logFile, { force: true });
    const started = await lume({ op: "run", name: vmName, vncPassword: password, sharedDir, logFile }, 60_000, signal);
    if (started.exitCode !== 0) throw startFailure(failureKind(started), owner);
    const deadline = now() + startTimeoutMs;
    let polls = 0;
    try {
      for (;;) {
        polls += 1;
        const info = await getVm(vmName, signal);
        if (!info) throw startFailure("not_found", owner);
        if (info.stale) throw startFailure("stale", owner);
        if (info.state === "running" && info.ip && info.vnc && (!requireSsh || info.sshAvailable === true)) {
          if (!isLoopbackHost(info.vnc.host)) {
            throw new BotComputerError("vnc_not_loopback", `${owner} computer offered its screen beyond this Mac, so Aiden stopped it.`);
          }
          if (await exposed(info.vnc.port)) {
            throw new BotComputerError("vnc_not_loopback", `${owner} computer's screen was reachable from the network, so Aiden stopped it.`);
          }
          return { info: { ...info, ip: info.ip, vnc: info.vnc }, password };
        }
        if (info.state !== "running" && polls > 1) {
          const tail = await logTail(logFile);
          if (/^Error:/mu.test(tail)) throw startFailure(classifyLumeError(tail, 1), owner);
        }
        if (now() > deadline) throw new BotComputerError("start_failed", `${owner} computer didn't start in time.`);
        await delay(pollMs, signal);
      }
    } catch (error) {
      await stopVm(vmName, true).catch((stopError: unknown) => log("Stopping a failed start did not finish.", stopError));
      throw error;
    }
  }

  function idleCandidate(except?: string): string | undefined {
    let candidate: { botId: string; lastUsedAt: number } | undefined;
    const current = now();
    for (const [botId, entry] of runtimes) {
      if (botId === except || entry.state !== "running" || entry.leases > 0) continue;
      if (control.controller(botId) === "person" || control.activeActions(botId) > 0) continue;
      const lastUsedAt = entry.lastUsedAt ?? 0;
      if (current - lastUsedAt < ACTIVE_USE_MS) continue;
      if (!candidate || lastUsedAt < candidate.lastUsedAt) candidate = { botId, lastUsedAt };
    }
    return candidate?.botId;
  }

  async function acquireSlot(botId: string, entry: Runtime, signal: AbortSignal, onProgress?: (text: string) => void): Promise<void> {
    for (;;) {
      if (signal.aborted) throw new BotComputerError("cancelled", "Starting the computer was cancelled.");
      if (shuttingDown) throw new BotComputerError("busy", "Aiden is quitting.");
      const { settings } = await store.read();
      if (occupied() < settings.maxRunning) {
        entry.state = "starting";
        return;
      }
      const idle = idleCandidate(botId);
      if (idle) {
        await stopComputer(idle, "limit");
        continue;
      }
      if (entry.state !== "waiting_for_slot") {
        entry.state = "waiting_for_slot";
        emit(botId);
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
      const { settings } = await store.read();
      if (occupied() < settings.maxRunning) {
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
      await stopComputer(idle, "limit");
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
    const { computers } = await store.read();
    for (const [botId, entry] of runtimes) {
      if (entry.state === "stopped" && !entry.start && !entry.stopping) continue;
      const vmName = entry.connection?.vmName ?? computers[botId]?.vmName;
      if (vmName) names.add(vmName);
    }
    return names;
  }

  function armIdle(botId: string, entry: Runtime, minutes: number): void {
    entry.cancelIdle?.();
    entry.cancelIdle = schedule(() => {
      entry.cancelIdle = undefined;
      if (entry.state !== "running") return;
      if (entry.leases > 0 || control.controller(botId) === "person" || control.activeActions(botId) > 0) {
        armIdle(botId, entry, minutes);
        return;
      }
      void stopComputer(botId, "idle").catch((error: unknown) => log("Idle stop did not finish.", error));
    }, minutes * 60_000);
  }

  async function sharedDirFor(botId: string): Promise<string> {
    const dir = await deps.botComputerDir(botId);
    if (!path.isAbsolute(dir) || dir.includes(":")) {
      throw new BotComputerError("invalid", "The Bot's Computer folder path can't contain a colon.");
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async function startComputer(
    botId: string,
    record: BotComputerRecord,
    entry: Runtime,
    options: { reason: BotComputerStartReason; signal: AbortSignal; onProgress?(text: string): void },
  ): Promise<BotComputerConnection> {
    const owner = await possessive(botId);
    try {
      await acquireSlot(botId, entry, options.signal, options.onProgress);
      emit(botId);
      await requireResources(resources, {
        dir: root,
        diskBytes: START_DISK_BYTES,
        memoryBytes: BOT_COMPUTER_VM_MEMORY_BYTES,
        signal: options.signal,
      });
      options.onProgress?.(`Starting ${owner} computer…`);
      const sharedDir = await sharedDirFor(botId);
      const { info, password } = await runAndWait(record.vmName, sharedDir, owner, options.signal, false);
      const connection: BotComputerConnection = {
        vmName: record.vmName,
        ip: info.ip,
        vnc: { host: "127.0.0.1", port: info.vnc.port, password },
        ssh: { host: info.ip, user: BOT_COMPUTER_GUEST_USER },
      };
      entry.state = "running";
      entry.connection = connection;
      entry.lastUsedAt = now();
      const state = await store.update((draft) => {
        const current = draft.computers[botId];
        if (current) current.lastUsedAt = entry.lastUsedAt;
      });
      armIdle(botId, entry, state.settings.idleStopMinutes);
      emit(botId);
      return connection;
    } catch (error) {
      if (entry.state !== "running") {
        entry.state = "stopped";
        entry.connection = undefined;
        wakeSlotWaiters();
        emit(botId);
      }
      throw error;
    }
  }

  async function stopComputer(botId: string, reason: BotComputerStopReason): Promise<void> {
    const entry = runtimes.get(botId);
    if (!entry) return;
    if (entry.start) {
      const start = entry.start;
      start.controller.abort();
      await start.promise.catch(() => undefined);
    }
    if (entry.stopping) return entry.stopping;
    if (entry.state !== "running") return;
    const connection = entry.connection;
    const vmName = connection?.vmName ?? (await store.read()).computers[botId]?.vmName;
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    entry.state = "stopping";
    entry.connection = undefined;
    emit(botId);
    entry.stopping = (async () => {
      let stillRunning = false;
      try {
        if (vmName) await stopVm(vmName, reason === "quit");
      } catch (error) {
        // Even a forced stop failed: count the computer as off only if Lume says it is. One
        // that is still on keeps its place (macOS's limit) and its connection, and its idle
        // timer tries again; an unreadable state counts as on.
        stillRunning =
          vmName !== undefined && connection !== undefined && (await getVm(vmName).then((info) => info?.state === "running", () => true));
        throw error;
      } finally {
        entry.stopping = undefined;
        if (stillRunning && connection) {
          log("A Bot computer did not stop; it is still running.");
          entry.state = "running";
          entry.connection = connection;
          const minutes = await store
            .read()
            .then((state) => state.settings.idleStopMinutes)
            .catch(() => undefined);
          if (minutes !== undefined && entry.state === "running") armIdle(botId, entry, minutes);
        } else {
          entry.state = "stopped";
          // What the Bot was doing ended with the run.
          activity.set(botId, undefined);
          // Nobody uses a computer that is off. Control goes back to the Bot, so its next call
          // doesn't wait for a Give back the tab can't offer and a later run idles out as usual.
          // A sign-in card's hold lasts until the card settles or is withdrawn.
          if (control.controller(botId) === "person" && control.takenOverBy(botId) !== "sign_in") control.giveBack(botId);
          if (entry.lastUsedAt !== undefined) {
            const lastUsedAt = entry.lastUsedAt;
            await store
              .update((draft) => {
                const current = draft.computers[botId];
                if (current) current.lastUsedAt = lastUsedAt;
              })
              .catch(() => undefined);
          }
          wakeSlotWaiters();
        }
        emit(botId);
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

  /** What a start of this computer waits for first: Remove everything, or a Reset or Delete of it. */
  const startsHeld = (botId: string): Promise<void> | undefined => removing ?? runtimes.get(botId)?.replacing;

  /** A gate that `work` holds until it settles; `set` installs it and later clears it. */
  async function holdingStarts<T>(
    set: (gate: Promise<void>) => void,
    clear: (gate: Promise<void>) => void,
    work: () => Promise<T>,
  ): Promise<T> {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    set(gate);
    try {
      return await work();
    } finally {
      clear(gate);
      release();
    }
  }

  /**
   * Reset and Delete replace a computer's VM. Their stop gives a computer the person held back
   * to the Bot, so a call that waited for Give back goes on at once: it must not start the old
   * VM while that is deleted or copied over, only the computer that is there afterwards.
   */
  function replacingComputer<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const entry = runtime(botId);
    return holdingStarts(
      (gate) => {
        entry.replacing = gate;
      },
      (gate) => {
        if (entry.replacing === gate) entry.replacing = undefined;
      },
      work,
    );
  }

  function untilDone(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return gate;
    return new Promise<void>((resolve, reject) => {
      const cancel = () => reject(new BotComputerError("cancelled", "Starting the computer was cancelled."));
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

  async function requireRecord(botId: string): Promise<BotComputerRecord> {
    const record = (await store.read()).computers[botId];
    if (!record) throw new BotComputerError("no_computer", `${await name(botId)} doesn't have a computer yet.`);
    return record;
  }

  function ensureSupported(): void {
    const support = deps.support();
    if (!support.ok) {
      throw new BotComputerError(
        "unsupported",
        support.reason === "host_os" ? "Bot computers need macOS 26 or later." : "Bot computers need a Mac with Apple silicon.",
      );
    }
  }

  function ready(state: BotComputersState): boolean {
    return state.setup.baseBuild !== undefined;
  }

  function currentSetup(state: BotComputersState): BotComputerSetupState {
    const support = deps.support();
    if (!support.ok) return { kind: "unsupported", reason: support.reason };
    if (setupState) return setupState;
    if (state.setup.baseBuild) {
      const elementControl = guestDriverReady(state.setup.guestDriver);
      return {
        kind: "ready",
        baseVersion: state.setup.baseVersion ?? image.version,
        baseBuild: state.setup.baseBuild,
        updateAvailable: state.setup.baseBuild !== image.build,
        elementControl,
        ...(!elementControl && elementControlNote ? { elementControlNote } : {}),
      };
    }
    return { kind: "not_set_up" };
  }

  function computerStatus(botId: string, record: BotComputerRecord, state: BotComputersState): BotComputerStatus {
    const entry = runtimes.get(botId);
    const lastUsedAt = entry?.lastUsedAt ?? record.lastUsedAt;
    const text = activity.get(botId);
    return {
      botId,
      vmName: record.vmName,
      state: stale.has(botId) ? "stale" : (entry?.state ?? "stopped"),
      baseBuild: record.baseBuild,
      outdated: state.setup.baseBuild !== undefined && record.baseBuild !== state.setup.baseBuild,
      ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
      controller: control.controller(botId),
      ...(text ? { activity: text } : {}),
    };
  }

  async function cloneFromBase(botId: string, state: BotComputersState): Promise<BotComputerRecord> {
    const vmName = botComputerVmName(botId);
    await sharedDirFor(botId);
    await deleteVm(vmName);
    await lumeOrThrow({ op: "clone", source: BOT_COMPUTER_BASE_VM, target: vmName }, 600_000, "Aiden couldn't make the computer from the base. Try again.");
    // The clone is a copy of the base's disk, its guest driver and grants with it.
    const guestDriver = state.setup.guestDriver;
    return {
      vmName,
      baseBuild: state.setup.baseBuild ?? image.build,
      createdAt: now(),
      ...(guestDriver ? { guestDriver: { ...guestDriver } } : {}),
    };
  }

  function provisionContext(
    vmName: string,
    ip: string,
    publicKey: string,
    guestPassword: string | undefined,
    signal: AbortSignal,
    guestDriver?: ProvisionContext["guestDriver"],
  ): ProvisionContext {
    const sshEnv = guestSshEnvironment(deps.env ?? process.env, dirs.home);
    return {
      signal,
      publicKey,
      ...(guestDriver ? { guestDriver } : {}),
      lumeSsh: (command, timeoutSeconds) =>
        lume({ op: "ssh", name: vmName, command, timeoutSeconds }, (timeoutSeconds + 15) * 1_000, signal),
      guestSsh: (command, options) =>
        runSshCommand(
          { host: ip, user: BOT_COMPUTER_GUEST_USER },
          command,
          { timeoutMs: options.timeoutMs, maxOutputBytes: 64 * 1024, signal, stdin: options.stdin },
          { paths: sshPaths, env: sshEnv, sshCommand: deps.sshCommand, run: deps.runProcess },
        ),
      stopBase: () => shutDownBase(vmName, signal),
      writeKnownHost: (line) => writeKnownHost(sshPaths, line),
      // Every base gets the one stored password, so the computers made from an
      // older base (and the working base, if this build fails) keep a known one.
      newPassword: () => guestPassword ?? generateGuestPassword(),
      storePassword: (password) => deps.secrets.set(BOT_COMPUTER_GUEST_PASSWORD_SECRET, password),
    };
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

  type GuestStep = "guest_driver" | "permissions";

  /**
   * "Allow Accessibility and Screen Recording for cua-driver": raise the
   * guest's prompts, show the base's screen in Settings, and check until both
   * are on, the person skips, or the wait runs out. Then restart the daemon
   * and probe. Only a pass is recorded; everything else keeps the VNC lane.
   */
  async function awaitGrants(
    base: BotComputerConnection,
    location: GuestDriverLocation,
    password: string,
    signal: AbortSignal,
    show: (step: GuestStep, permissions?: GuestDriverPermissions) => void,
  ): Promise<BotComputerGuestDriverRecord | undefined> {
    const target: GuestSshTarget = { host: base.ip, user: BOT_COMPUTER_GUEST_USER };
    let wake: (() => void) | undefined;
    // Skip ends whatever step is running (the first check, a later one, the restart or the
    // probe) at once, not only the wait between checks.
    const skipping = new AbortController();
    const step = AbortSignal.any([signal, skipping.signal]);
    const skippedNote = "Element control was skipped, so Bots act on the screen only.";
    permissionWait = {
      check: () => wake?.(),
      skip: () => {
        skipping.abort();
        wake?.();
      },
    };
    baseViewConnection = base;
    let open: { session: CuaDriverSessionLike; close(): Promise<void> } | undefined;
    try {
      let permissions: GuestDriverPermissions = { accessibility: false, screenRecording: false };
      show("permissions", permissions);
      open = await openGuestDriver(target, location, step);
      permissions = await guestDriverPermissions(open.session, { prompt: true, signal: step });
      const deadline = now() + (deps.permissionWaitMs ?? 30 * 60_000);
      while (!(permissions.accessibility && permissions.screenRecording)) {
        show("permissions", permissions);
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            step.removeEventListener("abort", done);
            wake = undefined;
            resolve();
          };
          const timer = setTimeout(done, deps.permissionPollMs ?? 3_000);
          wake = done;
          step.addEventListener("abort", done, { once: true });
        });
        if (signal.aborted) throw setupCancelled();
        if (skipping.signal.aborted) {
          elementControlNote = skippedNote;
          return undefined;
        }
        if (now() > deadline) {
          elementControlNote = "The permissions weren't allowed in time, so Bots act on the screen only.";
          return undefined;
        }
        permissions = await guestDriverPermissions(open.session, { prompt: false, signal: step });
      }
      show("permissions", permissions);
      await open.close();
      open = undefined;
      // A daemon that started before the grants can keep refusing captures until it restarts.
      const restarted = await guestSshTo(target, step)(guestDriverRestartScript(location), {
        stdin: `${password}\n`,
        timeoutMs: 30_000,
      });
      if (restarted.exitCode !== 0 || restarted.timedOut) {
        throw new BotComputerError("start_failed", "The guest driver didn't restart.");
      }
      open = await openGuestDriver(target, location, step);
      const probe = await probeGuestDriver(open.session, step);
      if (skipping.signal.aborted) {
        elementControlNote = skippedNote;
        return undefined;
      }
      if (!probe.ready) {
        log(`The guest driver probe did not pass (${probe.reason}).`);
        elementControlNote = "Aiden's helper in the base computer didn't pass its check, so Bots act on the screen only.";
        return undefined;
      }
      elementControlNote = undefined;
      return { version: CUA_DRIVER_VERSION, home: location.home, uid: location.uid };
    } catch (error) {
      if (signal.aborted) throw setupCancelled();
      if (skipping.signal.aborted) {
        elementControlNote = skippedNote;
        return undefined;
      }
      log("Waiting for the guest driver's permissions did not finish.", error);
      elementControlNote = "Aiden couldn't check the permissions in the base computer, so Bots act on the screen only.";
      return undefined;
    } finally {
      await open?.close().catch(() => undefined);
      permissionWait = undefined;
      baseViewConnection = undefined;
      emit();
    }
  }

  /**
   * The guest driver lane for one running base: install, then the grants.
   * Never fails the base: a failure leaves it on the VNC lane, with a note.
   */
  function guestDriverSetup(base: BotComputerConnection, signal: AbortSignal) {
    const target: GuestSshTarget = { host: base.ip, user: BOT_COMPUTER_GUEST_USER };
    let location: GuestDriverLocation | undefined;
    let result: BotComputerGuestDriverRecord | undefined;
    const show = (step: GuestStep, permissions?: GuestDriverPermissions) => {
      setupState = { kind: "building_base", step, ...(permissions ? { permissions } : {}) };
      emit();
    };
    const hooks: NonNullable<ProvisionContext["guestDriver"]> = {
      async install(password) {
        elementControlNote = undefined;
        if (!deps.guestDriverExecutable) return;
        show("guest_driver");
        try {
          const driverPath = await deps.guestDriverExecutable(signal);
          const noticePath = deps.guestDriverNotice?.();
          location = await installGuestDriver({
            guestSsh: guestSshTo(target, signal),
            driverPath,
            ...(noticePath === undefined ? {} : { noticePath }),
            pin: CUA_DRIVER_UPSTREAM_PIN,
            password,
            signal,
          });
        } catch (error) {
          if (signal.aborted) throw setupCancelled();
          log("Installing the guest driver did not finish; Bot computers act on the screen only.", error);
          elementControlNote = "Aiden couldn't install its helper in the base computer, so Bots act on the screen only.";
        }
      },
      async grant(password) {
        if (location) result = await awaitGrants(base, location, password, signal, show);
      },
    };
    return { hooks, result: () => result };
  }

  /** Element control for a ready base made without it: boot it once, install, wait for the grants, shut it down. */
  async function performElementControlSetup(signal: AbortSignal): Promise<void> {
    // A Bot's computer still being copied from the base finishes before the base boots.
    await copiesSettled();
    const state = await store.read();
    if (!ready(state)) throw new BotComputerError("not_set_up", "Set up Bot computers in Settings first.");
    if (guestDriverReady(state.setup.guestDriver)) return;
    const password = await deps.secrets.get(BOT_COMPUTER_GUEST_PASSWORD_SECRET);
    if (password === null || !/^[A-Za-z0-9]{16,128}$/u.test(password)) {
      throw new BotComputerError("start_failed", "Aiden doesn't have the base computer's password. Update the base to set up element control.");
    }
    setupState = { kind: "building_base", step: "guest_driver" };
    emit();
    let record: BotComputerGuestDriverRecord | undefined;
    await acquireBaseSlot(signal);
    try {
      await requireResources(resources, { dir: root, memoryBytes: BOT_COMPUTER_VM_MEMORY_BYTES, signal });
      await mkdir(dirs.baseShared, { recursive: true, mode: 0o700 });
      const { info, password: vncPassword } = await runAndWait(BOT_COMPUTER_BASE_VM, dirs.baseShared, "The base", signal, true);
      const base: BotComputerConnection = {
        vmName: BOT_COMPUTER_BASE_VM,
        ip: info.ip,
        vnc: { host: "127.0.0.1", port: info.vnc.port, password: vncPassword },
        ssh: { host: info.ip, user: BOT_COMPUTER_GUEST_USER },
      };
      try {
        const driver = guestDriverSetup(base, signal);
        await driver.hooks.install(password);
        await driver.hooks.grant(password);
        record = driver.result();
      } finally {
        setupState = { kind: "building_base", step: "provision" };
        emit();
        await shutDownBase(BOT_COMPUTER_BASE_VM).catch(async (error: unknown) => {
          log("The base didn't shut down cleanly after element control setup.", error);
          await stopVm(BOT_COMPUTER_BASE_VM, true);
        });
      }
    } finally {
      releaseBaseSlot();
    }
    if (record) {
      const stored = record;
      await store.update((draft) => {
        draft.setup.guestDriver = stored;
      });
    }
  }

  async function performSetup(mode: "setup" | "update", signal: AbortSignal): Promise<void> {
    const target = mode === "setup" ? BOT_COMPUTER_BASE_VM : BOT_COMPUTER_STAGING_BASE_VM;
    // An update swaps the base at the end: a copy of the old one finishes first.
    await copiesSettled();
    // The bundled Lume is checked before a 20 GB download it would be needed for.
    await invocation();
    // Booting the base needs a running computer's memory. Say so before a long
    // download; with Bot computers running, their memory is not free yet (an idle
    // one may stop for the base), so only the check before the install applies.
    if (occupied() === 0) {
      await requireResources(resources, { dir: root, memoryBytes: BOT_COMPUTER_VM_MEMORY_BYTES, signal });
    }
    setupState = { kind: "downloading", receivedBytes: await downloader.partialBytes(), totalBytes: image.bytes };
    emit();
    const ipsw = await downloader.download({
      onProgress: (progress) => {
        setupState =
          progress.phase === "verifying"
            ? { kind: "verifying" }
            : { kind: "downloading", receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes };
        emit();
      },
    });
    if (signal.aborted) throw new BotComputerError("cancelled", "Setting up Bot computers was cancelled.");
    await store.update((draft) => {
      draft.setup.ipswPath = ipsw;
    });
    await acquireBaseSlot(signal);
    let guestDriver: BotComputerGuestDriverRecord | undefined;
    try {
      await requireResources(resources, { dir: root, memoryBytes: BOT_COMPUTER_VM_MEMORY_BYTES, signal });
      guestDriver = await buildAndInstallBase(mode, target, ipsw, signal);
    } finally {
      releaseBaseSlot();
    }
    await store.update((draft) => {
      draft.setup = { baseBuild: image.build, baseVersion: image.version, ...(guestDriver ? { guestDriver } : {}) };
    });
    setupState = undefined;
    deps.onSetupReady?.();
  }

  /** Install macOS into `target`, provision it, and (for an update) swap it in as the base. */
  async function buildAndInstallBase(
    mode: "setup" | "update",
    target: string,
    ipsw: string,
    signal: AbortSignal,
  ): Promise<BotComputerGuestDriverRecord | undefined> {
    setupState = { kind: "building_base", step: "create" };
    emit();
    const keyEnv = guestSshEnvironment(deps.env ?? process.env, dirs.home);
    await mkdir(dirs.home, { recursive: true, mode: 0o700 });
    const publicKey = await ensureKeyPair(sshPaths, {
      env: keyEnv,
      run: deps.runProcess,
      keygenCommand: deps.keygenCommand,
      signal,
    });
    await mkdir(dirs.baseShared, { recursive: true, mode: 0o700 });
    const stored = await deps.secrets.get(BOT_COMPUTER_GUEST_PASSWORD_SECRET);
    const guestPassword = stored !== null && /^[A-Za-z0-9]{16,128}$/u.test(stored) ? stored : undefined;
    let driver: ReturnType<typeof guestDriverSetup> | undefined;
    await buildBaseVm({
      signal,
      deleteVm: () => deleteVm(target),
      create: async () => {
        const result = await lume({ op: "create", name: target, ipsw, unattended: "tahoe" }, 3 * 60 * 60_000, signal);
        if (result.exitCode === 0) return;
        log(`lume create failed: ${result.stderr.slice(-600)}`);
        // The unattended install boots the VM, so another app's macOS VM can fill the last place.
        if (failureKind(result) === "vm_limit") throw startFailure("vm_limit", "The base");
        throw new BotComputerError("lume_failed", "Installing macOS on the base computer failed. Choose Set up to try again.");
      },
      start: async () => {
        const { info, password } = await runAndWait(target, dirs.baseShared, "The base", signal, true);
        driver = guestDriverSetup(
          {
            vmName: target,
            ip: info.ip,
            vnc: { host: "127.0.0.1", port: info.vnc.port, password },
            ssh: { host: info.ip, user: BOT_COMPUTER_GUEST_USER },
          },
          signal,
        );
        return { ip: info.ip };
      },
      provisionContext: (ip) => provisionContext(target, ip, publicKey, guestPassword, signal, driver?.hooks),
      stop: () => stopVm(target, true),
      removeIpsw: async () => {
        await downloader.remove();
      },
      onStep: (step, detail) => {
        // The guest driver's steps show themselves, only when there is a driver to install.
        if (detail === "guest_driver" || detail === "permissions") return;
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
    return driver?.result();
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
      } catch (error) {
        const resumable = (await downloader.partialBytes()) > 0 || existsSync(downloader.paths().final);
        const cancelled = error instanceof BotComputerError && error.code === "cancelled";
        const state = await store.read();
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

  function startElementControlSetup(): Promise<void> {
    if (setupTask) return setupTask;
    ensureSupported();
    if (shuttingDown) return Promise.reject(new BotComputerError("busy", "Aiden is quitting."));
    const controller = new AbortController();
    setupAbort = controller;
    const task = (async () => {
      try {
        await performElementControlSetup(controller.signal);
      } catch (error) {
        const cancelled = error instanceof BotComputerError && error.code === "cancelled";
        // The base is still ready; say why element control isn't on next to it.
        elementControlNote = cancelled
          ? undefined
          : `Element control wasn't set up: ${errorMessage(error)}`.slice(0, 300);
        if (!cancelled) log("Setting up element control failed.", error);
      } finally {
        setupState = undefined;
        setupTask = undefined;
        setupAbort = undefined;
        emit();
      }
    })();
    setupTask = task;
    return task;
  }

  async function diskUsed(): Promise<number> {
    if (diskCache && now() - diskCache.at < 30_000) return diskCache.bytes;
    const bytes = existsSync(root) ? await allocatedBytes(root) : 0;
    diskCache = { at: now(), bytes };
    return bytes;
  }

  const host: BotComputerHost & { readonly control: BotComputerControlRegistry; readonly activity: BotComputerActivity } = {
    control,
    activity,

    async status(): Promise<BotComputersStatus> {
      const state = await store.read();
      const freeDiskBytes = await resources.freeDiskBytes(root).catch(() => undefined);
      return {
        setup: currentSetup(state),
        settings: { ...state.settings },
        diskUsedBytes: await diskUsed(),
        ...(freeDiskBytes !== undefined ? { freeDiskBytes } : {}),
        computers: Object.entries(state.computers).map(([botId, record]) => computerStatus(botId, record, state)),
        requirements: {
          downloadBytes: image.bytes,
          baseDiskBytes: BOT_COMPUTER_BASE_SIZE_BYTES,
          setupFreeBytes: image.bytes + BOT_COMPUTER_BASE_DISK_RESERVE_BYTES,
          memoryPerComputerBytes: BOT_COMPUTER_VM_MEMORY_BYTES,
          baseVersion: image.version,
        },
      };
    },

    async baseReady() {
      return deps.support().ok && ready(await store.read());
    },

    async computer(botId) {
      const state = await store.read();
      const record = state.computers[botId];
      return record ? computerStatus(botId, record, state) : undefined;
    },

    async setUp() {
      // With a working base, Set up (which is also Settings' "Try again" after a
      // failed update) retries the update beside it. It never rebuilds, in place,
      // the base the Bots' computers came from.
      if (!setupTask && ready(await store.read())) return host.updateBase();
      return startSetup("setup");
    },

    cancelSetUp() {
      setupAbort?.abort();
      downloader.cancel();
    },

    async updateBase() {
      const state = await store.read();
      if (!ready(state)) return startSetup("setup");
      if (state.setup.baseBuild === image.build) return;
      return startSetup("update");
    },

    removeEverything: () =>
      // No start may begin while the files go; a call that waited finds no computer afterwards.
      holdingStarts(
        (gate) => {
          removing = gate;
        },
        (gate) => {
          if (removing === gate) removing = undefined;
        },
        async () => {
          host.cancelSetUp();
          await setupTask?.catch(() => undefined);
          const ids = [...runtimes.keys()];
          await Promise.all(ids.map((botId) => stopComputer(botId, "quit").catch(() => undefined)));
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
          await store.clear();
          for (const botId of ids) control.forget(botId);
          runtimes.clear();
          stale.clear();
          setupState = undefined;
          emit();
          deps.onRemoved?.();
        },
      ),

    async updateSettings(patch) {
      const parsed = parseBotComputersSettingsPatch(patch);
      const state = await store.update((draft) => {
        Object.assign(draft.settings, parsed);
      });
      if (parsed.idleStopMinutes !== undefined) {
        for (const [botId, entry] of runtimes) if (entry.state === "running") armIdle(botId, entry, state.settings.idleStopMinutes);
      }
      wakeSlotWaiters();
      emit();
      return { ...state.settings } satisfies BotComputersSettings;
    },

    async give(botId) {
      ensureSupported();
      const state = await store.read();
      const existing = state.computers[botId];
      if (existing) return computerStatus(botId, existing, state);
      if (!ready(state)) throw new BotComputerError("not_set_up", "Set up Bot computers in Settings first.");
      if (setupTask) throw new BotComputerError("busy", "Wait for the base computer to finish updating.");
      const record = await copyingBase(cloneFromBase(botId, state));
      const next = await store.update((draft) => {
        draft.computers[botId] = record;
      });
      stale.delete(botId);
      emit(botId);
      return computerStatus(botId, record, next);
    },

    async reset(botId) {
      ensureSupported();
      const record = await requireRecord(botId);
      const state = await store.read();
      if (!ready(state)) throw new BotComputerError("not_set_up", "Set up Bot computers in Settings first.");
      if (setupTask) throw new BotComputerError("busy", "Wait for the base computer to finish updating.");
      return replacingComputer(botId, async () => {
        const fresh = await copyingBase(
          (async () => {
            await stopComputer(botId, "person");
            await deleteVm(record.vmName);
            return cloneFromBase(botId, state);
          })(),
        );
        const next = await store.update((draft) => {
          draft.computers[botId] = fresh;
        });
        stale.delete(botId);
        emit(botId);
        return computerStatus(botId, fresh, next);
      });
    },

    deleteForBot: (botId) =>
      replacingComputer(botId, async () => {
        await stopComputer(botId, "quit").catch((error: unknown) => log("Stopping a deleted Bot's computer did not finish.", error));
        const record = (await store.read()).computers[botId];
        if (record) await deleteVm(record.vmName);
        else {
          // A clone that never reached the store can still exist, so the derived
          // name is tried too; that guess never holds up deleting a Bot that had
          // no computer, even when Lume can't run.
          await deleteVm(botComputerVmName(botId)).catch((error: unknown) =>
            log("Deleting a VM no record names did not finish.", error),
          );
        }
        // Deleting a Bot that never had a computer must not create Aiden's Bot-computer folder.
        if (record) {
          await store.update((draft) => {
            delete draft.computers[botId];
          });
        }
        runtimes.get(botId)?.cancelIdle?.();
        runtimes.delete(botId);
        stale.delete(botId);
        control.forget(botId);
        activity.set(botId, undefined);
        emit(botId);
      }),

    async ensureRunning(botId, options) {
      // Remove everything, or a Reset or Delete of this computer, finishes first.
      for (let held = startsHeld(botId); held; held = startsHeld(botId)) await untilDone(held, options.signal);
      if (shuttingDown) throw new BotComputerError("busy", "Aiden is quitting.");
      ensureSupported();
      const record = await requireRecord(botId);
      if (stale.has(botId)) {
        throw new BotComputerError("stale", `${await possessive(botId)} computer didn't finish being made. Reset it in the Bot's profile.`);
      }
      const entry = runtime(botId);
      for (;;) {
        if (entry.stopping) await entry.stopping;
        if (entry.state === "running" && entry.connection) {
          host.touch(botId);
          return entry.connection;
        }
        // A start every earlier caller gave up on is ending; this caller starts afresh once it has.
        const ending = entry.start?.controller.signal.aborted ? entry.start : undefined;
        if (!ending) break;
        await ending.promise.catch(() => undefined);
      }
      // One of those began while this caller waited above: it starts whatever is there once that is done.
      if (startsHeld(botId)) return host.ensureRunning(botId, options);
      if (!entry.start) {
        const controller = new AbortController();
        const progress = new Set<(text: string) => void>();
        const start: SharedStart = {
          controller,
          progress,
          callers: 0,
          promise: startComputer(botId, record, entry, {
            reason: options.reason,
            signal: controller.signal,
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

    stop(botId, options) {
      return stopComputer(botId, options?.reason ?? "person");
    },

    runningConnection(botId) {
      const entry = runtimes.get(botId);
      return entry?.state === "running" && entry.connection ? entry.connection : undefined;
    },

    touch(botId) {
      const entry = runtimes.get(botId);
      if (!entry || entry.state !== "running") return;
      entry.lastUsedAt = now();
      void store
        .read()
        .then((state) => {
          if (entry.state === "running") armIdle(botId, entry, state.settings.idleStopMinutes);
        })
        .catch(() => undefined);
    },

    async runGuestCommand(botId, command, options) {
      const connection = await host.ensureRunning(botId, { reason: "tool", signal: options.signal });
      const entry = runtime(botId);
      entry.leases += 1;
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
        entry.leases -= 1;
        host.touch(botId);
      }
    },

    async guestDriver(botId) {
      const record = (await store.read()).computers[botId];
      const driver = record?.guestDriver;
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

    setUpElementControl: () => startElementControlSetup(),

    checkPermissions() {
      permissionWait?.check();
    },

    skipPermissions() {
      permissionWait?.skip();
    },

    baseView: () => (baseViewConnection ? { ...baseViewConnection, vnc: { ...baseViewConnection.vnc }, ssh: { ...baseViewConnection.ssh } } : undefined),

    async reconcile() {
      if (!deps.support().ok || !existsSync(dirs.vms)) return;
      const state = await store.read();
      const listed = await lume({ op: "list" }, 30_000);
      if (listed.exitCode !== 0) {
        log(`lume ls failed: ${listed.stderr.slice(-600)}`);
        return;
      }
      const vms = parseLumeVmList(listed.stdout);
      const byName = new Map(vms.map((info) => [info.name, info]));
      for (const info of vms) {
        if (!(isAidenVmName(info.name) || info.name === BOT_COMPUTER_STAGING_BASE_VM)) continue;
        // Checked per VM, after the listing: a start or a base build may have begun meanwhile.
        if ((await vmsInUse()).has(info.name)) continue;
        if (info.state === "running") {
          // Left running by an earlier Aiden that quit or crashed.
          await stopVm(info.name, true).catch((error: unknown) => log("Stopping an orphaned VM did not finish.", error));
        }
        if (info.state === "provisioning" && info.stale && (info.name === BOT_COMPUTER_BASE_VM || info.name === BOT_COMPUTER_STAGING_BASE_VM)) {
          await deleteVm(info.name).catch((error: unknown) => log("Deleting an interrupted base did not finish.", error));
          if (info.name === BOT_COMPUTER_BASE_VM && !ready(state)) {
            setupState = { kind: "failed", message: "Set up was interrupted. Choose Set up to try again.", resumable: true };
          }
        }
      }
      if (ready(state) && !byName.has(BOT_COMPUTER_BASE_VM) && !setupTask) {
        await store.update((draft) => {
          draft.setup = {};
        });
      }
      for (const [botId, record] of Object.entries(state.computers)) {
        const info = byName.get(record.vmName);
        if (!info || (info.state === "provisioning" && info.stale)) stale.add(botId);
        else stale.delete(botId);
      }
      emit();
    },

    async shutdown(timeoutMs) {
      shuttingDown = true;
      host.cancelSetUp();
      for (const wake of [...slotWaiters]) wake();
      const stops = [...runtimes.keys()].map((botId) => stopComputer(botId, "quit").catch(() => undefined));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([...stops, setupTask?.catch(() => undefined)]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      for (const entry of runtimes.values()) entry.cancelIdle?.();
    },

    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return host;
}
