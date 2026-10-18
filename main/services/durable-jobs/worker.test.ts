import assert from "node:assert/strict";
import test from "node:test";
import { DurableJobService, type DurableJobRuntime } from "./service.js";
import { DurableJobWorker } from "./worker.js";
import { checkpoint, deferred, evidence, fixture, input } from "./test-fixture.js";

async function until(description: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

test("a long-running job does not stop the worker from claiming a later job", async (t) => {
  const f = fixture(t);
  const started: string[] = [];
  const releaseFirst = deferred();
  const runtime: DurableJobRuntime = {
    validateInput: async () => undefined,
    acquire: async (job) => {
      let current = evidence("not_started");
      return {
        evidence: async () => current,
        appendInput: async (context) => {
          context.beforeCommit();
          return { ...checkpoint, inputMessageId: job.input.messageId };
        },
        execute: async (context) => {
          context.beforeEffect();
          started.push(job.input.chatId);
          if (job.input.chatId === "chat-long") await releaseFirst.promise;
          current = evidence("completed");
          return current;
        },
        close: async () => undefined,
      };
    },
  };
  const service = new DurableJobService(f.store, runtime);
  const errors: unknown[] = [];
  const worker = new DurableJobWorker(service, (error) => void errors.push(error));
  t.after(async () => {
    releaseFirst.resolve();
    await worker.stop();
  });

  const long = await service.enqueue({ ...input, chatId: "chat-long" }, "actor", "long");
  const firstTick = worker.tick();
  await until("the long job to start", () => started.includes("chat-long"));
  const short = await service.enqueue(
    { ...input, chatId: "chat-short", messageId: "message-short", turnId: "turn-short" },
    "actor",
    "short",
  );
  const secondTick = worker.tick();
  await until("the later job to be claimed", () => f.store.get(short.id).state === "succeeded");

  assert.deepEqual(started, ["chat-long", "chat-short"]);
  assert.notEqual(f.store.get(long.id).state, "succeeded", "the long job is still running");
  releaseFirst.resolve();
  await Promise.all([firstTick, secondTick]);
  assert.equal(f.store.get(long.id).state, "succeeded");
  assert.deepEqual(errors, []);
});
