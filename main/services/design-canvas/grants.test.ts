import assert from "node:assert/strict";
import test from "node:test";
import { DesignGrantRegistry } from "./grants.js";

test("a grant is stable for the same chat and root and resolves back to both", () => {
  const grants = new DesignGrantRegistry();
  const grant = grants.issue("chat-1", "/work/site");
  assert.equal(grants.issue("chat-1", "/work/site"), grant);
  assert.deepEqual(grants.resolve(grant), { chatId: "chat-1", workspaceRoot: "/work/site" });
  // Chromium lowercases standard-scheme hosts, so the grant must survive that.
  assert.equal(grant, grant.toLowerCase());
  assert.notEqual(grants.issue("chat-2", "/work/site"), grant);
});

test("a new root for the same chat issues a new grant and revokes the old one", () => {
  const grants = new DesignGrantRegistry();
  const first = grants.issue("chat-1", "/work/a");
  const second = grants.issue("chat-1", "/work/b");
  assert.notEqual(second, first);
  assert.equal(grants.resolve(first), null);
  assert.deepEqual(grants.resolve(second), { chatId: "chat-1", workspaceRoot: "/work/b" });
});

test("revoking a chat, a root or everything makes its grants resolve to null", () => {
  const grants = new DesignGrantRegistry();
  const one = grants.issue("chat-1", "/work/a");
  const two = grants.issue("chat-2", "/work/a");
  const three = grants.issue("chat-3", "/work/b");
  grants.revokeChat("chat-1");
  assert.equal(grants.resolve(one), null);
  assert.notEqual(grants.resolve(two), null);
  grants.revokeRoot("/work/a/");
  assert.equal(grants.resolve(two), null);
  assert.notEqual(grants.resolve(three), null);
  grants.revokeAll();
  assert.equal(grants.resolve(three), null);
  assert.notEqual(grants.issue("chat-1", "/work/a"), one);
});

test("a chat holds a grant only for the root it was issued and until it is revoked", () => {
  const grants = new DesignGrantRegistry();
  grants.issue("chat-1", "/work/a");
  grants.issue("chat-2", "/work/b");
  assert.equal(grants.holds("chat-1", "/work/a"), true);
  assert.equal(grants.holds("chat-1", "/work/b"), false, "another root is not covered");
  assert.equal(grants.holds("chat-3", "/work/a"), false);
  grants.issue("chat-1", "/work/c");
  assert.equal(grants.holds("chat-1", "/work/a"), false, "a new root replaces the old grant");
  grants.revokeChat("chat-1");
  assert.equal(grants.holds("chat-1", "/work/c"), false);
  grants.revokeRoot("/work/b");
  assert.equal(grants.holds("chat-2", "/work/b"), false);
});

test("a guessed or malformed grant resolves to null", () => {
  const grants = new DesignGrantRegistry();
  const real = grants.issue("chat-1", "/work/a");
  for (const guess of [
    "a".repeat(52),
    real.toUpperCase(),
    `${real}x`,
    real.slice(1),
    "",
    "__proto__",
    "constructor",
    42,
    null,
  ]) {
    assert.equal(grants.resolve(guess as string), null, String(guess));
  }
});
