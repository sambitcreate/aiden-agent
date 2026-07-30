import assert from "node:assert/strict";
import test from "node:test";
import { McpOAuthOperationGate } from "./mcp-oauth-operation.js";

test("background OAuth cannot mutate PKCE while interactive authorization owns the server", () => {
  const gate = new McpOAuthOperationGate();
  const background = gate.snapshot("linear");
  const operation = gate.begin("linear");
  assert.throws(() => gate.assertMutationAllowed("linear", background), /in progress/);
  assert.doesNotThrow(() => gate.assertMutationAllowed("linear", operation));
  assert.doesNotThrow(() => gate.assertMutationAllowed("notion", gate.snapshot("notion")));
  gate.end(operation);
  assert.doesNotThrow(() => gate.assertMutationAllowed("linear", gate.snapshot("linear")));
});

test("duplicate interactive authorization is rejected", () => {
  const gate = new McpOAuthOperationGate();
  gate.begin("linear");
  assert.throws(() => gate.begin("linear"), /already in progress/);
});

test("cleanup invalidates the old generation without letting its end clear a newer flow", () => {
  const gate = new McpOAuthOperationGate();
  const old = gate.begin("linear");
  gate.invalidate("linear");
  assert.equal(old.signal.aborted, true);
  assert.equal(gate.isCurrent(old), false);
  assert.throws(() => gate.assertMutationAllowed("linear", old), /in progress/);

  const current = gate.begin("linear");
  gate.end(old);
  assert.equal(gate.isCurrent(current), true);
  gate.end(current);
});

test("cleanup permanently invalidates a background refresh generation", () => {
  const gate = new McpOAuthOperationGate();
  const background = gate.snapshot("linear");
  assert.doesNotThrow(() => gate.assertMutationAllowed("linear", background));
  gate.invalidate("linear");
  assert.throws(() => gate.assertMutationAllowed("linear", background), /in progress/);
  assert.doesNotThrow(() => gate.assertMutationAllowed("linear", gate.snapshot("linear")));
});

test("cleanup suspension blocks new OAuth operations and every stale writer until release", () => {
  const gate = new McpOAuthOperationGate();
  const background = gate.snapshot("linear");
  const release = gate.suspend("linear");
  assert.throws(() => gate.begin("linear"), /being updated/u);
  assert.throws(() => gate.assertMutationAllowed("linear", background), /in progress/u);
  const duringCleanup = gate.snapshot("linear");
  assert.equal(gate.isCurrent(duringCleanup), false);
  release();
  assert.equal(gate.isCurrent(duringCleanup), false);
  const next = gate.begin("linear");
  assert.equal(gate.isCurrent(next), true);
});
