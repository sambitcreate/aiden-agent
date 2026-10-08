import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceRecordingInfo } from "../../../renderer/shared/device-features.js";
import { createDeviceRecorder, type RecorderChild } from "./device-recording.js";

const UDID = "5C1E4B7A-0000-4000-8000-000000000001";

/** A recorder child that finalizes its file on SIGINT, unless told to hang. */
class FakeChild implements RecorderChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  constructor(
    private readonly onSignal: (child: FakeChild, signal: NodeJS.Signals) => void,
  ) {}
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    this.onSignal(this, signal);
    return true;
  }
  once(_event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
    this.exitListeners.push(listener);
    return this;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    for (const listener of this.exitListeners.splice(0)) listener(code, signal);
  }
}

function harness(options: { hangOnSigint?: boolean; maxDurationMs?: number } = {}) {
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
    tempDir: async () => "/private/recordings",
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
