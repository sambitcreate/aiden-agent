import assert from "node:assert/strict";
import test from "node:test";
import type { DictationStatePayload } from "../../renderer/shared/dictation.js";
import {
  DictationCoordinator,
  type DictationCoordinatorDeps,
} from "./dictation-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(overrides: Partial<DictationCoordinatorDeps> = {}) {
  const events: DictationStatePayload[] = [];
  let hidden = 0;
  const deps: DictationCoordinatorDeps = {
    showPill: async () => false,
    hidePill: () => {
      hidden += 1;
    },
    destroyPill: () => {},
    broadcast: (payload) => events.push(payload),
    paste: async () => "pasted",
    setTimer: (callback) => setTimeout(callback, 60_000),
    clearTimer: (timer) => clearTimeout(timer),
    logError: () => {},
    ...overrides,
  };
  return {
    coordinator: new DictationCoordinator(deps),
    events,
    hidden: () => hidden,
  };
}

test("a second hotkey during cold pill startup cancels without a late recording event", async () => {
  const shown = deferred<boolean>();
  const subject = harness({ showPill: () => shown.promise });
  const first = subject.coordinator.toggle();
  const second = subject.coordinator.toggle();
  shown.resolve(true);
  await Promise.all([first, second]);
  assert.equal(subject.coordinator.currentStage, "idle");
  assert.deepEqual(subject.events, [{ state: "cancelled" }]);
  assert.equal(subject.hidden(), 1);
});

test("duplicate pill ready messages start one recorder only", async () => {
  const subject = harness();
  await subject.coordinator.toggle();
  await Promise.all([subject.coordinator.ready(), subject.coordinator.ready()]);
  assert.equal(subject.coordinator.currentStage, "recording");
  assert.deepEqual(subject.events, [{ state: "recording" }]);
});

test("a new hotkey waits for transcript delivery before starting another recording", async () => {
  const delivered = deferred<"pasted">();
  const pasteStarted = deferred<void>();
  const subject = harness({
    paste: () => {
      pasteStarted.resolve();
      return delivered.promise;
    },
  });
  await subject.coordinator.ready();
  await subject.coordinator.toggle();
  await subject.coordinator.toggle();
  const result = subject.coordinator.result("first");
  const next = subject.coordinator.toggle();
  await pasteStarted.promise;
  assert.equal(subject.coordinator.currentStage, "delivering");
  delivered.resolve("pasted");
  await Promise.all([result, next]);
  assert.deepEqual(subject.events.map((event) => event.state), [
    "recording",
    "stopping",
    "pasted",
    "recording",
  ]);
  assert.equal(subject.coordinator.currentStage, "recording");
});

test("a hotkey cancels a stuck transcription and ignores its late result", async () => {
  const subject = harness();
  await subject.coordinator.ready();
  await subject.coordinator.toggle();
  await subject.coordinator.toggle();
  await subject.coordinator.toggle();
  await subject.coordinator.result("late transcript");
  assert.deepEqual(subject.events.map((event) => event.state), [
    "recording",
    "stopping",
    "cancelled",
  ]);
  assert.equal(subject.coordinator.currentStage, "idle");
});
