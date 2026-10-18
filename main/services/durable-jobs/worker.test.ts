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

test("shutdown still waits for a cancelled attempt after the same job is reclaimed", async (t) => {
  const f = fixture(t);
  const release = deferred();
  let reserved = false;
  let executions = 0;
  const runtime: DurableJobRuntime = {
    validateInput: async () => undefined,
    // The chat stays reserved until the first attempt's runtime settles, so a reclaim cannot run it.
    acquire: async (job) => {
      if (reserved) return null;
      reserved = true;
      let current = evidence("not_started");
      return {
        evidence: async () => current,
        appendInput: async (context) => {
          context.beforeCommit();
          return { ...checkpoint, inputMessageId: job.input.messageId };
        },
        execute: async (context) => {
          context.beforeEffect();
          executions += 1;
          // This runtime does not settle on abort.
          await release.promise;
          current = evidence("completed");
          return current;
        },
        close: async () => {
          reserved = false;
        },
      };
    },
  };
  const service = new DurableJobService(f.store, runtime);
  const worker = new DurableJobWorker(service, () => undefined);
  t.after(async () => {
    release.resolve();
    await worker.stop();
  });

  const job = await service.enqueue(input, "actor", "job");
  const first = worker.tick();
  await until("the first attempt to run", () => executions === 1);
  f.store.control({ actor: "actor", key: "cancel", jobId: job.id, expectedRevision: f.store.get(job.id).revision, action: "cancel" });
  worker.notifyControl(job.id);
  // The cancel released the lease, so a later tick reclaims the job to reconcile it.
  await worker.tick();
  assert.equal(executions, 1, "the reclaim never runs the job again");

  assert.equal(await worker.stop(0), false, "the first attempt still holds the chat");
  release.resolve();
  await first;
  assert.equal(reserved, false);
});
