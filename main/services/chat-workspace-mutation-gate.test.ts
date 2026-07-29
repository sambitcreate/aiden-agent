import assert from "node:assert/strict";
import test from "node:test";
import { ChatWorkspaceMutationGate } from "./chat-workspace-mutation-gate.js";

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("a delayed generation initialization keeps an empty-chat workspace move closed", async () => {
  const gate = new ChatWorkspaceMutationGate();
  const setupStarted = deferred();
  const releaseSetup = deferred();
  let busy = false;

  const initialize = async () => {
    assert.equal(gate.isChanging("chat-1"), false);
    busy = true;
    setupStarted.resolve();
    await releaseSetup.promise;
    busy = false;
  };

  const initialization = initialize();
  await setupStarted.promise;
  assert.equal(gate.tryBegin("chat-1", busy), null);
  releaseSetup.resolve();
  await initialization;

  const finishMove = gate.tryBegin("chat-1", busy);
  assert.ok(finishMove);
  assert.equal(gate.isChanging("chat-1"), true);
  finishMove();
  assert.equal(gate.isChanging("chat-1"), false);
});

test("workspace-move ownership closes generation admission until the move settles", () => {
  const gate = new ChatWorkspaceMutationGate();
  const finishMove = gate.tryBegin("chat-1", false);
  assert.ok(finishMove);
  assert.equal(gate.isChanging("chat-1"), true);
  assert.equal(gate.tryBegin("chat-1", false), null);
  assert.equal(gate.isChanging("chat-2"), false);
  finishMove();
  finishMove();
  assert.equal(gate.isChanging("chat-1"), false);
});
