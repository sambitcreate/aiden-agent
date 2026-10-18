import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import test from "node:test";
import type { DeviceRecordingInfo } from "../../../renderer/shared/device-features.js";
import { createDeviceRecorder, type DeviceRecordingRemote, type RecorderChild } from "./device-recording.js";

const UDID = "5C1E4B7A-0000-4000-8000-000000000001";

/** A recorder child that finalizes its file on SIGINT, unless told to hang. */
class FakeChild implements RecorderChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  constructor(
    private readonly onSignal: (child: FakeChild, signal: NodeJS.Signals) => void,
  ) {}
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    this.onSignal(this, signal);
    return true;
  }
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit" | "error", listener: unknown) {
    if (event === "exit") {
      this.exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    } else {
      this.errorListeners.push(listener as (error: Error) => void);
    }
    return this;
  }
  /** Node reports a spawn failure as `error` with the errno in `exitCode`; `exit` never follows. */
  failToSpawn(error: Error, errno = -2) {
    this.exitCode = errno;
    for (const listener of this.errorListeners.splice(0)) listener(error);
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    for (const listener of this.exitListeners.splice(0)) listener(code, signal);
  }
}

function harness(
  options: { hangOnSigint?: boolean; maxDurationMs?: number; tempDir?: () => Promise<string> } = {},
) {
  let now = 1_000;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const files = new Map<string, number>();
  const removed: string[] = [];
  const spawned: Array<{ command: string; args: readonly string[]; child: FakeChild }> = [];
  const changes: DeviceRecordingInfo[][] = [];
  let ids = 0;
  const recorder = createDeviceRecorder({
    spawn: (command, args) => {
      const file = args[args.length - 1]!;
      const child = new FakeChild((self, signal) => {
        if (signal === "SIGINT" && options.hangOnSigint) return;
        if (signal === "SIGINT") files.set(file, 2048);
        // simctl finalizes asynchronously after the signal.
        queueMicrotask(() => self.exit(signal === "SIGKILL" ? null : 0, signal === "SIGKILL" ? "SIGKILL" : null));
      });
      spawned.push({ command, args, child });
      return child;
    },
    tempDir: options.tempDir ?? (async () => "/private/recordings"),
    fileSize: async (file) => files.get(file) ?? null,
    removeFile: async (file) => {
      removed.push(file);
      files.delete(file);
    },
    newId: () => `recording-${String(++ids).padStart(4, "0")}`,
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as unknown as number);
    },
    maxDurationMs: options.maxDurationMs ?? 600_000,
    stopTimeoutMs: 15_000,
  });
  recorder.onChange((list) => changes.push(list));
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = end;
  };
  return { recorder, spawned, files, removed, changes, advance, pendingTimers: () => timers.size };
}

const start = (h: ReturnType<typeof harness>, chatId = "chat-1", deviceId = UDID) =>
  h.recorder.start({
    chatId,
    platform: "ios",
    hostId: "local",
    deviceId,
    command: (file) => ({ command: "xcrun", args: ["simctl", "io", deviceId, "recordVideo", "--codec=h264", file] }),
  });

/** An emulator recording: `remote` stands in for the adb stop, pull, and delete steps. */
const startAndroid = (
  h: ReturnType<typeof harness>,
  remote: (child: () => FakeChild) => DeviceRecordingRemote,
  chatId = "chat-1",
) =>
  h.recorder.start({
    chatId,
    platform: "android",
    hostId: "local",
    deviceId: "emulator-5554",
    command: (_file, id) => ({
      command: "adb",
      args: ["-s", "emulator-5554", "shell", "screenrecord", `/sdcard/aiden-rec-${id}.mp4`],
    }),
    remote: () => remote(() => h.spawned[h.spawned.length - 1]!.child),
  });

const settle = async () => {
  for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
};

test("a recording starts one supervised child and stops with SIGINT into a finished file", async () => {
  const h = harness();
  const started = await start(h);
  assert.equal(started.status, "recording");
  assert.equal(started.endsBy, started.startedAt + 600_000);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.spawned[0]!.args.slice(0, 5), ["simctl", "io", UDID, "recordVideo", "--codec=h264"]);
  assert.equal(h.spawned[0]!.args[h.spawned[0]!.args.length - 1], "/private/recordings/recording-0001.mp4");

  await assert.rejects(start(h), /already being recorded/u, "one recorder per simulator");

  h.advance(5_000);
  const stopped = await h.recorder.stop(started.id);
  assert.deepEqual(h.spawned[0]!.child.signals, ["SIGINT"]);
  assert.equal(stopped.status, "ready");
  assert.equal(stopped.reason, "user");
  assert.equal(stopped.stoppedAt, started.startedAt + 5_000);
  assert.equal(h.pendingTimers(), 0, "the duration cap and kill timers are cleared");
  assert.ok(h.changes.some((list) => list[0]?.status === "stopping"), "listeners see the stopping state");

  const taken = h.recorder.take(started.id);
  assert.equal(taken?.file, "/private/recordings/recording-0001.mp4");
  assert.deepEqual(h.recorder.list(), [], "a taken recording leaves the list");
  // A new recording of the same simulator can start once the first finished.
  assert.equal((await start(h)).status, "recording");
});

test("the duration cap stops a recording by itself", async () => {
  const h = harness({ maxDurationMs: 600_000 });
  const started = await start(h);
  h.advance(599_999);
  assert.equal(h.recorder.get(started.id)?.status, "recording");
  h.advance(1);
  assert.deepEqual(h.spawned[0]!.child.signals, ["SIGINT"]);
  await settle();
  const info = h.recorder.get(started.id);
  assert.equal(info?.status, "ready");
  assert.equal(info?.reason, "max-duration");
});

test("a recorder that ignores SIGINT is killed and its recording fails", async () => {
  const h = harness({ hangOnSigint: true });
  const started = await start(h);
  const stopping = h.recorder.stop(started.id);
  await settle();
  assert.equal(h.recorder.get(started.id)?.status, "stopping");
  h.advance(15_000);
  const info = await stopping;
  assert.deepEqual(h.spawned[0]!.child.signals, ["SIGINT", "SIGKILL"]);
  assert.equal(info.status, "failed");
  assert.match(info.error ?? "", /did not finish writing/u);
});

test("a recorder that exits by itself settles, and an empty file fails", async () => {
  const h = harness();
  const started = await start(h);
  h.spawned[0]!.child.exit(1);
  await settle();
  const info = h.recorder.get(started.id);
  assert.equal(info?.status, "failed");
  assert.equal(info?.reason, "exited");
  assert.match(info?.error ?? "", /exit code 1/u);
  assert.equal(h.recorder.take(started.id), null, "only a ready recording can be taken");
});

test("a child that fails to spawn fails its recording instead of wedging stop and discard", async () => {
  const h = harness();
  const started = await start(h);
  h.spawned[0]!.child.failToSpawn(Object.assign(new Error("spawn xcrun ENOENT"), { code: "ENOENT" }));
  await settle();
  const info = h.recorder.get(started.id);
  assert.equal(info?.status, "failed");
  assert.equal(info?.reason, "exited");
  assert.equal(h.recorder.take(started.id), null);
  const timeout = () => new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200));
  assert.notEqual(await Promise.race([h.recorder.stop(started.id), timeout()]), "timeout", "stop returns");
  assert.notEqual(await Promise.race([h.recorder.discardWhere(() => true), timeout()]), "timeout", "discard returns");
  assert.deepEqual(h.recorder.list(), []);
  assert.equal(h.pendingTimers(), 0);
});

test("a recorder binary that cannot be spawned fails its recording on a real child process", async () => {
  const removed: string[] = [];
  const recorder = createDeviceRecorder({
    spawn: (command, args) => nodeSpawn(command, [...args], { stdio: "ignore", detached: false }),
    tempDir: async () => "/private/recordings",
    fileSize: async () => null,
    removeFile: async (file) => {
      removed.push(file);
    },
    newId: () => "recording-0001",
    now: () => 1_000,
    setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
    clearTimeout: (timer) => clearTimeout(timer),
  });
  const started = await recorder.start({
    chatId: "chat-1",
    platform: "ios",
    hostId: "local",
    deviceId: UDID,
    command: (file) => ({ command: "/nonexistent/aiden-test/xcrun", args: ["simctl", "io", UDID, "recordVideo", file] }),
  });
  const failed = await new Promise<DeviceRecordingInfo | null>((resolve) => {
    const unsubscribe = recorder.onChange((list) => {
      if (list[0]?.status !== "failed") return;
      unsubscribe();
      resolve(list[0]);
    });
    setTimeout(() => resolve(recorder.get(started.id)), 2_000).unref();
  });
  assert.equal(failed?.status, "failed");
  await recorder.discardWhere(() => true);
  assert.deepEqual(recorder.list(), []);
  assert.deepEqual(removed, ["/private/recordings/recording-0001.mp4"]);
});

test("an emulator recording whose pull fails is not offered as a finished file", async () => {
  const h = harness();
  const steps: string[] = [];
  let local = "";
  const started = await startAndroid(h, (child) => ({
    async stop() {
      steps.push("stop");
      queueMicrotask(() => child().exit(0));
    },
    async collect(file) {
      steps.push("collect");
      local = file;
      // The pull wrote part of the file before the emulator went away.
      h.files.set(file, 1234);
      throw new Error("adb: error: failed to copy");
    },
    async cleanup() {
      steps.push("cleanup");
    },
  }));
  const stopped = await h.recorder.stop(started.id);
  assert.equal(stopped.status, "failed");
  assert.match(stopped.error ?? "", /could not be copied from the emulator/u);
  assert.equal(h.recorder.take(started.id), null, "a partial pull can never be saved");
  assert.equal(h.files.has(local), false, "the partial temp file is deleted");
  assert.deepEqual(steps, ["stop", "collect", "cleanup"]);
});

test("an emulator recording whose on-device stop was never confirmed fails instead of saving an unfinished file", async () => {
  const h = harness();
  const steps: string[] = [];
  let local = "";
  const started = await startAndroid(h, () => ({
    async stop() {
      steps.push("stop");
      throw new Error("adb: device offline");
    },
    async collect(file) {
      steps.push("collect");
      local = file;
      h.files.set(file, 4096);
    },
    async cleanup() {
      steps.push("cleanup");
    },
  }));
  const stopped = await h.recorder.stop(started.id);
  assert.deepEqual(h.spawned[0]!.child.signals, ["SIGINT"], "the local adb is signalled as a fallback");
  assert.equal(stopped.status, "failed");
  assert.match(stopped.error ?? "", /did not finish writing/u);
  assert.equal(h.recorder.take(started.id), null);
  assert.equal(local === "" || !h.files.has(local), true, "no unfinished copy is left behind");
  assert.ok(steps.includes("cleanup"), "the device copy is still deleted");
  assert.equal(h.pendingTimers(), 0);
});

test("a start still preparing its temp file when its chat is discarded never spawns a recorder", async () => {
  let release!: () => void;
  const prepared = new Promise<void>((resolve) => (release = resolve));
  const h = harness({ tempDir: () => prepared.then(() => "/private/recordings") });
  const deleted = start(h, "chat-1", UDID);
  const other = start(h, "chat-2", "5C1E4B7A-0000-4000-8000-000000000002");
  await settle();
  await h.recorder.discardWhere((info) => info.chatId === "chat-1");
  release();
  await assert.rejects(deleted, /cancelled/u);
  assert.equal((await other).status, "recording", "another chat's start goes ahead");
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(
    h.recorder.list().map((info) => info.chatId),
    ["chat-2"],
  );
  assert.equal((await start(h, "chat-3", UDID)).status, "recording", "the simulator is free again");
  await h.recorder.discardWhere(() => true);
  assert.equal(h.pendingTimers(), 0);
});

test("discarding stops a running recorder and deletes its file, by id or by chat", async () => {
  const h = harness();
  const first = await start(h, "chat-1", UDID);
  const second = await start(h, "chat-2", "5C1E4B7A-0000-4000-8000-000000000002");
  await h.recorder.discardWhere((info) => info.chatId === "chat-1");
  assert.deepEqual(h.spawned[0]!.child.signals, ["SIGINT"]);
  assert.deepEqual(h.removed, ["/private/recordings/recording-0001.mp4"]);
  assert.deepEqual(
    h.recorder.list().map((info) => info.id),
    [second.id],
  );
  await h.recorder.discard(second.id);
  assert.equal(h.recorder.get(first.id), null);
  assert.deepEqual(h.recorder.list(), []);
  assert.equal(h.removed.length, 2);
  assert.equal(h.pendingTimers(), 0);
});
