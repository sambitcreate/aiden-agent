import assert from "node:assert/strict";
import test from "node:test";

import {
  ANDROID_FOLD_RETRY_MS,
  ANDROID_FOLD_TIMEOUT_MS,
  androidFoldAngle,
  createAndroidFoldController,
  parseAndroidFold,
  requestAndroidFold,
  type AndroidFoldPosture,
  type AndroidFoldSnapshot,
  type AndroidFoldState,
} from "./device-fold";

const OPEN: AndroidFoldState = { supported: true, posture: "opened", hingeAngle: 180 };
const CLOSED: AndroidFoldState = { supported: true, posture: "closed", hingeAngle: 0 };

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimeout(callback: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) {
      timers.delete(timer as unknown as number);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = async () => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
};

function harness(options: { writeIgnoresAbort?: boolean } = {}) {
  const clock = fakeClock();
  const reads: Array<{ signal: AbortSignal; result: ReturnType<typeof deferred<AndroidFoldState>> }> = [];
  const writes: Array<{
    posture: AndroidFoldPosture;
    signal: AbortSignal;
    result: ReturnType<typeof deferred<AndroidFoldState>>;
  }> = [];
  const snapshots: AndroidFoldSnapshot[] = [];
  const controller = createAndroidFoldController({
    read: (signal) => {
      const result = deferred<AndroidFoldState>();
      reads.push({ signal, result });
      return result.promise;
    },
    write: (posture, signal) => {
      const result = deferred<AndroidFoldState>();
      writes.push({ posture, signal, result });
      // A write stuck minting its grant never sees the signal.
      if (!options.writeIgnoresAbort) signal.addEventListener("abort", () => result.reject(new Error("aborted")));
      return result.promise;
    },
    onChange: (snapshot) => snapshots.push(snapshot),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, reads, writes, snapshots, controller };
}

test("fold responses parse fail-closed, and the angle falls back on the posture", () => {
  assert.deepEqual(parseAndroidFold({ ok: true, fold: OPEN }), OPEN);
  assert.deepEqual(parseAndroidFold({ ok: true, fold: { supported: false, posture: null, hingeAngle: null } }), {
    supported: false,
    posture: null,
    hingeAngle: null,
  });
  for (const invalid of [
    null,
    { ok: false, fold: OPEN },
    { ok: true, fold: { ...OPEN, posture: "sideways" } },
    { ok: true, fold: { ...OPEN, hingeAngle: Number.NaN } },
    { ok: true, fold: { ...OPEN, supported: "yes" } },
  ]) {
    assert.throws(() => parseAndroidFold(invalid), /Unexpected Android fold response/u);
  }
  assert.equal(androidFoldAngle(null), null);
  assert.equal(androidFoldAngle({ supported: false, posture: null, hingeAngle: null }), null);
  assert.equal(androidFoldAngle({ supported: true, posture: "half_opened", hingeAngle: 90 }), 90);
  assert.equal(androidFoldAngle({ supported: true, posture: "closed", hingeAngle: null }), 0);
  assert.equal(androidFoldAngle({ supported: true, posture: null, hingeAngle: null }), 180);
});

test("fold requests go through the proxy with the grant, the device, and only a posture", async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const runtime = {
    fetch: async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      return url.includes("emulator-5556")
        ? new Response(JSON.stringify({ ok: false, error: "Selected emulator does not support folding" }), { status: 400 })
        : new Response(JSON.stringify({ ok: true, fold: CLOSED }), { status: 200 });
    },
  };
  const grant = { origin: "http://127.0.0.1:4100", token: "tok", expiresAt: Date.now() + 60_000 };
  const signal = new AbortController().signal;
  assert.deepEqual(await requestAndroidFold({ hostId: "local", deviceId: "emulator-5554", grant }, "closed", signal, runtime), CLOSED);
  await requestAndroidFold({ hostId: "peer:studio", deviceId: "emulator-5554", grant }, null, signal, runtime);
  assert.equal(calls[0]!.url, "http://127.0.0.1:4100/vendor/serve-emu/api/fold?device=emulator-5554&t=tok&host=local");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.body, JSON.stringify({ posture: "closed" }));
  assert.equal(calls[0]!.init.credentials, "omit");
  assert.equal(calls[1]!.init.method, "GET");
  assert.equal(calls[1]!.init.body, undefined);
  assert.match(calls[1]!.url, /host=peer%3Astudio/u);
  await assert.rejects(
    requestAndroidFold({ hostId: "local", deviceId: "emulator-5556", grant }, "closed", signal, runtime),
    /Selected emulator does not support folding/u,
  );
});

test("a failed read retries every 3 seconds until one lands, and pausing stops it", async () => {
  const h = harness();
  h.controller.watch();
  assert.equal(h.reads.length, 1);
  h.reads[0]!.result.reject(new Error("adb: device offline"));
  await tick();
  h.clock.advance(ANDROID_FOLD_RETRY_MS - 1);
  assert.equal(h.reads.length, 1);
  h.clock.advance(1);
  assert.equal(h.reads.length, 2);
  h.reads[1]!.result.resolve(OPEN);
  await tick();
  assert.deepEqual(h.controller.snapshot(), { fold: OPEN, angle: 180, pending: false, error: null });

  h.controller.watch();
  h.reads[2]!.result.reject(new Error("offline"));
  await tick();
  h.controller.pause();
  h.clock.advance(ANDROID_FOLD_RETRY_MS * 3);
  assert.equal(h.reads.length, 3, "a paused controller stops retrying");
});

test("a screen-size change re-reads and drops the stale read", async () => {
  const h = harness();
  h.controller.watch();
  // The fold restarted the encoder at a new size before the first read answered.
  h.controller.watch();
  assert.equal(h.reads[0]!.signal.aborted, true);
  h.reads[0]!.result.resolve(OPEN);
  h.reads[1]!.result.resolve(CLOSED);
  await tick();
  assert.deepEqual(h.controller.snapshot().fold, CLOSED);
  assert.ok(!h.snapshots.some((snapshot) => snapshot.fold === OPEN), "the stale answer is never shown");
});

test("folding moves the angle ahead of the device, then confirms and re-reads", async () => {
  const h = harness();
  h.controller.watch();
  h.reads[0]!.result.resolve(OPEN);
  await tick();
  const changing = h.controller.change("closed");
  assert.deepEqual(h.controller.snapshot(), { fold: OPEN, angle: 0, pending: true, error: null });
  // A second command while one is pending is ignored.
  await h.controller.change("opened");
  assert.equal(h.writes.length, 1);
  h.writes[0]!.result.resolve(CLOSED);
  await changing;
  assert.deepEqual(h.controller.snapshot(), { fold: CLOSED, angle: 0, pending: false, error: null });
  assert.equal(h.reads.length, 2, "the confirmed posture is read back");
  assert.equal(h.clock.pending(), 0, "the timeout is cleared");
});

test("a fold command times out after 12 seconds and restores the last known angle", async () => {
  const h = harness();
  h.controller.watch();
  h.reads[0]!.result.resolve(OPEN);
  await tick();
  const changing = h.controller.change("closed");
  h.clock.advance(ANDROID_FOLD_TIMEOUT_MS - 1);
  assert.equal(h.writes[0]!.signal.aborted, false);
  h.clock.advance(1);
  await changing;
  assert.deepEqual(h.controller.snapshot(), { fold: OPEN, angle: 180, pending: false, error: "Fold command timed out." });
});

test("the timeout also covers a command whose grant never arrives, and dispose aborts a command in flight", async () => {
  const h = harness({ writeIgnoresAbort: true });
  h.controller.watch();
  h.reads[0]!.result.resolve(OPEN);
  await tick();
  const changing = h.controller.change("closed");
  h.clock.advance(ANDROID_FOLD_TIMEOUT_MS);
  await changing;
  assert.deepEqual(h.controller.snapshot(), { fold: OPEN, angle: 180, pending: false, error: "Fold command timed out." });
  // The device can be folded again.
  h.reads[1]!.result.resolve(OPEN);
  await tick();
  const again = h.controller.change("closed");
  assert.equal(h.writes.length, 2);
  h.controller.dispose();
  assert.equal(h.writes[1]!.signal.aborted, true);
  await again;
  assert.equal(h.reads.length, 2, "a disposed controller never reads again");
});

test("a refused command keeps serve-emu's message, and an emulator without a hinge never writes", async () => {
  const h = harness();
  h.controller.watch();
  h.reads[0]!.result.resolve(OPEN);
  await tick();
  const changing = h.controller.change("closed");
  h.writes[0]!.result.reject(new Error("Emulator did not confirm closed posture"));
  await changing;
  assert.equal(h.controller.snapshot().error, "Emulator did not confirm closed posture");

  const flat = harness();
  flat.controller.watch();
  flat.reads[0]!.result.resolve({ supported: false, posture: null, hingeAngle: null });
  await tick();
  await flat.controller.change("closed");
  assert.equal(flat.writes.length, 0);
  assert.equal(flat.controller.snapshot().angle, null);
});
