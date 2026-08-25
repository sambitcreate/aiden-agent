import assert from "node:assert/strict";
import test from "node:test";
import { ParakeetProcessClient } from "./parakeet-process-core.js";
import { PARAKEET_PROTOCOL_VERSION } from "./parakeet-protocol.js";

test("process client resolves a transcribe result and fails in-flight work on exit", async () => {
  const handlers: Array<(message: unknown) => void> = [];
  const exits: Array<(code: number) => void> = [];
  const sent: unknown[] = [];
  const client = new ParakeetProcessClient(
    {
      postMessage: (message) => {
        sent.push(message);
        const request = message as { requestId: string };
        queueMicrotask(() => {
          handlers[0]?.({
            version: PARAKEET_PROTOCOL_VERSION,
            kind: "result",
            requestId: request.requestId,
            text: "hello",
          });
        });
      },
      onMessage: (handler) => {
        handlers.push(handler);
        return () => {};
      },
      onExit: (handler) => {
        exits.push(handler);
        return () => {};
      },
      kill: () => {},
    },
    1_000,
  );
  assert.equal(
    await client.transcribe({
      modelId: "parakeet-v3",
      modelDirectory: "/tmp/model",
      pcmBase64: "AAA=",
      encoding: "float32le",
    }),
    "hello",
  );
  assert.equal(sent.length, 1);

  const pending = client.transcribe({
    modelId: "parakeet-v3",
    modelDirectory: "/tmp/model",
    pcmBase64: "AAA=",
    encoding: "pcm_s16le",
  });
  exits[0]?.(1);
  await assert.rejects(pending, /exited/u);
  client.dispose();
});
