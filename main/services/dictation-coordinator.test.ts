import assert from "node:assert/strict";
import test from "node:test";
import type { DictationStatePayload } from "../../renderer/shared/dictation.js";
import {
  DictationCoordinator,
  HOLD_RELEASE_GRACE_MS,
  TRANSCRIPTION_WATCHDOG_MS,
  type DictationCoordinatorDeps,
} from "./dictation-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dormantTimer(): NodeJS.Timeout {
  const timer = setTimeout(() => {}, 60_000);
  timer.unref();
  return timer;
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
    setTimer: () => dormantTimer(),
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

test("a second toggle press during cold pill startup is latched as stop", async () => {
  const shown = deferred<boolean>();
  const subject = harness({ showPill: () => shown.promise });
  const first = subject.coordinator.toggle();
  const second = subject.coordinator.toggle();
  shown.resolve(true);
  await Promise.all([first, second]);
  assert.equal(subject.coordinator.currentStage, "starting");
  assert.equal(subject.events.length, 0);
  await subject.coordinator.ready();
  assert.equal(subject.coordinator.currentStage, "transcribing");
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "stopping"],
  );
  assert.equal(subject.hidden(), 0);
});

test("duplicate pill ready messages start one recorder only", async () => {
  const subject = harness();
  await subject.coordinator.toggle();
  await Promise.all([subject.coordinator.ready(), subject.coordinator.ready()]);
  assert.equal(subject.coordinator.currentStage, "recording");
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording"],
  );
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
  const operationId = subject.coordinator.currentOperationId!;
  const result = subject.coordinator.result("first", operationId);
  const next = subject.coordinator.toggle();
  await pasteStarted.promise;
  assert.equal(subject.coordinator.currentStage, "delivering");
  delivered.resolve("pasted");
  await Promise.all([result, next]);
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "stopping", "delivering", "pasted", "recording"],
  );
  assert.equal(subject.coordinator.currentStage, "recording");
});

test("a hotkey cancels a stuck transcription and ignores its late result", async () => {
  const subject = harness();
  await subject.coordinator.ready();
  await subject.coordinator.toggle();
  await subject.coordinator.toggle();
  const operationId = subject.coordinator.currentOperationId!;
  await subject.coordinator.toggle();
  await subject.coordinator.result("late transcript", operationId);
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "stopping", "cancelled"],
  );
  assert.equal(subject.coordinator.currentStage, "idle");
});

test("hold-to-talk release stops recording after the grace window", async () => {
  let grace: (() => void) | undefined;
  const subject = harness({
    isHoldToTalk: () => true,
    getHoldKeyCode: () => 2,
    startHoldWatch: () => () => {},
    setTimer: (callback, delayMs) => {
      if (delayMs === HOLD_RELEASE_GRACE_MS) grace = callback;
      return dormantTimer();
    },
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "recording");
  await subject.coordinator.release();
  assert.ok(grace);
  grace();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.coordinator.currentStage, "transcribing");
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "stopping"],
  );
});

test("hold-to-talk falls back to press-to-stop when the key watch cannot start", async () => {
  const subject = harness({
    isHoldToTalk: () => true,
    getHoldKeyCode: () => 2,
    startHoldWatch: () => null,
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "transcribing");
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "recording", "stopping"],
  );
  assert.match(subject.events[1].message ?? "", /press again to stop/u);
});

test("hold-to-talk falls back to press-to-stop when the key watch dies after start", async () => {
  let failWatch: (() => void) | undefined;
  const subject = harness({
    isHoldToTalk: () => true,
    getHoldKeyCode: () => 2,
    startHoldWatch: (_keyCode, _onRelease, onFailed) => {
      failWatch = onFailed;
      return () => {};
    },
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "recording");
  failWatch?.();
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "transcribing");
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "recording", "stopping"],
  );
  assert.match(subject.events[1].message ?? "", /press again to stop/u);
});

test("hold-to-talk falls back to press-to-stop when the key watch throws", async () => {
  const subject = harness({
    isHoldToTalk: () => true,
    getHoldKeyCode: () => 2,
    startHoldWatch: () => {
      throw new Error("watch failed");
    },
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "transcribing");
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "recording", "stopping"],
  );
  assert.match(subject.events[1].message ?? "", /press again to stop/u);
});

test("hold-to-talk re-press during the release grace window still stops recording", async () => {
  let grace: (() => void) | undefined;
  let watchStops = 0;
  const subject = harness({
    isHoldToTalk: () => true,
    getHoldKeyCode: () => 2,
    startHoldWatch: () => () => {
      watchStops += 1;
    },
    setTimer: (callback, delayMs) => {
      if (delayMs === HOLD_RELEASE_GRACE_MS) grace = callback;
      return dormantTimer();
    },
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.release();
  assert.ok(watchStops >= 1);
  assert.equal(subject.coordinator.currentStage, "recording");
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "transcribing");
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "stopping"],
  );
  grace?.();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.coordinator.currentStage, "transcribing");
});

test("hold-to-talk repeats do not stop while the key watch is active", async () => {
  const subject = harness({
    isHoldToTalk: () => true,
    getHoldKeyCode: () => 2,
    startHoldWatch: () => () => {},
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "recording");
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording"],
  );
});

test("silence stop ends an in-progress recording", async () => {
  const subject = harness();
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.stopRecording();
  assert.equal(subject.coordinator.currentStage, "transcribing");
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "stopping"],
  );
});

test("cleanup failures still paste the original transcript", async () => {
  const pasted: string[] = [];
  const subject = harness({
    shouldCleanup: () => true,
    cleanupTranscript: async () => {
      throw new Error("model unavailable");
    },
    paste: async (text) => {
      pasted.push(text);
      return "pasted";
    },
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.press();
  await subject.coordinator.result("hello there", subject.coordinator.currentOperationId!);
  assert.deepEqual(pasted, ["hello there"]);
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "stopping", "delivering", "pasted"],
  );
});

test("hold release during cold startup is latched and stops after ready", async () => {
  const shown = deferred<boolean>();
  const subject = harness({
    showPill: () => shown.promise,
    isHoldToTalk: () => true,
    getHoldKeyCode: () => 2,
    startHoldWatch: () => () => {},
  });
  const press = subject.coordinator.press();
  const release = subject.coordinator.release();
  shown.resolve(true);
  await Promise.all([press, release]);
  assert.equal(subject.coordinator.currentStage, "starting");
  await subject.coordinator.ready();
  assert.equal(subject.coordinator.currentStage, "transcribing");
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "stopping"],
  );
});

test("interaction mode is frozen until the active recording finishes", async () => {
  let holdToTalk = true;
  const subject = harness({
    isHoldToTalk: () => holdToTalk,
    getHoldKeyCode: () => 2,
    startHoldWatch: () => () => {},
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  holdToTalk = false;
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "recording", "repeat remains ignored");
  await subject.coordinator.release();
  assert.equal(subject.coordinator.currentStage, "recording", "release grace remains active");
});

test("transcription watchdog always produces a terminal error", async () => {
  let watchdog: (() => void) | undefined;
  const subject = harness({
    setTimer: (callback, delayMs) => {
      if (delayMs === TRANSCRIPTION_WATCHDOG_MS) watchdog = callback;
      return dormantTimer();
    },
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.press();
  assert.ok(watchdog);
  watchdog();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.coordinator.currentStage, "idle");
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "stopping", "error"],
  );
  assert.match(subject.events[subject.events.length - 1]?.message ?? "", /took too long/u);
});

test("late progress and results from a cancelled operation cannot affect the next one", async () => {
  const pasted: string[] = [];
  const subject = harness({
    paste: async (text) => {
      pasted.push(text);
      return "pasted";
    },
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.press();
  const oldId = subject.coordinator.currentOperationId!;
  await subject.coordinator.cancel();
  await subject.coordinator.press();
  await subject.coordinator.press();
  const currentId = subject.coordinator.currentOperationId!;
  await subject.coordinator.progress("fallback", oldId);
  await subject.coordinator.result("old", oldId);
  assert.deepEqual(pasted, []);
  await subject.coordinator.result("new", currentId);
  assert.deepEqual(pasted, ["new"]);
});

test("dictation broadcasts the explicit Gemini retry-consent stage", async () => {
  const subject = harness();
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.press();
  const operationId = subject.coordinator.currentOperationId!;
  await subject.coordinator.progress("fallback-consent", operationId);
  const last = subject.events[subject.events.length - 1];
  assert.equal(last?.state, "fallback-consent");
  assert.equal(last?.operationId, operationId);
});
