import assert from "node:assert/strict";
import test from "node:test";
import {
  KEEP_AWAKE_USAGE_LIMIT_WINDOW_MS,
  backgroundJobKeepAwakeInput,
  doneWhenKeepAwakeInput,
  dueSoonKeepAwakeInput,
  type KeepAwakeDue,
  hostRunKeepAwakeInput,
  usageLimitKeepAwakeInput,
  type KeepAwakeUsageLimitWait,
} from "./keep-awake-inputs.js";
import { HostRunRegistry } from "../host-run-registry.js";
import { KeepAwakeController } from "./keep-awake-core.js";

const NOW = 5_000_000;
const minutes = (count: number) => count * 60_000;

test("a working run holds; a run waiting on an approval or a question doesn't", () => {
  const registry = new HostRunRegistry({ now: () => NOW });
  const input = hostRunKeepAwakeInput({ runs: () => registry.list(), waits: () => [] });
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  assert.deepEqual(input.read(NOW).reasons, [{ kind: "chat", id: "chat-1" }]);

  for (const state of ["needs_approval", "needs_input", "done", "failed", "cancelled"]) {
    const fixed = hostRunKeepAwakeInput({ runs: () => [{ chatId: "chat-2", state }], waits: () => [] });
    assert.deepEqual(fixed.read(NOW).reasons, [], state);
  }
});

test("a run waiting on a usage limit far away doesn't hold until the last 10 minutes", () => {
  let waits: KeepAwakeUsageLimitWait[] = [{ owner: { kind: "chat", id: "chat-1" }, nextTryAt: NOW + minutes(45) }];
  const runs = hostRunKeepAwakeInput({ runs: () => [{ chatId: "chat-1", state: "working" }], waits: () => waits });
  const limits = usageLimitKeepAwakeInput(() => waits);

  const far = runs.read(NOW);
  assert.deepEqual(far.reasons, []);
  assert.equal(far.recheckAt, NOW + minutes(35));
  assert.deepEqual(limits.read(NOW).reasons, []);
  assert.equal(limits.read(NOW).recheckAt, NOW + minutes(35));

  const later = NOW + minutes(35);
  assert.deepEqual(runs.read(later).reasons, [{ kind: "chat", id: "chat-1" }]);
  assert.deepEqual(limits.read(later).reasons, [{ kind: "usage-limit", id: "chat:chat-1" }]);

  // A Bot's wait ending soon holds too; it never hides an ordinary chat's run.
  waits = [{ owner: { kind: "bot", id: "chat-1" }, nextTryAt: NOW + KEEP_AWAKE_USAGE_LIMIT_WINDOW_MS }];
  assert.deepEqual(runs.read(NOW).reasons, [{ kind: "chat", id: "chat-1" }]);
  assert.deepEqual(limits.read(NOW).reasons, [{ kind: "usage-limit", id: "bot:chat-1" }]);
});

test("a build job holds; a server, a finished job and a leftover background process don't", () => {
  const input = backgroundJobKeepAwakeInput(() => [
    { id: "job_build", state: "running" },
    { id: "job_tests", state: "running", ports: [] },
    { id: "job_server", state: "running", ports: [5173] },
    { id: "job_done", state: "exited" },
    { id: "job_leftover", state: "running", origin: "command" },
  ]);
  assert.deepEqual(input.read(NOW).reasons, [
    { kind: "job", id: "job_build" },
    { kind: "job", id: "job_tests" },
  ]);
});

test("a done-when check holds only while its command runs", () => {
  const input = doneWhenKeepAwakeInput(() => [
    { chatId: "chat-1", state: "running" },
    { chatId: "chat-2", state: "waiting" },
    { chatId: "chat-3", state: "passed" },
  ]);
  assert.deepEqual(input.read(NOW).reasons, [{ kind: "check", id: "chat-1" }]);
});

test("a check-back or Bot wake-up due within the hour holds on AC power; one later doesn't, until its hour starts", () => {
  const checkBacks: KeepAwakeDue[] = [
    { id: "cb_soon", fireAt: NOW + minutes(59) },
    { id: "cb_later", fireAt: NOW + minutes(61) },
  ];
  const wakeUps: KeepAwakeDue[] = [
    { id: "wake_soon", fireAt: NOW + minutes(20) },
    { id: "wake_tomorrow", fireAt: NOW + minutes(24 * 60) },
  ];
  const input = dueSoonKeepAwakeInput({ checkBacks: () => checkBacks, wakeUps: () => wakeUps, onBattery: () => false });

  const reading = input.read(NOW);
  assert.deepEqual(reading.reasons, [
    { kind: "check-back", id: "cb_soon" },
    { kind: "wake-up", id: "wake_soon" },
  ]);
  // Read again no later than when the 61-minute check-back enters its hour.
  assert.ok(reading.recheckAt !== undefined && reading.recheckAt <= NOW + minutes(1));

  assert.deepEqual(input.read(NOW + minutes(1)).reasons.map((reason) => reason.id), ["cb_soon", "cb_later", "wake_soon"]);
});

test("on battery nothing due soon holds, and the power source is read again while something is due", () => {
  let onBattery = true;
  const input = dueSoonKeepAwakeInput({
    checkBacks: () => [{ id: "cb_soon", fireAt: NOW + minutes(30) }],
    wakeUps: () => [{ id: "wake_soon", fireAt: NOW + minutes(10) }],
    onBattery: () => onBattery,
  });
  const unplugged = input.read(NOW);
  assert.deepEqual(unplugged.reasons, []);
  // A host that sends no power events still notices being plugged in within minutes.
  assert.ok(unplugged.recheckAt !== undefined && unplugged.recheckAt <= NOW + minutes(5));

  onBattery = false;
  assert.equal(input.read(NOW).reasons.length, 2);
});

test("nothing pending (or only something far ahead) holds nothing, even on AC", () => {
  const empty = dueSoonKeepAwakeInput({ checkBacks: () => [], wakeUps: () => [], onBattery: () => false });
  assert.deepEqual(empty.read(NOW), { reasons: [] });

  const far = dueSoonKeepAwakeInput({
    checkBacks: () => [],
    wakeUps: () => [{ id: "wake_tomorrow", fireAt: NOW + minutes(600) }],
    onBattery: () => {
      throw new Error("the power source is read only when something is due");
    },
  });
  assert.deepEqual(far.read(NOW), { reasons: [], recheckAt: NOW + minutes(540) });
});

test("a record overdue by more than an hour stops holding, so a stuck one can't keep the computer awake", () => {
  const input = dueSoonKeepAwakeInput({
    checkBacks: () => [{ id: "cb_late", fireAt: NOW - minutes(30) }, { id: "cb_stuck", fireAt: NOW - minutes(61) }],
    wakeUps: () => [],
    onBattery: () => false,
  });
  assert.deepEqual(input.read(NOW).reasons, [{ kind: "check-back", id: "cb_late" }]);
});

test("the controller holds when a due-soon item enters its hour and lets go on unplugging", () => {
  let now = NOW;
  let onBattery = false;
  const timers: Array<{ at: number; callback: () => void; live: boolean }> = [];
  const held: number[] = [];
  let next = 0;
  const controller = new KeepAwakeController<number, (typeof timers)[number]>({
    blocker: {
      start: () => {
        held.push(++next);
        return next;
      },
      stop: (handle) => held.splice(held.indexOf(handle), 1),
    },
    clock: {
      now: () => now,
      setTimeout: (callback, ms) => {
        const timer = { at: now + ms, callback, live: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        timer.live = false;
      },
    },
    idleSeconds: () => 0,
  });
  const advanceTo = (at: number) => {
    for (;;) {
      const due = timers.filter((timer) => timer.live && timer.at <= at).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.live = false;
      due.callback();
    }
    now = at;
  };
  controller.addInput(
    dueSoonKeepAwakeInput({
      checkBacks: () => [{ id: "cb_1", fireAt: NOW + minutes(90) }],
      wakeUps: () => [],
      onBattery: () => onBattery,
    }),
  );
  assert.equal(held.length, 0);

  // Nothing announces the hour starting: the input's own recheck time does.
  advanceTo(NOW + minutes(30));
  assert.equal(held.length, 1);
  assert.deepEqual(controller.status().counts, { "check-back": 1 });

  // Unplugged: the next read lets go after the one-minute grace.
  onBattery = true;
  advanceTo(NOW + minutes(40));
  assert.equal(held.length, 0);
  controller.dispose();
});
