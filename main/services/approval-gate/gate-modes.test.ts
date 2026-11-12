// Phase 2's gate order table (plan §3.2): one case per step and per tool
// class, under each mode. Every expected value is the plan's rule written out,
// not the gate's own code.

import assert from "node:assert/strict";
import test from "node:test";

import type { ApprovalMode } from "../../../renderer/shared/approval-mode.js";
import { planActionGate, type GateAction, type GateContext, type GateDecision } from "./gate.js";

const MODES: readonly ApprovalMode[] = ["ask", "auto", "never"];
const context = (mode: ApprovalMode, extra: Partial<GateContext> = {}): GateContext => ({
  surface: "workspace",
  access: "ask",
  mode,
  judge: true,
  ...extra,
});

/** Short form of a decision for the table. */
function outcome(decision: GateDecision): string {
  switch (decision.outcome) {
    case "allow":
      return `allow@${decision.step}`;
    case "ask":
      return `ask@${decision.step}`;
    case "block":
      return `block@${decision.step}:${decision.reason}`;
    case "lookup":
      return `lookup:${decision.lookup}`;
    case "hand-off":
      return "hand-off";
    case "delegate":
      return `delegate:${decision.to}`;
  }
}

const SEND: GateAction = { toolName: "gmail_send_email", consequential: true };
const SHELL: GateAction = { toolName: "run_command", consequential: true, mac: true, macClass: "shell" };
const FILES: GateAction = { toolName: "edit_file", consequential: true, mac: true, macClass: "files" };
const SHARE: GateAction = { toolName: "share_image", explicitOnly: true };
const SCHEDULE: GateAction = { toolName: "schedule", explicitOnly: true, consequential: true };
const MEMORY: GateAction = { toolName: "bot_memory", exempt: true, consequential: true };
const READ: GateAction = { toolName: "read_file" };
const FETCH_NEW: GateAction = { toolName: "web_fetch", newDestination: true };

// [case, action, extra context, { ask, auto (before the judge), never }]
const TABLE: ReadonlyArray<[string, GateAction, Partial<GateContext>, Record<ApprovalMode, string>]> = [
  // Step 1: block.
  ["hook deny", SEND, { hook: "deny" }, { ask: "block@block:hook", auto: "block@block:hook", never: "block@block:hook" }],
  ["declined earlier in the run", { ...SEND, declinedInRun: true }, {}, { ask: "block@block:declined", auto: "block@block:declined", never: "block@block:declined" }],
  // Step 2: money and hand-off rules.
  ["purchase rule", { ...SEND, rule: { behavior: "hand_off", locked: true } }, {}, { ask: "hand-off", auto: "hand-off", never: "hand-off" }],
  // Step 3: explicit-only, never judged, asks in Never ask too (deviations b and e).
  ["disclosure tool", SHARE, {}, { ask: "ask@explicit-only", auto: "ask@explicit-only", never: "ask@explicit-only" }],
  ["schedule mutation", SCHEDULE, {}, { ask: "ask@explicit-only", auto: "ask@explicit-only", never: "ask@explicit-only" }],
  ["hook ask", SEND, { hook: "ask" }, { ask: "ask@explicit-only", auto: "ask@explicit-only", never: "ask@explicit-only" }],
  // Exempt: a Bot's own things.
  ["exempt", MEMORY, {}, { ask: "allow@exempt", auto: "allow@exempt", never: "allow@exempt" }],
  // Step 4: Never ask.
  ["consequential", SEND, {}, { ask: "ask@consequential", auto: "lookup:judge", never: "allow@never-ask" }],
  // Step 5: ask rule (only Block rules apply in Never ask).
  ["ask rule", { ...SEND, rule: { behavior: "ask", locked: false } }, {}, { ask: "ask@ask-rule", auto: "ask@ask-rule", never: "allow@never-ask" }],
  // Step 6: new destination after outside content.
  ["new destination", FETCH_NEW, {}, { ask: "ask@new-destination", auto: "lookup:judge", never: "allow@never-ask" }],
  // Step 7: always allow.
  ["shell, allowed in this workspace", { ...SHELL, macGranted: true }, {}, { ask: "allow@always-allow", auto: "allow@always-allow", never: "allow@never-ask" }],
  // Step 8: the Mac asks in every mode and is never judged.
  ["shell, first use", SHELL, {}, { ask: "ask@consequential", auto: "ask@consequential", never: "ask@consequential" }],
  ["files, first use", FILES, {}, { ask: "ask@consequential", auto: "ask@consequential", never: "ask@consequential" }],
  ["computer use, no grant", { toolName: "computer_use", consequential: true, mac: true, macClass: "computer-use" }, {}, { ask: "ask@consequential", auto: "ask@consequential", never: "ask@consequential" }],
  // Step 9: reads run.
  ["read", READ, {}, { ask: "allow@default", auto: "allow@default", never: "allow@default" }],
];

for (const [name, action, extra, expected] of TABLE) {
  test(`gate order: ${name}`, () => {
    for (const mode of MODES) {
      assert.equal(outcome(planActionGate(context(mode, extra), action)), expected[mode], `${name} in ${mode}`);
    }
  });
}

test("the judge's pass allows a consequential call and a new destination in Auto; its defer shows the card", () => {
  assert.equal(outcome(planActionGate(context("auto"), { ...SEND, judge: "pass" })), "allow@consequential");
  assert.equal(outcome(planActionGate(context("auto"), { ...SEND, judge: "defer" })), "ask@consequential");
  assert.equal(outcome(planActionGate(context("auto"), { ...FETCH_NEW, judge: "pass" })), "allow@new-destination");
  assert.equal(outcome(planActionGate(context("auto"), { ...FETCH_NEW, judge: "defer" })), "ask@new-destination");
});

test("a pass from the judge never reaches an explicit-only tool or the person's Mac", () => {
  for (const action of [SHARE, SCHEDULE, SHELL, FILES]) {
    const decision = planActionGate(context("auto"), { ...action, judge: "pass" });
    assert.equal(decision.outcome, "ask", action.toolName);
  }
});

test("a remembered exact action is read before the judge and answers without a model call", () => {
  const rememberable: GateAction = { ...SEND, rememberable: true };
  assert.equal(outcome(planActionGate(context("auto"), rememberable)), "lookup:remembered");
  assert.equal(outcome(planActionGate(context("auto"), { ...rememberable, remembered: "always" })), "allow@always-allow");
  assert.equal(outcome(planActionGate(context("auto"), { ...rememberable, remembered: "none" })), "lookup:judge");
});

test("a Mac card offers the Mac grant for its part of the Mac", () => {
  const decision = planActionGate(context("ask"), SHELL);
  assert.equal(decision.outcome === "ask" && decision.offer, "mac");
});

test("a legacy context with no mode keeps its access's behaviour: Full is Never ask, but never answers a rule", () => {
  const full: GateContext = { surface: "bot", access: "full" };
  assert.equal(outcome(planActionGate(full, SEND)), "allow@never-ask");
  assert.equal(outcome(planActionGate(full, { ...SEND, rule: { behavior: "ask", locked: false } })), "ask@ask-rule");
  assert.equal(outcome(planActionGate({ surface: "workspace", access: "ask" }, SEND)), "ask@consequential");
});
