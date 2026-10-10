import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  acceptModelPaceSample,
  addModelPaceSample,
  createModelPacePersistence,
  emptyModelPaceDocument,
  MODEL_PACE_MAX_MODELS,
  MODEL_PACE_SAMPLES_PER_MODEL,
  ModelPaceRecorder,
  ModelPaceTimer,
  summarizeModelPace,
  type ModelPaceDocument,
  type ModelPacePersistence,
  type ModelPaceSample,
} from "./model-pace-core.js";

const timing = {
  requestStartedAt: 1_000,
  firstDeltaAt: 1_400,
  endedAt: 3_400,
  outputTokens: 100,
  stopReason: "stop",
  at: 50_000,
};

test("a successful response yields TTFT and output tokens per generation second", () => {
  assert.deepEqual(acceptModelPaceSample(timing), { ttftMs: 400, tokensPerSecond: 50, at: 50_000 });
});

test("samples are rejected for failures, short output, short generation or missing deltas", () => {
  for (const stopReason of ["error", "aborted", "pending", "deferred"]) {
    assert.equal(acceptModelPaceSample({ ...timing, stopReason }), null, stopReason);
  }
  for (const stopReason of ["stop", "length", "toolUse"]) {
    assert.notEqual(acceptModelPaceSample({ ...timing, stopReason }), null, stopReason);
  }
  assert.equal(acceptModelPaceSample({ ...timing, outputTokens: 15 }), null);
  assert.notEqual(acceptModelPaceSample({ ...timing, outputTokens: 16 }), null);
  assert.equal(acceptModelPaceSample({ ...timing, endedAt: 1_649 }), null);
  assert.notEqual(acceptModelPaceSample({ ...timing, endedAt: 1_650 }), null);
  assert.equal(acceptModelPaceSample({ ...timing, firstDeltaAt: undefined }), null);
  assert.equal(acceptModelPaceSample({ ...timing, outputTokens: Number.NaN }), null);
  assert.equal(acceptModelPaceSample({ ...timing, firstDeltaAt: 900 }), null);
});

function sample(at: number, ttftMs = 100, tokensPerSecond = 40): ModelPaceSample {
  return { ttftMs, tokensPerSecond, at };
}

test("each model keeps only its most recent samples", () => {
  let document = emptyModelPaceDocument();
  for (let index = 0; index < MODEL_PACE_SAMPLES_PER_MODEL + 5; index += 1) {
    document = addModelPaceSample(document, "openai::gpt", sample(index));
  }
  const samples = document.models["openai::gpt"]!.samples;
  assert.equal(samples.length, MODEL_PACE_SAMPLES_PER_MODEL);
  assert.equal(samples[0]!.at, 5);
  assert.equal(samples[samples.length - 1]!.at, MODEL_PACE_SAMPLES_PER_MODEL + 4);
});

test("the least recently sampled models are pruned beyond the model limit", () => {
  let document = emptyModelPaceDocument();
  document = addModelPaceSample(document, "p::stale", sample(1));
  for (let index = 0; index < MODEL_PACE_MAX_MODELS - 1; index += 1) {
    document = addModelPaceSample(document, `p::m${index}`, sample(10 + index));
  }
  // Re-sampling the oldest model makes it recent again.
  document = addModelPaceSample(document, "p::stale", sample(10_000));
  document = addModelPaceSample(document, "p::new", sample(10_001));
  const keys = Object.keys(document.models);
  assert.equal(keys.length, MODEL_PACE_MAX_MODELS);
  assert.ok(keys.includes("p::stale"));
  assert.ok(keys.includes("p::new"));
  assert.ok(!keys.includes("p::m0"));
});

test("summaries report medians, count and last sampled time", () => {
  let document = emptyModelPaceDocument();
  for (const [at, ttft, tps] of [[3, 300, 10], [1, 100, 50], [2, 900, 30]] as const) {
    document = addModelPaceSample(document, "a::odd", sample(at, ttft, tps));
  }
  for (const [at, ttft, tps] of [[1, 100, 10], [2, 200, 20], [3, 400, 40], [4, 800, 80]] as const) {
    document = addModelPaceSample(document, "a::even", sample(at, ttft, tps));
  }
  assert.deepEqual(summarizeModelPace(document), {
    "a::odd": { medianTtftMs: 300, medianTokensPerSecond: 30, sampleCount: 3, lastSampledAt: 3 },
    "a::even": { medianTtftMs: 300, medianTokensPerSecond: 30, sampleCount: 4, lastSampledAt: 4 },
  });
});

test("the timer measures each model response from its request, not the whole turn", () => {
  let clock = 0;
  const timer = new ModelPaceTimer({ monotonic: () => clock, wall: () => 9_000 + clock });
  const delta = (type: string) => ({ type: "message_update", assistantMessageEvent: { type } });
  const end = (output: number, stopReason = "toolUse") => ({
    type: "message_end",
    message: { role: "assistant", stopReason, usage: { output } },
  });

  timer.requestStarted("p::m");
  clock = 50;
  assert.equal(timer.observe({ type: "message_start", message: { role: "assistant" } }), null);
  clock = 300;
  assert.equal(timer.observe(delta("thinking_delta")), null);
  clock = 400;
  timer.observe(delta("text_delta"));
  clock = 1_300;
  assert.deepEqual(timer.observe(end(45)), {
    key: "p::m",
    sample: { ttftMs: 300, tokensPerSecond: 45, at: 10_300 },
  });

  // Tool execution time between responses never counts toward the next one.
  clock = 60_000;
  timer.requestStarted("p::m");
  clock = 60_200;
  timer.observe(delta("text_delta"));
  clock = 60_700;
  assert.deepEqual(timer.observe(end(100, "stop")), {
    key: "p::m",
    sample: { ttftMs: 200, tokensPerSecond: 200, at: 69_700 },
  });

  // A response without a new request start is ignored rather than mistimed.
  timer.observe(delta("text_delta"));
  assert.equal(timer.observe(end(100, "stop")), null);

  // User messages and failed responses never produce samples.
  timer.requestStarted("p::m");
  timer.observe(delta("text_delta"));
  clock += 1_000;
  assert.equal(timer.observe({ type: "message_end", message: { role: "user" } }), null);
  assert.equal(timer.observe(end(100, "aborted")), null);
});

function memoryPersistence(initial: ModelPaceDocument = emptyModelPaceDocument()) {
  const state = { document: structuredClone(initial), saves: 0, removes: 0, failSave: false };
  const persistence: ModelPacePersistence = {
    load: async () => structuredClone(state.document),
    save: async (document) => {
      if (state.failSave) throw new Error("disk full");
      state.saves += 1;
      state.document = structuredClone(document);
    },
    remove: async () => {
      state.removes += 1;
      state.document = emptyModelPaceDocument();
    },
  };
  return { state, persistence };
}

class ManualTimers {
  pending: (() => void) | null = null;
  delays: number[] = [];
  schedule = (callback: () => void, ms: number) => {
    this.delays.push(ms);
    this.pending = callback;
    return 1;
  };
  cancel = () => {
    this.pending = null;
  };
  fire() {
    const callback = this.pending;
    this.pending = null;
    callback?.();
  }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("recording is debounced into a single save and flush persists pending samples", async () => {
  const { state, persistence } = memoryPersistence();
  const timers = new ManualTimers();
  const recorder = new ModelPaceRecorder(persistence, { schedule: timers.schedule, cancel: timers.cancel });

  recorder.record("p::m", sample(1));
  recorder.record("p::m", sample(2));
  await settle();
  assert.equal(state.saves, 0);
  assert.ok(timers.delays.every((ms) => ms >= 5_000));
  timers.fire();
  await settle();
  assert.equal(state.saves, 1);
  assert.equal(state.document.models["p::m"]!.samples.length, 2);

  recorder.record("p::n", sample(3));
  await recorder.flush();
  assert.equal(state.saves, 2);
  assert.deepEqual(Object.keys(state.document.models).sort(), ["p::m", "p::n"]);
  assert.equal((await recorder.summaries())["p::n"]!.sampleCount, 1);
});

test("recording never throws into the caller when persistence fails", async () => {
  const errors: unknown[] = [];
  const { state, persistence } = memoryPersistence();
  state.failSave = true;
  const recorder = new ModelPaceRecorder(
    { ...persistence, load: async () => { throw new Error("unreadable"); } },
    { onError: (error) => errors.push(error), schedule: () => 1, cancel: () => {} },
  );
  assert.doesNotThrow(() => recorder.record("p::m", sample(1)));
  assert.doesNotThrow(() => recorder.record("p::m", { ttftMs: Number.NaN } as never));
  await recorder.flush();
  assert.ok(errors.length > 0);
  // An unreadable store reads as empty, and the valid sample still counts in memory.
  assert.equal((await recorder.summaries())["p::m"]!.sampleCount, 1);
});

test("clear forgets memory and removes the file", async () => {
  let document = emptyModelPaceDocument();
  document = addModelPaceSample(document, "p::m", sample(1));
  const { state, persistence } = memoryPersistence(document);
  const timers = new ManualTimers();
  const recorder = new ModelPaceRecorder(persistence, { schedule: timers.schedule, cancel: timers.cancel });
  assert.equal(Object.keys(await recorder.summaries()).length, 1);
  recorder.record("p::n", sample(2));
  await settle();
  await recorder.clear();
  assert.equal(state.removes, 1);
  assert.deepEqual(await recorder.summaries(), {});
  timers.fire();
  await recorder.flush();
  assert.deepEqual(state.document.models, {});
});

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aiden-model-pace-"));
}

test("the device-local store round-trips samples with owner-only permissions", async () => {
  const root = await tempRoot();
  const persistence = createModelPacePersistence(() => root);
  const document = addModelPaceSample(emptyModelPaceDocument(), "p::m", sample(1));
  await persistence.save(document);
  const file = path.join(root, "model-pace.json");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await createModelPacePersistence(() => root).load(), document);

  await persistence.remove();
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  await persistence.remove();
  // The store keeps working after its file is removed.
  await persistence.save(document);
  assert.deepEqual(await createModelPacePersistence(() => root).load(), document);
});

test("corrupt, wrong-version, invalid and oversized files read as empty", async () => {
  const valid = addModelPaceSample(emptyModelPaceDocument(), "p::m", sample(1));
  const cases: Record<string, string> = {
    corrupt: "{not json",
    wrongVersion: JSON.stringify({ ...valid, version: 2 }),
    invalidSample: JSON.stringify({
      version: 1,
      models: { "p::m": { samples: [{ ttftMs: -1, tokensPerSecond: 10, at: 1 }] } },
    }),
    tooManySamples: JSON.stringify({
      version: 1,
      models: { "p::m": { samples: Array.from({ length: 21 }, (_, index) => sample(index)) } },
    }),
    badKey: JSON.stringify({ version: 1, models: { nokey: { samples: [sample(1)] } } }),
    oversized: JSON.stringify({ ...valid, padding: "x".repeat(2 * 1024 * 1024) }),
  };
  for (const [name, contents] of Object.entries(cases)) {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "model-pace.json"), contents);
    assert.deepEqual(await createModelPacePersistence(() => root).load(), emptyModelPaceDocument(), name);
  }
});
