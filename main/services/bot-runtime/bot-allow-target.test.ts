import assert from "node:assert/strict";
import { test } from "node:test";
import { botApprovalRuleKey } from "../../../renderer/shared/tool-approval-scope.js";
import type { BotClassifiableAction } from "../bot-rules/classify.js";
import { botApprovalTargetOf } from "./bot-allow-target.js";

const connection: BotClassifiableAction = {
  surface: "mcp", modelName: "gcal__create_event", serverId: "gcal", remoteName: "create_event",
  summary: "Create event", destructive: "additive", annotations: { title: "Create event" },
};

test("a connection class uses the exact server and remote tool, with a bounded plain title", () => {
  assert.deepEqual(botApprovalTargetOf("gcal__create_event", connection), {
    target: { kind: "connection", serverId: "gcal", tool: "create_event" }, title: "Create event",
  });
  assert.equal(botApprovalTargetOf("gcal__create_event", { ...connection, annotations: undefined })?.title, "create_event");
  assert.equal(botApprovalTargetOf("gcal__create_event", { ...connection, annotations: { title: " \u202ECreate\n event\u0000 " } })?.title, "Create event");
  assert.equal(botApprovalTargetOf("gcal__create_event", { ...connection, annotations: { title: "x".repeat(300) } })?.title.length, 200);
});

test("site classes normalize letter case and one leading www, preserving exact host and action", () => {
  const first = botApprovalTargetOf("browser_click", { surface: "browser", tool: "browser_click", url: "https://WWW.Amazon.com/cart" });
  const second = botApprovalTargetOf("browser_click", { surface: "browser", tool: "browser_click", url: "https://amazon.com/" });
  assert.deepEqual(first, { target: { kind: "site", host: "amazon.com", action: "click" }, title: "amazon.com" });
  assert.equal(botApprovalRuleKey(first!.target), botApprovalRuleKey(second!.target));
  for (const action of ["type", "press"] as const) {
    assert.deepEqual(botApprovalTargetOf(`browser_${action}`, { surface: "browser", tool: `browser_${action}`, url: "http://mail.amazon.com:8080/" })?.target,
      { kind: "site", host: "mail.amazon.com", action });
  }
});

test("unsupported surfaces, tools, identities and URLs have no class", () => {
  for (const name of ["computer_use", "computer", "computer_shell", "run_command", "share_image"]) {
    assert.equal(botApprovalTargetOf(name, connection), undefined);
  }
  assert.equal(botApprovalTargetOf("browser_click", undefined), undefined);
  assert.equal(botApprovalTargetOf("computer", { surface: "computer", action: "click" }), undefined);
  for (const serverId of ["", "bad\nserver", "x".repeat(257)]) {
    assert.equal(botApprovalTargetOf("gcal__create_event", { ...connection, serverId }), undefined);
  }
  for (const url of ["file:///x", "about:blank", "javascript:alert(1)", "broken", "https://[::1]/"]) {
    assert.equal(botApprovalTargetOf("browser_click", { surface: "browser", tool: "browser_click", url }), undefined);
  }
  assert.equal(botApprovalTargetOf("browser_type", { surface: "browser", tool: "browser_click", url: "https://amazon.com" }), undefined);
});


test("payment providers never become remembered classes, while ordinary sibling sites stay eligible", () => {
  for (const host of ["pay.google.com", "checkout.shopify.com", "pay.shopify.com", "paypal.com", "pay.google.com."]) {
    assert.equal(botApprovalTargetOf("browser_click", { surface: "browser", tool: "browser_click", url: `https://${host}/checkout` }), undefined, host);
  }
  assert.deepEqual(botApprovalTargetOf("browser_click", { surface: "browser", tool: "browser_click", url: "https://mail.google.com/inbox" })?.target,
    { kind: "site", host: "mail.google.com", action: "click" });
});
