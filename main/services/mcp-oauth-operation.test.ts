import assert from "node:assert/strict";
import test from "node:test";
import { McpOAuthOperationGate } from "./mcp-oauth-operation.js";

test("background OAuth cannot mutate PKCE while interactive authorization owns the server", () => {
  const gate = new McpOAuthOperationGate();
  gate.begin("linear");
  assert.throws(() => gate.assertMutationAllowed("linear", false), /in progress/);
  assert.doesNotThrow(() => gate.assertMutationAllowed("linear", true));
  assert.doesNotThrow(() => gate.assertMutationAllowed("notion", false));
  gate.end("linear");
  assert.doesNotThrow(() => gate.assertMutationAllowed("linear", false));
});

test("duplicate interactive authorization is rejected", () => {
  const gate = new McpOAuthOperationGate();
  gate.begin("linear");
  assert.throws(() => gate.begin("linear"), /already in progress/);
});
