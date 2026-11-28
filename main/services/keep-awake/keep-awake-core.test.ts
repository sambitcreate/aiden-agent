import assert from "node:assert/strict";
import test from "node:test";
import {
  KEEP_AWAKE_GRACE_MS,
  KEEP_AWAKE_IDLE_CAP_SECONDS,
  KEEP_AWAKE_IDLE_POLL_MS,
  KeepAwakeController,
  type KeepAwakeInput,
  type KeepAwakeReason,
} from "./keep-awake-core.js";
import type { KeepAwakeStatus } from "../../../renderer/shared/keep-awake.js";

/** A fake clock whose timers run only when the test advances time. */
function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
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

function harness(options: { enabled?: boolean } = {}) {
  const clock = fakeClock();
  const blocker = { started: 0, stopped: 0, active: new Set<number>() };
  let idle = 0;
  const statuses: KeepAwakeStatus[] = [];
  const controller = new KeepAwakeController<number, number>({
    blocker: {
      start: () => {
        blocker.started += 1;
        blocker.active.add(blocker.started);
        return blocker.started;
      },
      stop: (id) => {
        blocker.stopped += 1;
        blocker.active.delete(id);
      },
    },
    clock,
    idleSeconds: () => idle,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    onStatus: (status) => statuses.push(status),
  });
  let reasons: KeepAwakeReason[] = [];
  const input: KeepAwakeInput = { read: () => ({ reasons }) };
  controller.addInput(input);
  return {
    clock,
    blocker,
    controller,
    statuses,
    setIdle: (seconds: number) => {
      idle = seconds;
    },
    set(next: KeepAwakeReason[]) {
      reasons = next;
      controller.update();
    },
  };
}

const chat = (id: string): KeepAwakeReason => ({ kind: "chat", id });

test("one hold covers back-to-back runs, and the hold ends a minute after the last one", () => {
  const h = harness();
  assert.equal(h.blocker.active.size, 0, "nothing holds while nothing works");
  h.set([chat("a")]);
  assert.equal(h.blocker.active.size, 1);
  h.set([]);
  h.clock.advance(KEEP_AWAKE_GRACE_MS - 1);
  assert.equal(h.blocker.active.size, 1, "the hold survives the gap between runs");
  h.set([chat("b")]);
  h.set([]);
  h.clock.advance(KEEP_AWAKE_GRACE_MS - 1);
  assert.equal(h.blocker.active.size, 1);
  h.clock.advance(1);
  assert.equal(h.blocker.active.size, 0);
  assert.equal(h.blocker.started, 1, "back-to-back runs shared one blocker");
  assert.equal(h.statuses[h.statuses.length - 1]?.holding, false);
});

test("flapping inside the grace never restarts the hold or the grace", () => {
  const h = harness();
  h.set([chat("a")]);
  for (let i = 0; i < 5; i += 1) {
    h.set([]);
    h.clock.advance(10_000);
    h.set([chat("a")]);
  }
  assert.equal(h.blocker.started, 1);
  assert.equal(h.blocker.stopped, 0);
  // The grace starts over from the last end, not the first.
  h.set([]);
  h.clock.advance(KEEP_AWAKE_GRACE_MS - 1);
  assert.equal(h.blocker.active.size, 1);
  h.clock.advance(1);
  assert.equal(h.blocker.active.size, 0);
});

test("turning the switch off lets go at once, even mid-grace, and on again holds again", () => {
  const h = harness();
  h.set([chat("a")]);
  h.controller.setEnabled(false);
  assert.equal(h.blocker.active.size, 0, "off releases without waiting for the grace");
  assert.deepEqual(h.controller.status(), {
    supported: true,
    enabled: false,
    holding: false,
    pausedWhileIdle: false,
    counts: {},
  });
  h.controller.setEnabled(true);
  assert.equal(h.blocker.active.size, 1);

  h.set([]);
  h.controller.setEnabled(false);
  assert.equal(h.blocker.active.size, 0);
  assert.equal(h.clock.pending(), 0, "no grace or idle timer is left behind");
});

test("a switch that starts off never holds", () => {
  const h = harness({ enabled: false });
  h.set([chat("a"), { kind: "job", id: "job_1" }]);
  assert.equal(h.blocker.started, 0);
});

test("after 4 hours of idle time the hold lets go until someone comes back", () => {
  const h = harness();
  h.set([chat("a")]);
  h.setIdle(KEEP_AWAKE_IDLE_CAP_SECONDS - 30);
  h.clock.advance(KEEP_AWAKE_IDLE_POLL_MS);
  assert.equal(h.blocker.active.size, 1);
  h.setIdle(KEEP_AWAKE_IDLE_CAP_SECONDS);
  h.clock.advance(KEEP_AWAKE_IDLE_POLL_MS);
  assert.equal(h.blocker.active.size, 0, "idle past the cap releases without a grace");
  assert.equal(h.controller.status().pausedWhileIdle, true);
  assert.deepEqual(h.controller.status().counts, {});

  h.setIdle(5);
  h.clock.advance(KEEP_AWAKE_IDLE_POLL_MS);
  assert.equal(h.blocker.active.size, 1, "the person came back while work still runs");
  assert.equal(h.controller.status().pausedWhileIdle, false);
});

test("idle time is only watched while something wants the computer awake", () => {
  const h = harness();
  h.set([chat("a")]);
  h.set([]);
  h.clock.advance(KEEP_AWAKE_GRACE_MS);
  assert.equal(h.clock.pending(), 0);
});

test("status counts distinct things of each kind", () => {
  const h = harness();
  h.set([chat("a"), chat("a"), chat("b"), { kind: "job", id: "job_1" }]);
  assert.deepEqual(h.controller.status().counts, { chat: 2, job: 1 });
  assert.deepEqual(h.statuses[h.statuses.length - 1]?.counts, { chat: 2, job: 1 });
});

test("an input's recheck time re-reads it with no event, and a broken input holds nothing", () => {
  const h = harness();
  let soon = false;
  const dueAt = h.clock.now() + 5 * 60_000;
  h.controller.addInput({
    read: (now) =>
      now >= dueAt
        ? ((soon = true), { reasons: [{ kind: "usage-limit", id: "chat:a" }] })
        : { reasons: [], recheckAt: dueAt },
  });
  h.controller.addInput({
    read: () => {
      throw new Error("broken");
    },
  });
  assert.equal(h.blocker.active.size, 0);
  h.clock.advance(5 * 60_000);
  assert.equal(soon, true);
  assert.equal(h.blocker.active.size, 1);
});

test("disposing releases the hold and ignores later changes", () => {
  const h = harness();
  h.set([chat("a")]);
  h.controller.dispose();
  assert.equal(h.blocker.active.size, 0);
  h.set([chat("b")]);
  assert.equal(h.blocker.active.size, 0);
  assert.equal(h.clock.pending(), 0);
});

test("after 4 idle hours a due check-back or wake-up still holds; other work lets go", () => {
  const h = harness();
  h.setIdle(KEEP_AWAKE_IDLE_CAP_SECONDS);
  h.set([chat("a")]);
  assert.equal(h.blocker.active.size, 0, "a chat's work lets go when nobody is around");
  for (const kind of ["check-back", "wake-up"] as const) {
    h.set([chat("a"), { kind, id: `${kind}:1` }]);
    assert.equal(
      h.blocker.active.size,
      1,
      `a ${kind} due soon keeps the unattended computer awake`,
    );
    assert.equal(h.controller.status().pausedWhileIdle, false);
    h.set([chat("a")]);
    assert.equal(h.blocker.active.size, 0);
  }
});

test("a recheck time far ahead (or behind a clock jump) waits at most an hour, never firing at once", () => {
  const clock = fakeClock();
  let reads = 0;
  const controller = new KeepAwakeController<number, number>({
    blocker: { start: () => 1, stop: () => undefined },
    clock,
    idleSeconds: () => 0,
  });
  // Past 2^31-1 ms a plain timer would fire after 1 ms, again and again.
  controller.addInput({
    read: (now) => {
      reads += 1;
      return { reasons: [], recheckAt: now + 40 * 24 * 60 * 60_000 };
    },
  });
  const afterAdd = reads;
  clock.advance(59 * 60_000);
  assert.equal(reads, afterAdd, "no re-read inside the hour");
  clock.advance(60_000);
  assert.equal(reads, afterAdd + 1, "one hourly re-read");
  controller.dispose();
});

test("removing an input starts the grace period, releases after grace, and is idempotent", () => {
  const clock = fakeClock();
  const active = new Set<number>();
  let nextHandle = 1;
  const controller = new KeepAwakeController<number, number>({
    blocker: {
      start: () => {
        const id = nextHandle++;
        active.add(id);
        return id;
      },
      stop: (id) => {
        active.delete(id);
      },
    },
    clock,
    idleSeconds: () => 0,
  });
  const remove = controller.addInput({ read: () => ({ reasons: [chat("a")] }) });
  assert.equal(active.size, 1);
  remove();
  assert.equal(active.size, 1, "removing the last active input still honors grace");
  clock.advance(KEEP_AWAKE_GRACE_MS - 1);
  assert.equal(active.size, 1);
  // A second removal is a safe no-op and does not reset grace.
  remove();
  clock.advance(1);
  assert.equal(active.size, 0);
  assert.equal(clock.pending(), 0);
});

test("a past recheckAt waits at least a second rather than spinning, and grace is not reset by idle rechecks", () => {
  const clock = fakeClock();
  let reads = 0;
  let reasons: KeepAwakeReason[] = [chat("a")];
  let recheckAt: number | undefined;
  const active = new Set<number>();
  const controller = new KeepAwakeController<number, number>({
    blocker: {
      start: () => {
        active.add(1);
        return 1;
      },
      stop: (id) => {
        active.delete(id);
      },
    },
    clock,
    idleSeconds: () => 0,
  });
  controller.addInput({
    read: () => {
      reads += 1;
      return { reasons, ...(recheckAt === undefined ? {} : { recheckAt }) };
    },
  });
  // Enter grace with a past recheckAt (already due).
  reasons = [];
  recheckAt = clock.now() - 5_000;
  controller.update();
  const afterUpdate = reads;
  clock.advance(999);
  assert.equal(reads, afterUpdate, "past recheckAt is floored to 1,000 ms");
  clock.advance(1);
  assert.equal(reads, afterUpdate + 1, "fires once after the 1,000 ms floor");
  recheckAt = undefined;
  // Grace still ends at KEEP_AWAKE_GRACE_MS from when work ended, not from the recheck.
  clock.advance(KEEP_AWAKE_GRACE_MS - 1_001);
  assert.equal(active.size, 1);
  clock.advance(1);
  assert.equal(active.size, 0);
  assert.equal(clock.pending(), 0);
});

test("pausedWhileIdle clears cleanly without grace when work ends, and mid-grace idle-capped work releases at once", () => {
  const h = harness();
  h.setIdle(KEEP_AWAKE_IDLE_CAP_SECONDS);
  h.set([chat("a")]);
  assert.equal(h.blocker.active.size, 0);
  assert.equal(h.controller.status().pausedWhileIdle, true);

  // All work ends while pausedWhileIdle: no grace timer or idle timer remains.
  h.set([]);
  assert.equal(h.controller.status().pausedWhileIdle, false);
  assert.equal(h.clock.pending(), 0);

  // Hold while active, enter grace, then idle past the cap before non-exempt work arrives.
  h.setIdle(0);
  h.set([chat("b")]);
  assert.equal(h.blocker.active.size, 1);
  h.set([]);
  assert.equal(h.blocker.active.size, 1, "in grace");
  h.setIdle(KEEP_AWAKE_IDLE_CAP_SECONDS);
  h.set([chat("c")]);
  assert.equal(h.blocker.active.size, 0, "idle-capped work cancels grace and releases immediately");
  assert.equal(h.controller.status().pausedWhileIdle, true);
});

test("blocker, idleSeconds, and onStatus errors are isolated via onError without leaking state", () => {
  const clock = fakeClock();
  const errors: unknown[] = [];
  let failStart = true;
  let failStop = false;
  let idleMode: "throw" | "nan" | "normal" = "throw";
  let failStatus = true;
  const active = new Set<number>();
  const controller = new KeepAwakeController<number, number>({
    blocker: {
      start: () => {
        if (failStart) throw new Error("start failed");
        active.add(1);
        return 1;
      },
      stop: (id) => {
        active.delete(id);
        if (failStop) throw new Error("stop failed");
      },
    },
    clock,
    idleSeconds: () => {
      if (idleMode === "throw") throw new Error("idle failed");
      if (idleMode === "nan") return Number.NaN;
      return 0;
    },
    onStatus: () => {
      if (failStatus) throw new Error("status failed");
    },
    onError: (error) => errors.push(error),
  });
  let reasons: KeepAwakeReason[] = [chat("a")];
  controller.addInput({ read: () => ({ reasons }) });
  assert.equal(controller.status().holding, false, "failed start leaves holding false");
  assert.deepEqual(
    errors.map((error) => (error instanceof Error ? error.message : String(error))),
    ["idle failed", "start failed", "status failed"],
    "idleSeconds, start, and onStatus errors are each reported",
  );

  // Non-finite idleSeconds falls back to 0 rather than triggering the idle cap.
  failStart = false;
  failStatus = false;
  idleMode = "nan";
  controller.update();
  assert.equal(controller.status().holding, true);
  assert.equal(active.size, 1);

  // Failed stop still clears the handle so status reflects release.
  failStop = true;
  idleMode = "normal";
  reasons = [];
  controller.setEnabled(false);
  assert.equal(controller.status().holding, false);
  assert.equal(active.size, 0);
  assert.deepEqual(
    errors.map((error) => (error instanceof Error ? error.message : String(error))),
    ["idle failed", "start failed", "status failed", "stop failed"],
    "stop error is also reported",
  );
  controller.dispose();
});
