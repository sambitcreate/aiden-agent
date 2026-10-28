import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StartPiRuntimeOperationInput } from "./pi-runtime-effect-core.js";
import { PiRuntimeEffectStore } from "./pi-runtime-effect-store.js";
import { chatReplyInterrupted } from "./interrupted-reply.js";

function run(
  operationId: string,
  chatId: string,
  lane: StartPiRuntimeOperationInput["lane"] = "foreground",
): StartPiRuntimeOperationInput {
  return {
    operationId,
    runId: `run-${operationId}`,
    sessionId: `session-${chatId}`,
    chatId,
    lane,
    contributionRevision: 0,
  };
}

async function withStores(
  body: (open: () => Promise<PiRuntimeEffectStore>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-interrupted-reply-"));
  const opened: PiRuntimeEffectStore[] = [];
  let clock = 1_000;
  try {
    // Each open is a fresh launch reading the same run history.
    await body(async () => {
      const store = new PiRuntimeEffectStore({ root: () => directory, now: () => clock++ });
      opened.push(store);
      await store.initialize();
      return store;
    });
  } finally {
    await Promise.all(opened.map((store) => store.settleVerificationReceipts()));
    await rm(directory, { recursive: true, force: true });
  }
}

test("a reply still running at a crash is offered for resume on the next launch", async () => {
  await withStores(async (open) => {
    const before = await open();
    await before.startOperation(run("done", "chat"));
    await before.finishOperation("done", "completed");
    await before.startOperation(run("crashed", "chat"));
    assert.equal(await chatReplyInterrupted(before, "chat"), false, "a running reply is not interrupted");

    const after = await open();
    assert.equal(await chatReplyInterrupted(after, "chat"), true);
    assert.equal(await chatReplyInterrupted(after, "other-chat"), false);
  });
});

test("a quit offers resume, but a reply stopped or finished after it does not", async () => {
  await withStores(async (open) => {
    const store = await open();
    await store.startOperation(run("quit", "chat"));
    await store.finishOperation("quit", "interrupted");
    assert.equal(await chatReplyInterrupted(store, "chat"), true);

    await store.startOperation(run("stopped", "chat"));
    await store.finishOperation("stopped", "app_cancelled");
    assert.equal(await chatReplyInterrupted(store, "chat"), false);

    await store.startOperation(run("quit-again", "chat"));
    await store.finishOperation("quit-again", "interrupted");
    await store.startOperation(run("resumed", "chat"));
    await store.finishOperation("resumed", "completed");
    assert.equal(await chatReplyInterrupted(store, "chat"), false);
  });
});

test("subagent runs under the chat do not decide whether its reply was interrupted", async () => {
  await withStores(async (open) => {
    const store = await open();
    await store.startOperation(run("parent", "chat"));
    await store.finishOperation("parent", "interrupted");
    await store.startOperation(run("helper", "chat", "child"));
    await store.finishOperation("helper", "completed");
    assert.equal(await chatReplyInterrupted(store, "chat"), true);

    await store.startOperation(run("finished", "other"));
    await store.finishOperation("finished", "completed");
    await store.startOperation(run("helper-crash", "other", "child"));
    assert.equal(await chatReplyInterrupted(await open(), "other"), false);
  });
});
