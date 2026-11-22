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
    clearTimeout: (id: number) => { timers.delete(id); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
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
    setIdle: (seconds: number) => { idle = seconds; },
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
  assert.deepEqual(h.controller.status(), { supported: true, enabled: false, holding: false, pausedWhileIdle: false, counts: {} });
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
    read: (now) => (now >= dueAt ? (soon = true, { reasons: [{ kind: "usage-limit", id: "chat:a" }] }) : { reasons: [], recheckAt: dueAt }),
  });
  h.controller.addInput({ read: () => { throw new Error("broken"); } });
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
