import assert from "node:assert/strict";
import test from "node:test";
import { BotMutationGate } from "./bot-mutation-gate.js";

test("bot lifecycle mutations cannot interleave with bot-bound chat creation", async () => {
  const gate = new BotMutationGate();
  const order: string[] = [];
  let releaseCreate!: () => void;
  const createHeld = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const creating = gate.run("bot-1", async () => {
    order.push("create-start");
    await createHeld;
    order.push("create-end");
  });
  const archiving = gate.run("bot-1", async () => {
    order.push("archive");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["create-start"]);
  releaseCreate();
  await Promise.all([creating, archiving]);
  assert.deepEqual(order, ["create-start", "create-end", "archive"]);
});
