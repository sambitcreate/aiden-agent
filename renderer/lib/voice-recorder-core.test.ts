import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { voiceApi } from "./ipc.js";
import { transcriptionBudgetMs } from "./dictation-operation-gate.js";

import {
  transcribeBlob,
  microphoneCaptureErrorMessage,
  MICROPHONE_PERMISSION_OFF_MESSAGE,
} from "./voice-recorder-core.js";

test("microphone capture errors preserve actionable device and permission causes", () => {
  assert.equal(
    microphoneCaptureErrorMessage({ name: "NotAllowedError" }),
    MICROPHONE_PERMISSION_OFF_MESSAGE,
  );
  assert.equal(
    microphoneCaptureErrorMessage({ name: "SecurityError" }),
    MICROPHONE_PERMISSION_OFF_MESSAGE,
  );
  assert.match(
    microphoneCaptureErrorMessage({ name: "NotFoundError" }),
    /No microphone was found/u,
  );
  assert.match(microphoneCaptureErrorMessage({ name: "NotReadableError" }), /other apps using it/u);
  assert.match(microphoneCaptureErrorMessage({ name: "AbortError" }), /interrupted/u);
  assert.match(microphoneCaptureErrorMessage(new Error("raw device detail")), /could not start/u);
  assert.match(
    microphoneCaptureErrorMessage(
      Object.defineProperty({}, "name", {
        get() {
          throw new Error("untrusted getter detail");
        },
      }),
    ),
    /could not start/u,
  );
});

test("permission recovery tells users that macOS requires an app restart", () => {
  assert.match(MICROPHONE_PERMISSION_OFF_MESSAGE, /restart Aiden/u);
});

function replaceGlobal(t: TestContext, name: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Browser conversion remains pending until the test delivers its callback. */
function deferredConversion(t: TestContext, provider: "openai" | "gemini" | "local") {
  const ready = deferred<void>();
  let finish!: () => void;
  if (provider === "openai") {
    replaceGlobal(
      t,
      "FileReader",
      class {
        result = "data:audio/webm;base64,YXVkaW8=";
        onload: (() => void) | null = null;
        readAsDataURL() {
          finish = () => this.onload?.();
          ready.resolve();
        }
      },
    );
  } else {
    replaceGlobal(
      t,
      "AudioContext",
      class {
        async decodeAudioData() {
          return { duration: 0.01 };
        }
        async close() {}
      },
    );
    replaceGlobal(
      t,
      "OfflineAudioContext",
      class {
        destination = {};
        createBufferSource() {
          return { buffer: null, connect() {}, start() {} };
        }
        startRendering() {
          const rendered = deferred<{ getChannelData: () => Float32Array }>();
          finish = () => rendered.resolve({ getChannelData: () => new Float32Array([0.25]) });
          ready.resolve();
          return rendered.promise;
        }
      },
    );
  }
  return { ready: ready.promise, finish: () => finish() };
}

for (const provider of ["openai", "gemini", "local"] as const) {
  test(`${provider} conversion completing after the deadline cannot dispatch transcription`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const conversion = deferredConversion(t, provider);
    const cloud = t.mock.method(voiceApi, "transcribe", async () => "late cloud text");
    const local = t.mock.method(voiceApi, "transcribeLocal", async () => "late local text");
    const cancel = t.mock.method(
      voiceApi,
      provider === "local" ? "cancelLocalTranscription" : "cancelTranscription",
      () => new Promise<void>(() => {}),
    );
    const pending = transcribeBlob(new Blob(["audio"], { type: "audio/webm" }), {
      provider,
      localModel: "parakeet",
      operationId: `late-${provider}`,
    }).then(
      (text) => ({ text, error: null }),
      (error) => ({ text: null, error }),
    );
    await conversion.ready;
    t.mock.timers.tick(transcriptionBudgetMs(provider));
    conversion.finish();
    const outcome = await pending;
    await setImmediate();
    assert.equal(cloud.mock.callCount(), 0);
    assert.equal(local.mock.callCount(), 0);
    assert.match(String(outcome.error), /took too long/u);
    assert.deepEqual(
      cancel.mock.calls.map((call) => call.arguments),
      [[`late-${provider}`]],
    );
  });
}

for (const provider of ["openai", "gemini", "local"] as const) {
  test(`${provider} successful conversion preserves dispatch and clears its deadline`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const conversion = deferredConversion(t, provider);
    const transcribe = t.mock.method(
      voiceApi,
      provider === "local" ? "transcribeLocal" : "transcribe",
      async () => "  spoken text  ",
    );
    const cancel = t.mock.method(
      voiceApi,
      provider === "local" ? "cancelLocalTranscription" : "cancelTranscription",
      async () => {},
    );
    const pending = transcribeBlob(new Blob(["audio"], { type: "audio/webm" }), {
      provider,
      localModel: "parakeet",
      model: "selected-model",
      operationId: "successful",
    });
    await conversion.ready;
    conversion.finish();
    assert.equal(await pending, "spoken text");
    assert.equal(transcribe.mock.callCount(), 1);
    const args = transcribe.mock.calls[0].arguments;
    assert.equal(args[args.length - 1], "successful");
    t.mock.timers.tick(transcriptionBudgetMs(provider));
    assert.equal(cancel.mock.callCount(), 0);
  });
}

test("caller abort still invalidates conversion before dispatch", async (t) => {
  const conversion = deferredConversion(t, "openai");
  const transcribe = t.mock.method(voiceApi, "transcribe", async () => "stale text");
  const controller = new AbortController();
  const pending = transcribeBlob(new Blob(["audio"]), {
    provider: "openai",
    operationId: "aborted",
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await conversion.ready;
  controller.abort();
  conversion.finish();
  await rejected;
  assert.equal(transcribe.mock.callCount(), 0);
});

test("an active request times out without awaiting cancellation IPC", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conversion = deferredConversion(t, "openai");
  const started = deferred<void>();
  t.mock.method(voiceApi, "transcribe", () => {
    started.resolve();
    return new Promise<string>(() => {});
  });
  const cancel = t.mock.method(voiceApi, "cancelTranscription", () => new Promise<void>(() => {}));
  const pending = transcribeBlob(new Blob(["audio"]), {
    provider: "openai",
    operationId: "active-timeout",
  });
  const rejected = assert.rejects(pending, /took too long/u);
  await conversion.ready;
  conversion.finish();
  await started.promise;
  t.mock.timers.tick(transcriptionBudgetMs("openai"));
  await rejected;
  assert.deepEqual(
    cancel.mock.calls.map((call) => call.arguments),
    [["active-timeout"]],
  );
});
