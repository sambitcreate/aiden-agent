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
import { createBotComputerControl, type BotComputerControlRegistry } from "./control.js";
import { lumeEnvironment, runLume, type LumeCommand, type LumeInvocation, type LumeRunResult } from "./lume-cli.js";
import { classifyLumeError, isLoopbackHost, parseLumeVmInfo, parseLumeVmList, type LumeErrorKind, type LumeVmInfo } from "./lume-output.js";
import { buildBaseVm, generateGuestPassword, type ProvisionContext } from "./provision.js";
import {
  BOT_COMPUTER_RESTORE_IMAGE,
  BOT_COMPUTER_BASE_DISK_RESERVE_BYTES,
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
  type ProcessRunner,
} from "./ssh.js";
import { createBotComputersStore, type BotComputerRecord, type BotComputersState } from "./store.js";
import {
  BOT_COMPUTER_GUEST_PASSWORD_SECRET,
  BOT_COMPUTER_SECRET_FAMILY,
  BotComputerError,
  type BotComputerConnection,
  type BotComputerHost,
  type BotComputerStartReason,
  type BotComputerStopReason,
} from "./types.js";
import { vncReachableBeyondLoopback } from "./vnc-exposure.js";
import { BOT_COMPUTER_BASE_VM, BOT_COMPUTER_STAGING_BASE_VM, botComputerVmName, isAidenVmName } from "./vm-names.js";

export interface BotComputerSecrets {
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
  /** Setup finished: the Bot runtime may now offer computers. */
  onSetupReady?(): void;
  /** Remove everything finished. */
  onRemoved?(): void;
  log?(message: string, error?: unknown): void;
}

interface Runtime {
  state: BotComputerRunState;
  connection?: BotComputerConnection;
  starting?: Promise<BotComputerConnection>;
  startAbort?: AbortController;
  stopping?: Promise<void>;
  cancelIdle?: () => void;
  lastUsedAt?: number;
  leases: number;
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
  const occupied = () => [...runtimes.values()].filter((entry) => SLOT_STATES.has(entry.state)).length;
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
    await mkdir(dirs.vms, { recursive: true, mode: 0o700 });
    await mkdir(dirs.home, { recursive: true, mode: 0o700 });
    return runLume(await invocation(), command, { storage: dirs.vms, env: lumeEnv(), timeoutMs, signal });
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

  /** Delete a VM; one Lume no longer has counts as deleted. */
  async function deleteVm(vmName: string): Promise<void> {
    if (!existsSync(dirs.vms)) return;
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

  function idleCandidate(except: string): string | undefined {
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
    if (entry.starting) {
      entry.startAbort?.abort();
      await entry.starting.catch(() => undefined);
    }
    if (entry.stopping) return entry.stopping;
    if (entry.state !== "running") return;
    const vmName = entry.connection?.vmName ?? (await store.read()).computers[botId]?.vmName;
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    entry.state = "stopping";
    entry.connection = undefined;
    emit(botId);
    entry.stopping = (async () => {
      try {
        if (vmName) await stopVm(vmName, reason === "quit");
      } finally {
        entry.state = "stopped";
        entry.stopping = undefined;
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
        emit(botId);
      }
    })();
    return entry.stopping;
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
      return {
        kind: "ready",
        baseVersion: state.setup.baseVersion ?? image.version,
        baseBuild: state.setup.baseBuild,
        updateAvailable: state.setup.baseBuild !== image.build,
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
    return { vmName, baseBuild: state.setup.baseBuild ?? image.build, createdAt: now() };
  }

  function provisionContext(vmName: string, ip: string, publicKey: string, signal: AbortSignal): ProvisionContext {
    const sshEnv = guestSshEnvironment(deps.env ?? process.env, dirs.home);
    return {
      signal,
      publicKey,
      lumeSsh: (command, timeoutSeconds) =>
        lume({ op: "ssh", name: vmName, command, timeoutSeconds }, (timeoutSeconds + 15) * 1_000, signal),
      guestSsh: (command, options) =>
        runSshCommand(
          { host: ip, user: BOT_COMPUTER_GUEST_USER },
          command,
          { timeoutMs: options.timeoutMs, maxOutputBytes: 64 * 1024, signal, stdin: options.stdin },
          { paths: sshPaths, env: sshEnv, sshCommand: deps.sshCommand, run: deps.runProcess },
        ),
      stopBase: async () => {
        const result = await lume({ op: "stop", name: vmName, timeoutSeconds: 120 }, 180_000, signal);
        if (result.exitCode !== 0) throw new BotComputerError("start_failed", "The base computer didn't shut down.");
      },
      writeKnownHost: (line) => writeKnownHost(sshPaths, line),
      newPassword: () => generateGuestPassword(),
      storePassword: (password) => deps.secrets.set(BOT_COMPUTER_GUEST_PASSWORD_SECRET, password),
    };
  }

  async function performSetup(mode: "setup" | "update", signal: AbortSignal): Promise<void> {
    const target = mode === "setup" ? BOT_COMPUTER_BASE_VM : BOT_COMPUTER_STAGING_BASE_VM;
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
    await buildBaseVm({
      signal,
      deleteVm: () => deleteVm(target),
      create: async () => {
        await lumeOrThrow(
          { op: "create", name: target, ipsw, unattended: "tahoe" },
          3 * 60 * 60_000,
          "Installing macOS on the base computer failed. Choose Set up to try again.",
          signal,
        );
      },
      start: async () => {
        const { info } = await runAndWait(target, dirs.baseShared, "The base", signal, true);
        return { ip: info.ip };
      },
      provisionContext: (ip) => provisionContext(target, ip, publicKey, signal),
      stop: () => stopVm(target, true),
      removeIpsw: async () => {
        await downloader.remove();
      },
      onStep: (step) => {
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
    await store.update((draft) => {
      draft.setup = { baseBuild: image.build, baseVersion: image.version };
    });
    setupState = undefined;
    deps.onSetupReady?.();
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
          baseDiskBytes: BOT_COMPUTER_BASE_DISK_RESERVE_BYTES,
          memoryPerComputerBytes: BOT_COMPUTER_VM_MEMORY_BYTES,
          baseVersion: image.version,
        },
      };
    },

    async computer(botId) {
      const state = await store.read();
      const record = state.computers[botId];
      return record ? computerStatus(botId, record, state) : undefined;
    },

    async setUp() {
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

    async removeEverything() {
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
      const record = await cloneFromBase(botId, state);
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
      await stopComputer(botId, "person");
      await deleteVm(record.vmName);
      const fresh = await cloneFromBase(botId, state);
      const next = await store.update((draft) => {
        draft.computers[botId] = fresh;
      });
      stale.delete(botId);
      emit(botId);
      return computerStatus(botId, fresh, next);
    },

    async deleteForBot(botId) {
      await stopComputer(botId, "quit").catch((error: unknown) => log("Stopping a deleted Bot's computer did not finish.", error));
      const record = (await store.read()).computers[botId];
      await deleteVm(record?.vmName ?? botComputerVmName(botId));
      await store.update((draft) => {
        delete draft.computers[botId];
      });
      runtimes.get(botId)?.cancelIdle?.();
      runtimes.delete(botId);
      stale.delete(botId);
      control.forget(botId);
      activity.set(botId, undefined);
      emit(botId);
    },

    async ensureRunning(botId, options) {
      if (shuttingDown) throw new BotComputerError("busy", "Aiden is quitting.");
      ensureSupported();
      const record = await requireRecord(botId);
      if (stale.has(botId)) {
        throw new BotComputerError("stale", `${await possessive(botId)} computer didn't finish being made. Reset it in the Bot's profile.`);
      }
      const entry = runtime(botId);
      if (entry.stopping) await entry.stopping;
      if (entry.state === "running" && entry.connection) {
        host.touch(botId);
        return entry.connection;
      }
      if (!entry.starting) {
        const controller = new AbortController();
        entry.startAbort = controller;
        const relay = () => controller.abort();
        options.signal?.addEventListener("abort", relay, { once: true });
        if (options.signal?.aborted) controller.abort();
        entry.starting = startComputer(botId, record, entry, {
          reason: options.reason,
          signal: controller.signal,
          onProgress: options.onProgress,
        }).finally(() => {
          options.signal?.removeEventListener("abort", relay);
          entry.starting = undefined;
          entry.startAbort = undefined;
        });
      }
      return entry.starting;
    },

    stop(botId, options) {
      return stopComputer(botId, options?.reason ?? "person");
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
        const ownedByRuntime = [...runtimes.values()].some((entry) => entry.connection?.vmName === info.name);
        if (info.state === "running" && !ownedByRuntime) {
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
