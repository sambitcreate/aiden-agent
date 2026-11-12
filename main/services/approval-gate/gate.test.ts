// The gate's step order: where two steps disagree, the earlier one wins.
// The surfaces' full behaviour is pinned by decision-table.test.ts.

import assert from "node:assert/strict";
import test from "node:test";

import { planActionGate, type GateAction, type GateContext } from "./gate.js";

const WORKSPACE_ASK: GateContext = { surface: "workspace", access: "ask" };
const WORKSPACE_FULL: GateContext = { surface: "workspace", access: "full" };
const BOT: GateContext = { surface: "bot", access: "ask" };
const RUN: GateAction = { toolName: "run_command", consequential: true };

test("a hook's deny wins over every later step", () => {
  for (const action of [
    RUN,
    { ...RUN, explicitOnly: true },
    { ...RUN, granted: true },
    { toolName: "remember_fact", delegate: "memory" as const },
    { toolName: "send", rule: { behavior: "hand_off" as const, locked: true } },
  ]) {
    assert.deepEqual(planActionGate({ ...WORKSPACE_FULL, hook: "deny" }, action), { outcome: "block", step: "block", reason: "hook" });
  }
});

test("a decline earlier in the run is not asked again", () => {
  assert.deepEqual(planActionGate(WORKSPACE_ASK, { ...RUN, mac: true, declinedInRun: true }), {
    outcome: "block",
    step: "block",
    reason: "declined",
  });
});

test("hand-off rules beat explicit-only cards and pre-approvals", () => {
  const handOff: GateAction = { toolName: "pay", consequential: true, explicitOnly: true, rule: { behavior: "hand_off", locked: true } };
  assert.deepEqual(planActionGate(BOT, handOff), { outcome: "hand-off", step: "money" });
  assert.deepEqual(planActionGate({ ...BOT, attendance: "routine", routineGoAhead: true }, handOff), {
    outcome: "block",
    step: "money",
    reason: "needs-person",
  });
});

test("explicit-only tools ask once even with Full access or a hook's allow", () => {
  const share: GateAction = { toolName: "share_image", explicitOnly: true };
  assert.deepEqual(planActionGate(WORKSPACE_FULL, share), { outcome: "ask", step: "explicit-only", offer: "once" });
  assert.deepEqual(planActionGate({ ...WORKSPACE_ASK, hook: "allow" }, share), { outcome: "ask", step: "explicit-only", offer: "once" });
});

test("a hook's ask is an explicit-only card that never offers remembered scopes", () => {
  assert.deepEqual(planActionGate({ ...WORKSPACE_ASK, hook: "ask" }, { ...RUN, rememberable: true, remembered: "always" }), {
    outcome: "ask",
    step: "explicit-only",
    offer: "once",
  });
});

test("Full access allows consequential tools but never the person's Mac", () => {
  assert.deepEqual(planActionGate(WORKSPACE_FULL, RUN), { outcome: "allow", step: "never-ask", via: "full-access" });
  assert.deepEqual(planActionGate(WORKSPACE_FULL, { toolName: "computer_use", consequential: true, mac: true }), {
    outcome: "ask",
    step: "consequential",
    offer: "once",
  });
});

test("a remembered approval is read only where it would answer, then allows", () => {
  const rememberable: GateAction = { ...RUN, rememberable: true };
  assert.deepEqual(planActionGate(WORKSPACE_FULL, rememberable), { outcome: "allow", step: "never-ask", via: "full-access" });
  assert.deepEqual(planActionGate(WORKSPACE_ASK, rememberable), { outcome: "lookup", step: "always-allow", lookup: "remembered" });
  assert.deepEqual(planActionGate(WORKSPACE_ASK, { ...rememberable, remembered: "chat" }), {
    outcome: "allow",
    step: "always-allow",
    via: "remembered",
  });
  assert.deepEqual(planActionGate(WORKSPACE_ASK, { ...rememberable, remembered: "none" }), {
    outcome: "ask",
    step: "consequential",
    offer: "workspace-scopes",
  });
});

test("a Bot's rule asks before its allow list is read, and a rule-made card nobody can answer is refused", () => {
  const ruled: GateAction = { toolName: "send_email", consequential: true, allowListAvailable: true, rule: { behavior: "ask", locked: false } };
  assert.deepEqual(planActionGate(BOT, ruled), { outcome: "ask", step: "ask-rule", offer: "rule" });
  const ruledOnly: GateAction = { toolName: "click", rule: { behavior: "ask", locked: false } };
  assert.deepEqual(planActionGate({ ...BOT, attendance: "unattended" }, ruledOnly), {
    outcome: "block",
    step: "ask-rule",
    reason: "unattended-rule",
  });
  assert.deepEqual(planActionGate({ ...BOT, attendance: "bot-message" }, ruledOnly), { outcome: "ask", step: "ask-rule", offer: "rule" });
});

test("a plan's cover is asked for before the allow list, and covers the call", () => {
  const action: GateAction = { toolName: "send_email", consequential: true, planAvailable: true, allowListAvailable: true };
  assert.deepEqual(planActionGate(BOT, action), { outcome: "lookup", step: "never-ask", lookup: "plan" });
  assert.deepEqual(planActionGate(BOT, { ...action, plan: "covered" }), { outcome: "allow", step: "never-ask", via: "plan" });
  assert.deepEqual(planActionGate(BOT, { ...action, plan: "not-covered" }), { outcome: "lookup", step: "always-allow", lookup: "allow-list" });
  assert.deepEqual(planActionGate(BOT, { ...action, plan: "not-covered", allowList: "no-match" }), {
    outcome: "ask",
    step: "consequential",
    offer: "bot-remember",
  });
});

test("another Bot's delegated work is refused rather than asking", () => {
  assert.deepEqual(planActionGate({ ...BOT, attendance: "peer" }, { toolName: "send_email", consequential: true, planAvailable: true }), {
    outcome: "block",
    step: "block",
    reason: "peer",
  });
});

test("an ACP agent or subagent without folder access is refused; a workspace chat's own tools are not", () => {
  for (const access of ["read-only", "none"] as const) {
    assert.equal(planActionGate({ surface: "acp", access }, { toolName: "acp:edit", consequential: true }).outcome, "block");
    assert.equal(planActionGate({ surface: "subagent", access }, { toolName: "subagent_run_grant", consequential: true }).outcome, "block");
    assert.equal(planActionGate({ surface: "workspace", access }, RUN).outcome, "allow");
  }
});

test("calls that change nothing run without a card", () => {
  assert.deepEqual(planActionGate(WORKSPACE_ASK, { toolName: "read_file" }), { outcome: "allow", step: "default" });
});
