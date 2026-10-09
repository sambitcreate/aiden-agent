import assert from "node:assert/strict";
import test from "node:test";
import type { UtilityProcess } from "electron";
import { speechModel, type SpeechModelSpec } from "./local-speech-catalog.js";
import {
  LocalSpeechWorkerHost,
  needsFreshWorker,
  speechLanguageKey,
  type SpeechWorkerTarget,
} from "./local-speech-worker-host.js";
import {
  LOCAL_SPEECH_PROTOCOL_VERSION,
  type LocalSpeechParentMessage,
  type LocalSpeechWorkerMessage,
} from "./local-speech-protocol.js";

const parakeet = speechModel("parakeet-v3")!;
const canary = speechModel("canary-180m-flash")!;
const senseVoice = speechModel("sense-voice")!;

function target(spec: SpeechModelSpec, language: string | null = null): SpeechWorkerTarget {
  return { modelId: spec.id, family: spec.family, language };
}

test("a fresh worker is needed only when a different model is loaded, or a SenseVoice language changes", () => {
  const rows: Array<{
    name: string;
    loaded: { modelId: string; languageKey: string | null } | null;
    request: SpeechWorkerTarget;
    expected: boolean;
  }> = [
    { name: "nothing loaded", loaded: null, request: target(parakeet), expected: false },
    { name: "same model", loaded: { modelId: parakeet.id, languageKey: null }, request: target(parakeet), expected: false },
    { name: "another model", loaded: { modelId: parakeet.id, languageKey: null }, request: target(canary), expected: true },
    {
      name: "SenseVoice, same language",
      loaded: { modelId: senseVoice.id, languageKey: "en" },
      request: target(senseVoice, "en"),
      expected: false,
    },
    {
      name: "SenseVoice, different language",
      loaded: { modelId: senseVoice.id, languageKey: "en" },
      request: target(senseVoice, "de"),
      expected: true,
    },
    {
      name: "SenseVoice loaded with auto, request auto-detects",
      loaded: { modelId: senseVoice.id, languageKey: "auto" },
      request: target(senseVoice, null),
      expected: false,
    },
    {
      name: "SenseVoice loaded with auto, request names a language",
      loaded: { modelId: senseVoice.id, languageKey: "auto" },
      request: target(senseVoice, "en"),
      expected: true,
    },
    {
      name: "Canary language change reconfigures in place",
      loaded: { modelId: canary.id, languageKey: null },
      request: target(canary, "de"),
      expected: false,
    },
  ];
  for (const row of rows) {
    assert.equal(needsFreshWorker(row.loaded, row.request), row.expected, row.name);
  }
  assert.equal(speechLanguageKey("sense-voice", null), "auto");
  assert.equal(speechLanguageKey("nemo-transducer", "en"), null);
});

interface FakeWorker {
  id: string;
  process: UtilityProcess;
  kills: () => number;
  sent: () => LocalSpeechParentMessage[];
  /** Simulates the worker dying on its own. */
  crash: () => void;
}

/**
 * A stand-in for an Electron utility process. It answers every request, and
 * exits a few milliseconds after a kill. A stubborn worker ignores its first kill.
 */
function fakeWorker(id: string, log: string[], stubborn: boolean): FakeWorker {
  const listeners = {
    message: new Set<(value: unknown) => void>(),
    exit: new Set<(code: number) => void>(),
  };
  const sent: LocalSpeechParentMessage[] = [];
  let kills = 0;
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    log.push(`${id} exit`);
    for (const listener of listeners.exit) listener(0);
  };
  const handle = {
    postMessage(message: LocalSpeechParentMessage) {
      sent.push(message);
      log.push(`${id} ${message.kind}`);
      setImmediate(() => {
        if (exited) return;
        const reply: LocalSpeechWorkerMessage = {
          version: LOCAL_SPEECH_PROTOCOL_VERSION,
          kind: "result",
          requestId: message.requestId,
          ...(message.kind === "load" ? { loadMs: 1 } : {}),
          ...(message.kind === "transcribe" ? { text: "ok", language: null, decodeMs: 1 } : {}),
        };
        for (const listener of listeners.message) listener(reply);
      });
    },
    on(event: "message" | "exit", listener: (value: never) => void) {
      (listeners[event] as Set<(value: never) => void>).add(listener);
      return handle;
    },
    removeListener(event: "message" | "exit", listener: (value: never) => void) {
      (listeners[event] as Set<(value: never) => void>).delete(listener);
      return handle;
    },
    kill() {
      kills += 1;
      log.push(`${id} kill`);
      if (!stubborn || kills > 1) setTimeout(exit, 5);
      return true;
    },
    stderr: null,
    stdout: null,
  };
  return {
    id,
    process: handle as unknown as UtilityProcess,
    kills: () => kills,
    sent: () => [...sent],
    crash: exit,
  };
}

function harness(options: { stubbornWorkers?: number[]; exitWaitMs?: number } = {}) {
  const log: string[] = [];
  const spawned: FakeWorker[] = [];
  let unloads = 0;
  const host = new LocalSpeechWorkerHost({
    fork: async () => {
      const worker = fakeWorker(`w${spawned.length + 1}`, log, options.stubbornWorkers?.includes(spawned.length + 1) ?? false);
      spawned.push(worker);
      log.push(`${worker.id} spawn`);
      return worker.process;
    },
    onUnloaded: () => {
      unloads += 1;
      log.push("unloaded");
    },
    exitWaitMs: options.exitWaitMs ?? 500,
  });
  return { host, log, spawned, unloads: () => unloads };
}

test("switching models kills the old worker and waits for its exit before the new one loads", async () => {
  const { host, log, spawned } = harness();
  const first = await host.prepare(target(parakeet));
  await first.load(parakeet.id, "/models/parakeet", parakeet);
  host.recordLoaded({ modelId: parakeet.id, languageKey: null });

  const second = await host.prepare(target(canary));
  await second.load(canary.id, "/models/canary", canary);

  assert.deepEqual(log, ["w1 spawn", "w1 load", "w1 kill", "unloaded", "w1 exit", "w2 spawn", "w2 load"]);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0]!.kills(), 1);
});

test("an explicit release disposes the worker and waits for it to exit without sending a release frame", async () => {
  const { host, log, spawned, unloads } = harness();
  const worker = await host.prepare(target(parakeet));
  await worker.load(parakeet.id, "/models/parakeet", parakeet);
  host.recordLoaded({ modelId: parakeet.id, languageKey: null });

  await host.retire();

  assert.equal(host.current(), null);
  assert.equal(spawned[0]!.kills(), 1);
  assert.deepEqual(
    spawned[0]!.sent().map((message) => message.kind),
    ["load"],
    "the native model is reclaimed by process exit, not by a release frame",
  );
  assert.ok(log.includes("w1 exit"), "retire resolves only after the worker has exited");
  assert.equal(unloads(), 1);
});

test("the same model requested twice reuses one worker", async () => {
  const { host, spawned } = harness();
  const first = await host.prepare(target(parakeet));
  host.recordLoaded({ modelId: parakeet.id, languageKey: null });
  const second = await host.prepare(target(parakeet));
  assert.equal(second, first);
  assert.equal(spawned.length, 1);
});

test("a SenseVoice language change replaces the worker, and the same language keeps it", async () => {
  const { host, log, spawned } = harness();
  await host.prepare(target(senseVoice, "en"));
  host.recordLoaded({ modelId: senseVoice.id, languageKey: "en" });
  await host.prepare(target(senseVoice, "en"));
  assert.equal(spawned.length, 1);

  await host.prepare(target(senseVoice, "de"));
  assert.equal(spawned.length, 2);
  assert.ok(log.indexOf("w1 exit") < log.indexOf("w2 spawn"), "the old worker exits before the replacement forks");
});

test("a worker that ignores its first kill is killed again and the replacement still starts", async () => {
  const { host, log, spawned } = harness({ stubbornWorkers: [1], exitWaitMs: 20 });
  await host.prepare(target(parakeet));
  host.recordLoaded({ modelId: parakeet.id, languageKey: null });
  await host.prepare(target(canary));

  assert.equal(spawned[0]!.kills(), 2);
  assert.ok(log.indexOf("w2 spawn") > log.indexOf("w1 exit"));
});

test("a worker that dies on its own drops the model so the next request reloads in a new worker", async () => {
  const { host, spawned, unloads } = harness();
  await host.prepare(target(parakeet));
  host.recordLoaded({ modelId: parakeet.id, languageKey: null });
  spawned[0]!.crash();

  assert.equal(host.current(), null);
  assert.equal(unloads(), 1);
  await host.prepare(target(parakeet));
  assert.equal(spawned.length, 2);
});
