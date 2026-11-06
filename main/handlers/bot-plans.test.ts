import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { BOT_PLAN_CHANNELS } from "../../renderer/shared/bot-plans.js";
import { createBotPlans } from "../services/bot-plans/plans.js";
import { botPlanProposalFingerprint, type BotPlanProposal } from "../services/bot-plans/validate.js";
import { registerBotPlanHandlers } from "./bot-plans.js";

const botId = "bot:chief", planId = "plan-1";
async function fixture(t: TestContext) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "bot-plan-ipc-"));
  const plans = createBotPlans({ profileDir, knownBot: async id => id === botId, revalidate: async () => {}, revokeAccess() {} });
  t.after(async () => { await plans.forgetBot(botId); await rm(profileDir, { recursive: true, force: true }); });
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerBotPlanHandlers({ handle: (channel, handler) => handlers.set(channel, handler), plans });
  const invoke = (input: unknown) => Promise.resolve(handlers.get(BOT_PLAN_CHANNELS.respond)!({}, input));
  const proposal: BotPlanProposal = { title: "Prepare the report", why: "Finish the requested task", steps: ["Write the report"], items: [{ id: "i1", kind: "shell" }], authorization: { policyRevision: "policy-1", bindingRevision: "binding-1", rules: [], proposalFingerprint: "" } };
  proposal.authorization.proposalFingerprint = botPlanProposalFingerprint(proposal);
  const request = plans.request({ botId, planId, toolCallId: "call-1", proposal, requestIds: ["person-1"], signal: undefined });
  assert.equal((await plans.current(botId))?.status, "pending");
  return { plans, invoke, request };
}

test("plan IPC approves the captured request once and Stop ends only that plan", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.invoke({ botId: "bot:other", planId, decision: "approve" }), { result: "not_waiting" });
  assert.equal((await f.plans.current(botId))?.status, "pending");
  assert.deepEqual(await f.invoke({ botId, planId, decision: "approve" }), { result: "done" });
  assert.equal((await f.request).status, "approved");
  assert.equal((await f.plans.current(botId))?.status, "active");
  assert.deepEqual(await f.invoke({ botId, planId, decision: "approve" }), { result: "not_waiting" });
  assert.deepEqual(await f.invoke({ botId, planId: "another-plan", decision: "stop" }), { result: "not_waiting" });
  assert.equal((await f.plans.current(botId))?.status, "active");
  assert.deepEqual(await f.invoke({ botId, planId, decision: "stop" }), { result: "done" });
  assert.equal((await f.plans.current(botId))?.status, "stopped");
});

test("Not now settles a waiting plan without creating active coverage", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.invoke({ botId, planId, decision: "not_now" }), { result: "done" });
  assert.deepEqual(await f.request, { status: "declined" });
  assert.equal(await f.plans.current(botId), null);
  assert.deepEqual(await f.invoke({ botId, planId, decision: "approve" }), { result: "not_waiting" });
});

test("plan IPC refuses malformed answers before affecting the waiting request", async t => {
  const f = await fixture(t), valid = { botId, planId, decision: "approve" };
  for (const input of [null, [], { ...valid, decision: "allow" }, { ...valid, planId: "../other" }, { ...valid, botId: "../other" }, { ...valid, proposal: { title: "Different work" } }, { ...valid, authorization: { policyRevision: "new" } }]) {
    await assert.rejects(f.invoke(input), /Invalid plan response/u);
    assert.equal((await f.plans.current(botId))?.status, "pending");
  }
  assert.deepEqual(await f.invoke({ botId, planId, decision: "not_now" }), { result: "done" });
  await f.request;
});
