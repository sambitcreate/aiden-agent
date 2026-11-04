import assert from "node:assert/strict";
import { test } from "node:test";
import { botPlanItemView, botPlanProgress, parseBotPlanResponse } from "./bot-plans.js";

test("connector line names the app, action, cap and live tool titles", () => {
  assert.deepEqual(botPlanItemView({ id: "i1", kind: "connector", app: "Google Calendar", action: "create events", max: 5,
    tools: [{ modelName: "gcal__create_event", serverId: "s", remoteName: "create_event", title: "Create event" }] }, 2),
  { id: "i1", line: "Google Calendar · create events (up to 5)", details: ["Create event"], used: 2, max: 5 });
});

test("folder grant copy distinguishes read from change and limits its lifetime", () => {
  for (const [access, verb, detail] of [["read", "read", "Read only"], ["write", "change", "Read and change"]] as const) {
    assert.deepEqual(botPlanItemView({ id: "i1", kind: "files", path: "~/Documents/Taxes", access, grant: true }, 9), {
      id: "i1", line: `Files · ${verb} ~/Documents/Taxes for this plan`,
      details: ["~/Documents/Taxes", `${detail} · allowed once, for this plan only`],
    });
  }
});

test("progress counts done and skipped steps", () => {
  assert.deepEqual(botPlanProgress({ steps: [{ text: "A", status: "done" }, { text: "B", status: "skipped" }, { text: "C", status: "pending" }] }), { done: 2, total: 3 });
});

test("only counted items expose used and max", () => {
  assert.deepEqual(botPlanItemView({ id: "i1", kind: "shell" }, 3), { id: "i1", line: "Commands · in its own folder", details: [] });
  assert.deepEqual(botPlanItemView({ id: "i2", kind: "rule", ruleId: "default.purchase", ruleFingerprint: "fp", label: "Make a purchase or booking", max: 10 }, 2), {
    id: "i2", line: "Rule · Make a purchase or booking (up to 10)", details: ["Steps your rule “Make a purchase or booking” would ask about"], used: 2, max: 10,
  });
  assert.deepEqual(botPlanItemView({ id: "i3", kind: "site", host: "example.com", max: 4 }, 1), {
    id: "i3", line: "example.com · click and type (up to 4)", details: ["Clicks, typing and key presses on example.com and its subdomains"], used: 1, max: 4,
  });
});

test("response parser refuses malformed decisions, identifiers and extra keys", () => {
  assert.deepEqual(parseBotPlanResponse({ botId: "b", planId: "p", decision: "stop" }), { botId: "b", planId: "p", decision: "stop" });
  for (const value of [null, [], { botId: "b", planId: "p", decision: "allow" }, { botId: "b", planId: "p", decision: "approve", extra: 1 }, { botId: "", planId: "p", decision: "approve" }, { botId: "b", planId: "../p", decision: "stop" }]) {
    assert.throws(() => parseBotPlanResponse(value));
  }
});

test("plan responses accept production Bot identities and refuse path/control characters", () => {
  const botId = "bot:1cb9c9cc-ffb2-41b2-9df9-b329ba7897de";
  assert.deepEqual(parseBotPlanResponse({ botId, planId: "p", decision: "approve" }), { botId, planId: "p", decision: "approve" });
  const longest = `bot:${"x".repeat(156)}`;
  assert.equal(parseBotPlanResponse({ botId: longest, planId: "p", decision: "stop" }).botId, longest);
  for (const invalid of [longest + "x", "../bot", "bot/../other", "bot\\other", "bot:\u0000escape", "bot:\nnext", "bot:\u202ehidden"]) {
    assert.throws(() => parseBotPlanResponse({ botId: invalid, planId: "p", decision: "approve" }));
  }
});
