import assert from "node:assert/strict";
import { test } from "node:test";
import { createBotApprovals } from "../services/bot-runtime/bot-approvals.js";
import { registerBotApprovalDecisionHandler } from "./bot-approvals.js";

test("desktop Always answers retain the offered scope and provenance; unoffered scopes cannot widen a one-time request", async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const approvals = createBotApprovals({ publish() {} });
  registerBotApprovalDecisionHandler({ handle: (channel, handler) => handlers.set(channel, handler), approvals });
  const invoke = (input: unknown) => Promise.resolve().then(() => handlers.get("bots:approve")!({}, input));
  const base = { signal: undefined, botId: "bot:ada", toolCallId: "provider-reused", toolName: "calendar_create", summary: "Create event", authorizationFingerprint: "fingerprint" };
  const offered = approvals.request({ ...base, waitId: "offered", always: { key: "private-target-key", count: 3 } });
  assert.deepEqual(await invoke({ waitId: "offered", decision: "allow", scope: "always" }), { decided: true });
  assert.deepEqual(await offered, { id: "offered", authorizationFingerprint: "fingerprint", answer: "allow_always", source: "person" });
  assert.deepEqual(await invoke({ waitId: "offered", decision: "allow", scope: "always" }), { decided: false });
  const ordinary = approvals.request({ ...base, waitId: "ordinary" });
  await invoke({ waitId: "ordinary", decision: "allow", scope: "always" });
  assert.equal((await ordinary).answer, "allow", "an unoffered scope keeps the ordinary one-time allowance");
  const denied = approvals.request({ ...base, waitId: "denied" });
  await assert.rejects(invoke({ waitId: "denied", decision: "deny", scope: "always" }), /fields/u);
  assert.equal(approvals.pending()[0]?.waitId, "denied");
  await invoke({ waitId: "denied", decision: "deny" });
  assert.equal((await denied).answer, "deny");
});
