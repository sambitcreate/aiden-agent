import assert from "node:assert/strict";
import test from "node:test";
import { assertBrowserToolApproval, BrowserApprovalExpiredError, prepareBrowserToolApproval, type BrowserApprovalTarget } from "./approval.js";

const target: BrowserApprovalTarget = {
  workspaceId: "workspace", tabId: "tab-a", url: "https://example.test/settings",
  documentRevision: "1:1", controlRevision: 3,
};

test("approval binds omitted tabId to the exact reviewed tab and displays its page", () => {
  const args = { locator: "role=button[name='Save']" };
  const approval = prepareBrowserToolApproval("browser_click", args, target);
  assert.equal(approval.target.tabId, "tab-a");
  assert.match(approval.summary, /https:\/\/example\.test\/settings/);
  assertBrowserToolApproval(approval, "browser_click", { ...args, tabId: "tab-a" }, { ...target });
  assert.throws(() => assertBrowserToolApproval(approval, "browser_click", args, { ...target, tabId: "tab-b" }), BrowserApprovalExpiredError);
});

test("navigation start, same-URL reload, commit and human takeover expire approval", () => {
  const args = { locator: "role=button[name='Save']" };
  const approval = prepareBrowserToolApproval("browser_click", args, target);
  for (const change of [
    { documentRevision: "2:1" }, { documentRevision: "2:2" },
    { controlRevision: 4 }, { url: "https://other.test/settings" },
    { workspaceId: "other" },
  ]) {
    assert.throws(() => assertBrowserToolApproval(approval, "browser_click", args, { ...target, ...change }), BrowserApprovalExpiredError);
  }
});

test("approved action arguments cannot be changed or redirected after review", () => {
  const args = { text: "reviewed text", clear: true, locator: "input[name=title]" };
  const approval = prepareBrowserToolApproval("browser_type", args, target);
  for (const changed of [{ ...args, text: "different" }, { ...args, clear: false }, { ...args, tabId: "tab-b" }, { ...args, locator: "input[name=password]" }]) {
    assert.throws(() => assertBrowserToolApproval(approval, "browser_type", changed, target), BrowserApprovalExpiredError);
  }
  assert.throws(() => assertBrowserToolApproval(approval, "browser_evaluate", args, target), BrowserApprovalExpiredError);
  assertBrowserToolApproval(approval, "browser_type", { locator: args.locator, clear: true, text: args.text }, target);
});

test("captured target cannot drift with a mutable state object", () => {
  const state = { ...target };
  const approval = prepareBrowserToolApproval("browser_press", { key: "Enter" }, state);
  state.documentRevision = "5:5";
  assert.equal(approval.target.documentRevision, "1:1");
  assert.ok(Object.isFrozen(approval));
  assert.ok(Object.isFrozen(approval.target));
  assert.throws(() => assertBrowserToolApproval(approval, "browser_press", { key: "Enter" }, state), BrowserApprovalExpiredError);
});

test("invalid targets and non-mutating tools cannot mint this approval", () => {
  for (const invalid of [{ ...target, tabId: "" }, { ...target, controlRevision: NaN }, { ...target, documentRevision: "" }]) {
    assert.throws(() => prepareBrowserToolApproval("browser_click", { x: 1, y: 2 }, invalid), BrowserApprovalExpiredError);
  }
  assert.throws(() => prepareBrowserToolApproval("browser_snapshot", {}, target), BrowserApprovalExpiredError);
  assert.throws(() => prepareBrowserToolApproval("browser_click", { tabId: "tab-b", x: 1, y: 2 }, target), BrowserApprovalExpiredError);
});
