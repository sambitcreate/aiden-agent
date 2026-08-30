import assert from "node:assert/strict";
import test from "node:test";
import { waitForBotAvatarBoundary } from "./bot-avatar-generator-core.js";
import { BotAvatarOperationRegistry } from "./bot-avatar-operation-registry.js";

test("avatar operations are single-flight per renderer document", () => {
  const registry = new BotAvatarOperationRegistry();
  const first = registry.admit("document-a", "request-1");

  assert.throws(() => registry.admit("document-a", "request-2"), /already being designed/u);
  assert.equal(first.signal.aborted, false);

  const independent = registry.admit("document-b", "request-3");
  assert.equal(independent.signal.aborted, false);
  independent.finish();
});

test("only the owning document and exact request id can cancel generation", () => {
  const registry = new BotAvatarOperationRegistry();
  const operation = registry.admit("document-a", "request-1");

  assert.equal(registry.cancel("document-b", "request-1"), false);
  assert.equal(registry.cancel("document-a", "request-2"), false);
  assert.equal(operation.signal.aborted, false);
  assert.equal(registry.cancel("document-a", "request-1"), true);
  assert.equal(operation.signal.aborted, true);

  assert.throws(() => registry.admit("document-a", "request-2"), /already being designed/u);
  operation.finish();
  registry.admit("document-a", "request-2").finish();
});

test("a cancelled hung dependency reaches handler cleanup and releases single-flight admission", async () => {
  const registry = new BotAvatarOperationRegistry();
  const operation = registry.admit("document-a", "request-1");
  const handler = waitForBotAvatarBoundary(
    new Promise<never>(() => {}),
    operation.signal,
  ).finally(operation.finish);

  assert.equal(registry.cancel("document-a", "request-1"), true);
  await assert.rejects(handler, { name: "AbortError" });
  assert.doesNotThrow(() => registry.admit("document-a", "request-2").finish());
});
