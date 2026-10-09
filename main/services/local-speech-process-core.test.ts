import assert from "node:assert/strict";
import test from "node:test";
import { speechModel } from "./local-speech-catalog.js";
import {
  LocalSpeechProcessClient,
  runWithCrashRetry,
  transcribeDeadlineMs,
  WorkerCrashError,
  type LocalSpeechProcessPort,
} from "./local-speech-process-core.js";
import { LocalSpeechLane } from "./local-speech-lane.js";
import { LOCAL_SPEECH_PROTOCOL_VERSION, type LocalSpeechParentMessage } from "./local-speech-protocol.js";

const spec = speechModel("parakeet-v3")!;

interface FakePort {
  port: LocalSpeechProcessPort;
  sent: LocalSpeechParentMessage[];
  reply: (message: unknown) => void;
  exit: (code: number) => void;
  killed: () => number;
}

function fakePort(respond?: (message: LocalSpeechParentMessage) => unknown): FakePort {
  const handlers: Array<(message: unknown) => void> = [];
  const exits: Array<(code: number) => void> = [];
  const sent: LocalSpeechParentMessage[] = [];
  let kills = 0;
  return {
    sent,
    reply: (message) => handlers.forEach((handler) => handler(message)),
    exit: (code) => exits.forEach((handler) => handler(code)),
    killed: () => kills,
    port: {
      postMessage: (message) => {
        sent.push(message);
        if (!respond) return;
        const answer = respond(message);
        if (answer !== undefined) queueMicrotask(() => handlers.forEach((handler) => handler(answer)));
      },
      onMessage: (handler) => {
        handlers.push(handler);
        return () => {};
      },
      onExit: (handler) => {
        exits.push(handler);
        return () => {};
      },
      kill: () => {
        kills += 1;
      },
    },
  };
}

function transcribeInput(pcm = new Int16Array(16_000)) {
  return {
    modelId: spec.id,
    modelDirectory: "/tmp/model",
    spec,
    audio: { kind: "pcm16" as const, pcm },
    language: null,
    translate: false,
    trimSilence: true,
    vadModelPath: "/tmp/silero_vad.onnx",
  };
}

test("process client resolves a transcribe result and fails in-flight work on exit", async () => {
  const fake = fakePort((message) =>
    message.kind === "transcribe" && fake.sent.length === 1
      ? { version: LOCAL_SPEECH_PROTOCOL_VERSION, kind: "result", requestId: message.requestId, text: "hello", language: "en", decodeMs: 5 }
      : undefined,
  );
  const client = new LocalSpeechProcessClient(fake.port);
  assert.deepEqual(await client.transcribe(transcribeInput()), { text: "hello", language: "en", decodeMs: 5 });
  assert.equal(fake.sent.length, 1);
  assert.ok((fake.sent[0] as { audio: { pcm: unknown } }).audio.pcm instanceof Int16Array);

  const pending = client.transcribe(transcribeInput());
  fake.exit(1);
  await assert.rejects(pending, (error: unknown) => error instanceof WorkerCrashError && /exit 1/.test(error.message));
  client.dispose();
});

test("worker failures surface their message and code", async () => {
  const fake = fakePort((message) => ({
    version: 2,
    kind: "failure",
    requestId: message.requestId,
    message: "The selected voice model isn't downloaded.",
    code: "model-missing",
  }));
  const client = new LocalSpeechProcessClient(fake.port);
  await assert.rejects(client.transcribe(transcribeInput()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof WorkerCrashError));
    assert.match(error.message, /isn't downloaded/);
    assert.equal((error as Error & { code?: string }).code, "model-missing");
    return true;
  });
  client.dispose();
});

test("deadlines scale with audio length", () => {
  assert.equal(transcribeDeadlineMs(3), 120_000);
  assert.equal(transcribeDeadlineMs(600), 12_000_000);
});

test("a hung request kills the worker and rejects as a crash", async () => {
  const fake = fakePort();
  let hangs = 0;
  const client = new LocalSpeechProcessClient(fake.port, {
    onHang: () => {
      hangs += 1;
    },
    deadlines: { status: 5, load: 5, transcribe: () => 5 },
  });
  await assert.rejects(client.status(), (error: unknown) => error instanceof WorkerCrashError && /hang/.test(error.message));
  assert.equal(hangs, 1);
  client.dispose();
});

test("crash retries once in a fresh worker, then fails clearly; the lane survives", async () => {
  const attempts: number[] = [];
  await assert.rejects(
    runWithCrashRetry(
      async (n) => {
        attempts.push(n);
        throw new WorkerCrashError("exit 9");
      },
      { isCancelled: () => false, isCrash: (e) => e instanceof WorkerCrashError, onCrash: () => {} },
    ),
    /couldn't finish|decode-failed/i,
  );
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(
    await runWithCrashRetry(async () => "ok", { isCancelled: () => false, isCrash: () => true, onCrash: () => {} }),
    "ok",
  );
});

test("a crash followed by success returns the second attempt and reports the first crash", async () => {
  const crashes: number[] = [];
  const result = await runWithCrashRetry(
    async (n) => {
      if (n === 1) throw new WorkerCrashError("exit 134");
      return "recovered";
    },
    { isCancelled: () => false, isCrash: (e) => e instanceof WorkerCrashError, onCrash: (_e, n) => crashes.push(n) },
  );
  assert.equal(result, "recovered");
  assert.deepEqual(crashes, [1]);
});

test("a cancelled request is never retried", async () => {
  let calls = 0;
  await assert.rejects(
    runWithCrashRetry(
      async () => {
        calls += 1;
        throw new WorkerCrashError("killed");
      },
      { isCancelled: () => true, isCrash: () => true, onCrash: () => {} },
    ),
  );
  assert.equal(calls, 1);
});

test("non-crash errors are not retried", async () => {
  let calls = 0;
  await assert.rejects(
    runWithCrashRetry(
      async () => {
        calls += 1;
        throw new Error("model missing");
      },
      { isCancelled: () => false, isCrash: (e) => e instanceof WorkerCrashError, onCrash: () => {} },
    ),
    /model missing/,
  );
  assert.equal(calls, 1);
});

test("stderr tail keeps the last 64 lines and an exit reports a WorkerCrashError", async () => {
  const fake = fakePort();
  const client = new LocalSpeechProcessClient(fake.port);
  for (let line = 0; line < 70; line += 1) client.pushStderr(`line ${line}`);
  const pending = client.transcribe(transcribeInput());
  fake.exit(134);
  await assert.rejects(pending, (error: unknown) => error instanceof WorkerCrashError && /exit 134/.test(error.message));
  const tail = client.stderrTail();
  assert.equal(tail.length, 64);
  assert.equal(tail[0], "line 6");
  assert.equal(tail[tail.length - 1], "line 69");
  client.dispose();
});

test("a closed client rejects new requests without posting", async () => {
  const fake = fakePort();
  const client = new LocalSpeechProcessClient(fake.port);
  client.dispose();
  await assert.rejects(client.status(), /closed/);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.killed(), 1);
});

test("two crashes fail one request clearly; the next request on the lane gets a fresh worker", async () => {
  // Each fork is a fake worker; the first two die mid-request, the third answers.
  const forks: FakePort[] = [];
  let current: LocalSpeechProcessClient | null = null;
  const getClient = () => {
    if (current) return current;
    const index = forks.length;
    const fake = fakePort((message) => {
      if (index < 2) {
        queueMicrotask(() => fake.exit(139));
        return undefined;
      }
      return { version: 2, kind: "result", requestId: message.requestId, text: `worker ${index}` };
    });
    forks.push(fake);
    current = new LocalSpeechProcessClient(fake.port);
    return current;
  };
  const lane = new LocalSpeechLane();
  const crashes: number[] = [];
  const transcribeOnLane = () =>
    lane.run(() =>
      runWithCrashRetry(async () => (await getClient().transcribe(transcribeInput())).text, {
        isCancelled: () => false,
        isCrash: (error) => error instanceof WorkerCrashError,
        onCrash: (_error, attempt) => {
          crashes.push(attempt);
          current?.dispose();
          current = null;
        },
      }),
    );

  await assert.rejects(transcribeOnLane(), /couldn't finish \(decode-failed\)/);
  assert.deepEqual(crashes, [1, 2]);
  assert.equal(await transcribeOnLane(), "worker 2");
  assert.equal(forks.length, 3);
});
