/**
 * Supervised device screen recordings.
 *
 * iOS: one `simctl io recordVideo` child writes a private temp file. Stopping
 * sends SIGINT, which makes simctl finalize the MP4.
 *
 * Android: one `adb shell screenrecord` child writes the MP4 on the emulator.
 * Its `remote` hooks stop it there so the file finalizes, pull it into the
 * temp file once the child exits, and delete the emulator's copy on every
 * exit path.
 *
 * A child that ignores the stop is killed and its recording fails. A
 * recording that reaches its duration cap stops by itself. Nothing here shows
 * UI: the caller moves a finished file to where the user chose, or discards it.
 */
import path from "node:path";
import {
  DEVICE_RECORDING_MAX_MS,
  type DeviceRecordingInfo,
  type DeviceRecordingStopReason,
} from "../../../renderer/shared/device-features.js";
import type { DevicePlatform } from "../../../renderer/shared/devices.js";

/** Long enough for simctl to write the MP4 trailer of a ten-minute recording. */
export const DEVICE_RECORDING_STOP_TIMEOUT_MS = 15_000;

/** The subset of `ChildProcess` the recorder relies on, so tests can pass a fake. */
export interface RecorderChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

type Timer = ReturnType<typeof setTimeout>;

export interface DeviceRecorderDeps {
  /** `env` replaces the inherited environment, e.g. to put the Android SDK on PATH. */
  spawn(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): RecorderChild;
  /** A private directory for in-progress recordings; created on demand. */
  tempDir(): Promise<string>;
  /** Byte size of a finished file, or null when it was never written. */
  fileSize(file: string): Promise<number | null>;
  removeFile(file: string): Promise<void>;
  newId(): string;
  now(): number;
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  maxDurationMs?: number;
  stopTimeoutMs?: number;
}

export interface DeviceRecordingStart {
  chatId: string;
  platform: DevicePlatform;
  hostId: string;
  deviceId: string;
  /** The recorder argv for this recording's id and the temp file the recorder chose. */
  command(file: string, id: string): { command: string; args: string[] };
  /** The environment the child runs with; the inherited one when absent. */
  env?: NodeJS.ProcessEnv;
  /** Overrides the default cap for platforms with a shorter one. */
  maxDurationMs?: number;
  /** For a recorder that writes on the device rather than into `file`. */
  remote?(id: string): DeviceRecordingRemote;
}

/** Hooks for a recorder whose file lives on the device until it is pulled. */
export interface DeviceRecordingRemote {
  /** Asks the device's recorder to finalize; the child exits once it has. */
  stop(): Promise<void>;
  /** Copies the finished recording into the local temp file. */
  collect(file: string): Promise<void>;
  /** Deletes the device's copy. Runs once, whatever happened. */
  cleanup(): Promise<void>;
}

interface Entry {
  info: DeviceRecordingInfo;
  file: string;
  child: RecorderChild | null;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  capTimer: Timer | null;
  stopping: Promise<DeviceRecordingInfo> | null;
  /** A recorder that exited by itself, still copying or checking its file. */
  settling: Promise<DeviceRecordingInfo> | null;
  remote: DeviceRecordingRemote | null;
  /** The device copy was deleted (or there never was one). */
  cleaned: boolean;
}

export interface DeviceRecorder {
  start(input: DeviceRecordingStart): Promise<DeviceRecordingInfo>;
  /** Stops with SIGINT and waits for the file to be finalized. Stopping a finished recording returns it. */
  stop(id: string, reason?: DeviceRecordingStopReason): Promise<DeviceRecordingInfo>;
  /** A finished recording's temp file, for the caller to move. Removes it from the list. */
  take(id: string): { info: DeviceRecordingInfo; file: string } | null;
  /** Stops if needed and deletes the temp file. */
  discard(id: string): Promise<void>;
  discardWhere(match: (info: DeviceRecordingInfo) => boolean): Promise<void>;
  list(): DeviceRecordingInfo[];
  get(id: string): DeviceRecordingInfo | null;
  onChange(listener: (recordings: DeviceRecordingInfo[]) => void): () => void;
}

export function createDeviceRecorder(deps: DeviceRecorderDeps): DeviceRecorder {
  const maxDurationMs = deps.maxDurationMs ?? DEVICE_RECORDING_MAX_MS;
  const stopTimeoutMs = deps.stopTimeoutMs ?? DEVICE_RECORDING_STOP_TIMEOUT_MS;
  const entries = new Map<string, Entry>();
  const listeners = new Set<(recordings: DeviceRecordingInfo[]) => void>();
  /** Device keys with a start in flight, so two clicks never spawn two recorders. */
  const starting = new Set<string>();

  const list = () => [...entries.values()].map((entry) => ({ ...entry.info }));
  const emit = () => {
    const snapshot = list();
    for (const listener of listeners) listener(snapshot);
  };
  const deviceKey = (input: { hostId: string; deviceId: string }) => JSON.stringify([input.hostId, input.deviceId]);

  const update = (entry: Entry, next: Partial<DeviceRecordingInfo>) => {
    entry.info = { ...entry.info, ...next };
    if (entries.get(entry.info.id) === entry) emit();
  };

  /** Deletes the device's copy once, whatever happened to the recording. */
  const cleanupRemote = async (entry: Entry) => {
    if (entry.cleaned || !entry.remote) return;
    entry.cleaned = true;
    await entry.remote.cleanup().catch(() => undefined);
  };

  /** A child that exits on its own (the device shut down, or the recorder failed) settles its recording. */
  const settle = async (entry: Entry, reason: DeviceRecordingStopReason): Promise<DeviceRecordingInfo> => {
    const { code } = await entry.exited;
    if (entry.capTimer) deps.clearTimeout(entry.capTimer);
    entry.capTimer = null;
    entry.child = null;
    let collectFailed = false;
    if (entry.remote) {
      try {
        await entry.remote.collect(entry.file);
      } catch {
        collectFailed = true;
      }
      await cleanupRemote(entry);
    }
    const size = await deps.fileSize(entry.file).catch(() => null);
    const stoppedAt = entry.info.stoppedAt ?? deps.now();
    if (size && size > 0 && (code === 0 || reason !== "exited")) {
      update(entry, { status: "ready", stoppedAt, reason });
    } else {
      update(entry, {
        status: "failed",
        stoppedAt,
        reason,
        error:
          code !== null && code !== 0 && reason === "exited"
            ? `The device stopped recording (exit code ${code}).`
            : collectFailed
              ? "The recording could not be copied from the emulator."
              : "The recording is empty.",
      });
    }
    return { ...entry.info };
  };

  const stopEntry = (entry: Entry, reason: DeviceRecordingStopReason): Promise<DeviceRecordingInfo> => {
    if (entry.stopping) return entry.stopping;
    if (entry.info.status !== "recording" || !entry.child) return Promise.resolve({ ...entry.info });
    const child = entry.child;
    update(entry, { status: "stopping", stoppedAt: deps.now(), reason });
    entry.stopping = (async () => {
      let killTimer: Timer | null = deps.setTimeout(() => {
        killTimer = null;
        child.kill("SIGKILL");
      }, stopTimeoutMs);
      if (entry.remote) {
        // The device's recorder finalizes its file; signalling the local adb would not wait for that.
        void entry.remote.stop().catch(() => child.kill("SIGINT"));
      } else {
        child.kill("SIGINT");
      }
      await entry.exited;
      const killed = killTimer === null;
      if (killTimer) deps.clearTimeout(killTimer);
      if (killed) {
        if (entry.capTimer) deps.clearTimeout(entry.capTimer);
        entry.capTimer = null;
        entry.child = null;
        await cleanupRemote(entry);
        update(entry, { status: "failed", error: "The recording did not finish writing in time." });
        return { ...entry.info };
      }
      return settle(entry, reason);
    })();
    return entry.stopping;
  };

  const removeEntry = async (entry: Entry) => {
    if (entry.child) await stopEntry(entry, "user").catch(() => undefined);
    else if (entry.stopping) await entry.stopping.catch(() => undefined);
    else if (entry.settling) await entry.settling.catch(() => undefined);
    if (entries.get(entry.info.id) === entry) {
      entries.delete(entry.info.id);
      emit();
    }
    await cleanupRemote(entry);
    await deps.removeFile(entry.file).catch(() => undefined);
  };

  return {
    async start(input) {
      const key = deviceKey(input);
      const busy = [...entries.values()].some(
        (entry) =>
          deviceKey(entry.info) === key && (entry.info.status === "recording" || entry.info.status === "stopping"),
      );
      if (busy || starting.has(key)) throw new Error("This simulator is already being recorded.");
      starting.add(key);
      try {
        const id = deps.newId();
        const directory = await deps.tempDir();
        const file = path.join(directory, `${id}.mp4`);
        const { command, args } = input.command(file, id);
        const remote = input.remote?.(id) ?? null;
        const cap = input.maxDurationMs ?? maxDurationMs;
        const child = deps.spawn(command, args, input.env);
        const startedAt = deps.now();
        let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          resolveExit = resolve;
        });
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveExit({ code: child.exitCode, signal: child.signalCode });
        } else {
          child.once("exit", (code, signal) => resolveExit({ code, signal }));
        }
        const entry: Entry = {
          info: {
            id,
            chatId: input.chatId,
            platform: input.platform,
            hostId: input.hostId,
            deviceId: input.deviceId,
            status: "recording",
            startedAt,
            endsBy: startedAt + cap,
          },
          file,
          child,
          exited,
          capTimer: null,
          stopping: null,
          settling: null,
          remote,
          cleaned: remote === null,
        };
        entry.capTimer = deps.setTimeout(() => {
          entry.capTimer = null;
          void stopEntry(entry, "max-duration");
        }, cap);
        entries.set(id, entry);
        void exited.then(() => {
          // Only an exit nobody asked for settles here; stop() settles its own.
          if (entry.info.status === "recording" && !entry.stopping) entry.settling = settle(entry, "exited");
        });
        emit();
        return { ...entry.info };
      } finally {
        starting.delete(key);
      }
    },
    async stop(id, reason = "user") {
      const entry = entries.get(id);
      if (!entry) throw new Error("That recording is no longer available.");
      return stopEntry(entry, reason);
    },
    take(id) {
      const entry = entries.get(id);
      if (!entry || entry.info.status !== "ready") return null;
      entries.delete(id);
      emit();
      return { info: { ...entry.info }, file: entry.file };
    },
    async discard(id) {
      const entry = entries.get(id);
      if (entry) await removeEntry(entry);
    },
    async discardWhere(match) {
      await Promise.all([...entries.values()].filter((entry) => match(entry.info)).map(removeEntry));
    },
    list,
    get: (id) => {
      const entry = entries.get(id);
      return entry ? { ...entry.info } : null;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
