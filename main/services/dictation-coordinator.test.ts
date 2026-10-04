import assert from "node:assert/strict";
import test from "node:test";
import type { DictationStatePayload } from "../../renderer/shared/dictation.js";
import {
  DictationCoordinator,
  HOLD_RELEASE_GRACE_MS,
  TRANSCRIPTION_WATCHDOG_MS,
  type DictationCoordinatorDeps,
} from "./dictation-coordinator.js";
import { HYBRID_TAP_THRESHOLD_MS } from "../../renderer/shared/dictation-preferences.js";

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

test("a Secure Input copy result reaches the pill and lingers longer than a paste", async () => {
  async function deliver(result: Awaited<ReturnType<DictationCoordinatorDeps["paste"]>>) {
    const delays: number[] = [];
    const subject = harness({
      paste: async () => result,
      setTimer: (_callback, delayMs) => {
        delays.push(delayMs);
        return dormantTimer();
      },
    });
    await subject.coordinator.ready();
    await subject.coordinator.press();
    await subject.coordinator.press();
    const before = delays.length;
    await subject.coordinator.result("hello there", subject.coordinator.currentOperationId!);
    assert.ok(delays.length > before, "delivery schedules the pill hide");
    return { events: subject.events, hideDelay: delays[delays.length - 1]! };
  }

  const secure = await deliver({
    outcome: "copied",
    reason: "secure-input",
    message: "Transcript copied — press ⌘V to paste.",
  });
  const pasted = await deliver({ outcome: "pasted" });
  assert.deepEqual(secure.events[secure.events.length - 1], {
    state: "copied",
    operationId: secure.events[0]!.operationId,
    reason: "secure-input",
    message: "Transcript copied — press ⌘V to paste.",
  });
  assert.ok(secure.hideDelay > pasted.hideDelay);
});

test("pill errors stay up long enough to read, longer for longer guidance", async () => {
  async function failWith(message: string) {
    const delays: number[] = [];
    const subject = harness({
      setTimer: (_callback, delayMs) => {
        delays.push(delayMs);
        return dormantTimer();
      },
    });
    await subject.coordinator.ready();
    await subject.coordinator.press();
    await subject.coordinator.press();
    const before = delays.length;
    await subject.coordinator.error(message, subject.coordinator.currentOperationId!);
    assert.equal(subject.events[subject.events.length - 1]?.state, "error");
    assert.ok(delays.length > before, "an error schedules the pill hide");
    return delays[delays.length - 1]!;
  }

  const short = await failWith("No speech detected.");
  const long = await failWith(
    "OpenAI needs an API key for voice input. Add it in Settings → Providers, then try again.",
  );
  const runaway = await failWith("x".repeat(5_000));
  assert.ok(short >= 4_000, `short errors stay at least 4 s (got ${short})`);
  assert.ok(long > short, "longer guidance stays up longer");
  assert.ok(runaway <= 10_000, "a pathological message still clears");
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

test("desktop release during cold startup is latched before recorder readiness", async () => {
  const shown = deferred<boolean>();
  let release!: () => void;
  const subject = harness({
    isHoldToTalk: () => true,
    showPill: () => shown.promise,
    startReleaseWatch: (up) => {
      release = up;
      return () => {};
    },
  });
  const pressed = subject.coordinator.press();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  shown.resolve(true);
  await pressed;
  await subject.coordinator.ready();
  assert.equal(subject.coordinator.currentStage, "transcribing");
  subject.coordinator.dispose();
});
test("desktop release from a prior operation cannot stop a new recording", async () => {
  const releases: Array<() => void> = [];
  const subject = harness({
    isHoldToTalk: () => true,
    startReleaseWatch: (up) => {
      releases.push(up);
      return () => {};
    },
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.cancel();
  await subject.coordinator.press();
  releases[0]();
  await subject.coordinator.ready();
  assert.equal(subject.coordinator.currentStage, "recording");
  subject.coordinator.dispose();
});
test("desktop session failure during startup stops at first recorder readiness", async () => {
  let fail!: () => void;
  const subject = harness({
    isHoldToTalk: () => true,
    startReleaseWatch: (_up, failed) => {
      fail = failed;
      return () => {};
    },
  });
  await subject.coordinator.press();
  fail();
  await subject.coordinator.ready();
  assert.equal(subject.coordinator.currentStage, "transcribing");
  subject.coordinator.dispose();
});

function hybridHarness(overrides: Partial<DictationCoordinatorDeps> = {}) {
  let clock = 10_000;
  let grace: (() => void) | undefined;
  const watches: Array<{ onRelease: () => void; stopped: boolean }> = [];
  const subject = harness({
    now: () => clock,
    getActivationMode: () => "hybrid",
    getHoldKeyCode: () => 2,
    startHoldWatch: (_keyCode, onRelease) => {
      const watch = { onRelease, stopped: false };
      watches.push(watch);
      return () => {
        watch.stopped = true;
      };
    },
    setTimer: (callback, delayMs) => {
      if (delayMs === HOLD_RELEASE_GRACE_MS) grace = callback;
      return dormantTimer();
    },
    ...overrides,
  });
  return {
    ...subject,
    advance: (ms: number) => {
      clock += ms;
    },
    watches,
    fireGrace: async () => {
      assert.ok(grace, "release grace was scheduled");
      grace();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("hybrid tap latches recording on until the next press", async () => {
  const subject = hybridHarness();
  await subject.coordinator.ready();
  await subject.coordinator.press();
  assert.equal(subject.watches.length, 1, "hybrid watches the key from the first press");
  subject.advance(HYBRID_TAP_THRESHOLD_MS - 50);
  await subject.coordinator.release();
  assert.equal(subject.coordinator.currentStage, "recording", "a tap does not stop capture");
  assert.equal(subject.watches[0]?.stopped, true);
  subject.advance(4_000);
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "transcribing");
  assert.deepEqual(
    subject.events.map((event) => event.state),
    ["recording", "stopping"],
  );
});

test("hybrid hold behaves as push-to-talk and ignores repeats while held", async () => {
  const subject = hybridHarness();
  await subject.coordinator.ready();
  await subject.coordinator.press();
  subject.advance(100);
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "recording", "a repeat while held is ignored");
  subject.advance(HYBRID_TAP_THRESHOLD_MS + 500);
  await subject.coordinator.release();
  await subject.fireGrace();
  assert.equal(subject.coordinator.currentStage, "transcribing");
});

test("hybrid measures the tap from key-down even when the pill starts slowly", async () => {
  const shown = deferred<boolean>();
  const subject = hybridHarness({ showPill: () => shown.promise });
  const pressed = subject.coordinator.press();
  await new Promise((resolve) => setImmediate(resolve));
  subject.advance(120);
  subject.watches[0]?.onRelease();
  subject.advance(900);
  shown.resolve(true);
  await pressed;
  await subject.coordinator.ready();
  assert.equal(subject.coordinator.currentStage, "recording", "the quick tap latched on");
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "transcribing");
});

test("hybrid long hold released during cold startup stops at recorder readiness", async () => {
  const shown = deferred<boolean>();
  const subject = hybridHarness({ showPill: () => shown.promise });
  const pressed = subject.coordinator.press();
  await new Promise((resolve) => setImmediate(resolve));
  subject.advance(HYBRID_TAP_THRESHOLD_MS + 200);
  subject.watches[0]?.onRelease();
  shown.resolve(true);
  await pressed;
  await subject.coordinator.ready();
  assert.equal(subject.coordinator.currentStage, "transcribing");
});

test("hybrid without a key watch degrades to toggle", async () => {
  const subject = hybridHarness({ startHoldWatch: () => null });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "recording");
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "transcribing");
});

test("toggle mode ignores key-up events entirely", async () => {
  const subject = harness({ getActivationMode: () => "toggle", startHoldWatch: () => () => {} });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.release();
  assert.equal(subject.coordinator.currentStage, "recording");
  assert.equal(subject.coordinator.currentMode, "toggle");
});

test("each recording starts a best-effort model warm-up that cannot block capture", async () => {
  let warmups = 0;
  const logged: string[] = [];
  const subject = harness({
    warmUp: async () => {
      warmups += 1;
      throw new Error("model missing");
    },
    logError: (message) => logged.push(message),
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "recording");
  await subject.coordinator.press();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warmups, 1, "stopping does not warm again");
  assert.equal(logged.length, 1);
});

test("the dictionary corrects the delivered transcript after cleanup", async () => {
  const pasted: string[] = [];
  const subject = harness({
    shouldCleanup: () => true,
    cleanupTranscript: async (text) => `${text}.`,
    applyDictionary: (text) => text.replace(/\baiden\b/giu, "Aiden"),
    paste: async (text) => {
      pasted.push(text);
      return "pasted";
    },
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.press();
  await subject.coordinator.result("ask aiden", subject.coordinator.currentOperationId);
  assert.deepEqual(pasted, ["ask Aiden."]);
});

test("a failing dictionary never loses the transcript", async () => {
  const pasted: string[] = [];
  const subject = harness({
    applyDictionary: () => {
      throw new Error("bad rules");
    },
    paste: async (text) => {
      pasted.push(text);
      return "pasted";
    },
  });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  await subject.coordinator.press();
  await subject.coordinator.result("hello there", subject.coordinator.currentOperationId);
  assert.deepEqual(pasted, ["hello there"]);
});

test("hybrid unmappable shortcut latches toggle and ignores release", async () => {
  const subject = hybridHarness({ getHoldKeyCode: () => null });
  await subject.coordinator.ready();
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "recording");
  await subject.coordinator.release();
  assert.equal(subject.coordinator.currentStage, "recording");
  assert.ok(subject.events.some((event) => event.message?.toLowerCase().includes("again to stop")));
  await subject.coordinator.press();
  assert.equal(subject.coordinator.currentStage, "transcribing");
});
