import assert from "node:assert/strict";
import { test } from "node:test";
import { createBotApprovals, publicBotApprovalPrompt } from "./bot-approvals.js";
import type { BotApprovalRequest, BotApprovalDecision, BotAllowListRelease } from "./bot-extension.js";
import { waitFor } from "./test-support/faux.js";

const target = { kind: "connection", serverId: "calendar", tool: "create_event" } as const;
const request = (waitId = "w1"): BotApprovalRequest => ({ botId: "bot-1", waitId, toolCallId: "provider-duplicate", toolName: "calendar__create_event",
  summary: "Create event", authorizationFingerprint: `fp-${waitId}`, signal: undefined });
const grant: BotAllowListRelease = { target, ruleId: "rule1", consentRevision: "published-generation" };

for (const offered of [true, false]) {
  test(`bridge: Always is honored only when offered (${offered})`, async () => {
    const bridge = createBotApprovals({ publish() {} });
    const input = { ...request(), ...(offered ? { always: { key: "k", count: 3 } } : {}) };
    const pending = bridge.request(input);
    assert.equal(bridge.pending()[0]?.always?.count, offered ? 3 : undefined);
    assert.equal(bridge.decide(input.waitId, "allow", "always"), true);
    assert.deepEqual(await pending, { id: "w1", authorizationFingerprint: "fp-w1", answer: offered ? "allow_always" : "allow", source: "person" });
    assert.deepEqual(bridge.pending(), []);
  });
}

test("bridge: deny ignores scope, and expiry remains host provenance", async () => {
  const bridge = createBotApprovals({ publish() {} });
  const denied = bridge.request({ ...request(), always: { key: "k", count: 3 } });
  bridge.decide("w1", "deny", "always", "expiry");
  assert.deepEqual(await denied, { id: "w1", authorizationFingerprint: "fp-w1", answer: "deny", source: "expiry" });
});

test("bridge: duplicated provider IDs cannot exchange scopes across attempts", async () => {
  const bridge = createBotApprovals({ publish() {} });
  const one = bridge.request({ ...request("one"), always: { key: "k", count: 3 } });
  const two = bridge.request(request("two"));
  bridge.decide("one", "allow", "always"); bridge.decide("two", "allow");
  assert.equal((await two).answer, "allow");
  assert.equal((await one).answer, "allow_always");
});

test("bridge: exact durable lookup replays without a card, but validates the live owner first", async () => {
  let published = 0, lookups = 0, current = true;
  const saved: BotApprovalDecision = { id: "w1", authorizationFingerprint: "fp-w1", answer: "allow", source: "person" };
  const bridge = createBotApprovals({ publish() { published++; }, lookupDecision: async () => { lookups++; return saved; } });
  const input = { ...request(), assertCurrent: async () => { if (!current) throw new Error("delivery expired"); } };
  assert.deepEqual(await bridge.request(input), saved);
  current = false;
  await assert.rejects(bridge.request(input), /delivery expired/u);
  assert.equal(lookups, 1); assert.equal(published, 0);
});

test("bridge: a mismatched saved decision cannot satisfy another fingerprint", async () => {
  const bridge = createBotApprovals({ publish() {}, lookupDecision: async () => ({ id: "w1", authorizationFingerprint: "old", answer: "allow", source: "person" }) });
  await assert.rejects(bridge.request(request()), /decision.*identity|fingerprint/iu);
});

test("bridge: eligible old cards without an offer release under a new automatic pair", async () => {
  const bridge = createBotApprovals({ publish() {} });
  const replacement: BotApprovalDecision = { id: "automatic-new", authorizationFingerprint: "new-fp", answer: "allow", source: "allow_list" };
  let prepared = 0;
  const pending = bridge.request({ ...request(), allowList: { target, requirementsFingerprint: "requirements", consentRevision: "old" },
    prepareAllowListRelease: async supplied => { assert.deepEqual(supplied, grant); prepared++; return replacement; } });
  const published = bridge.pending()[0]!;
  assert.equal(published.always, undefined);
  const publicPrompt = publicBotApprovalPrompt(published);
  assert.deepEqual(Object.keys(publicPrompt).sort(), ["botId", "waitId", "toolCallId", "toolName", "summary"].sort());
  assert.equal(await bridge.releaseFromAllowList("w1", grant), true);
  assert.deepEqual(await pending, replacement);
  assert.equal(await bridge.releaseFromAllowList("w1", grant), false);
  assert.equal(prepared, 1);
  assert.deepEqual(bridge.pending(), []);
});

test("bridge: release claims before awaiting, rejection restores the card, and abort wins safely", async () => {
  const bridge = createBotApprovals({ publish() {} });
  const controller = new AbortController();
  let complete!: (value: BotApprovalDecision | undefined) => void;
  const input = { ...request(), signal: controller.signal, allowList: { target, requirementsFingerprint: "req", consentRevision: "old" },
    prepareAllowListRelease: () => new Promise<BotApprovalDecision | undefined>(resolve => { complete = resolve; }) };
  const pending = bridge.request(input);
  const first = bridge.releaseFromAllowList("w1", grant);
  assert.equal(bridge.decide("w1", "deny"), false);
  complete(undefined); assert.equal(await first, false);
  assert.equal(bridge.pending().length, 1);
  const second = bridge.releaseFromAllowList("w1", grant);
  const rejection = assert.rejects(pending, /stop/u);
  controller.abort(new Error("stop")); await rejection;
  complete({ id: "auto", authorizationFingerprint: "new", answer: "allow", source: "allow_list" });
  assert.equal(await second, false);
  assert.equal(await bridge.releaseFromAllowList("w1", grant), false);
});

test("bridge: a person answer wins before release and replacement withdraws the old callback", async () => {
  const bridge = createBotApprovals({ publish() {} });
  let prepared = 0;
  const input = { ...request(), allowList: { target, requirementsFingerprint: "req", consentRevision: "old" },
    prepareAllowListRelease: async () => { prepared++; return undefined; } };
  const pending = bridge.request(input);
  bridge.decide("w1", "deny");
  assert.equal(await bridge.releaseFromAllowList("w1", grant), false);
  assert.equal((await pending).answer, "deny");
  assert.equal(prepared, 0);
  const controller = new AbortController();
  const old = bridge.request({ ...input, signal: controller.signal });
  const rejected = assert.rejects(old, /withdrawn|replaced/iu);
  const newer = bridge.request({ ...input, authorizationFingerprint: "new-attempt" });
  await rejected;
  await waitFor(() => bridge.pending().length === 1);
  bridge.decide("w1", "allow"); await newer;
  assert.equal(prepared, 0);
});

test("bridge: failed publication leaves no retained pending capability", async () => {
  let prepared = 0;
  const bridge = createBotApprovals({ publish() { throw new Error("window gone"); } });
  await assert.rejects(bridge.request({ ...request(), allowList: { target, requirementsFingerprint: "r", consentRevision: "c" },
    prepareAllowListRelease: async () => { prepared++; return undefined; } }), /unavailable/u);
  assert.deepEqual(bridge.pending(), []);
  assert.equal(await bridge.releaseFromAllowList("w1", grant), false);
  assert.equal(prepared, 0);
});

test("bridge: expiry during a durable lookup cannot replay a saved human allowance", async () => {
  let current = true;
  const bridge = createBotApprovals({ publish() { assert.fail("expired replay must not publish"); }, lookupDecision: async () => {
    current = false; return { id: "w1", authorizationFingerprint: "fp-w1", answer: "allow", source: "person" };
  } });
  await assert.rejects(bridge.request({ ...request(), assertCurrent: async () => { if (!current) throw new Error("deadline expired"); } }), /deadline expired/u);
  assert.deepEqual(bridge.pending(), []);
});

test("bridge: retransmission before settlement bookkeeping preserves the first exact human answer", async () => {
  let published = 0;
  const bridge = createBotApprovals({ publish() { published++; } });
  const input = { ...request(), always: { key: "k", count: 3 } };
  const first = bridge.request(input);
  bridge.decide("w1", "allow", "always");
  const retransmitted = bridge.request(input);
  // Drain an incorrect replacement too, so a regression fails without hanging.
  bridge.decide("w1", "deny");
  const results = await Promise.allSettled([first, retransmitted]);
  assert.equal(published, 1, "an answered in-flight attempt is shared until its bookkeeping finishes");
  for (const result of results) {
    assert.equal(result.status, "fulfilled");
    if (result.status === "fulfilled") assert.deepEqual(result.value, { id: "w1", authorizationFingerprint: "fp-w1", answer: "allow_always", source: "person" });
  }
});

test("bridge: the optional public offer copies only its key and count", async () => {
  const bridge = createBotApprovals({ publish() {} });
  const pending = bridge.request({ ...request(), always: { key: "k", count: 3, privateFingerprint: "private-proof" } as NonNullable<BotApprovalRequest["always"]> });
  const projected = publicBotApprovalPrompt(bridge.pending()[0]!);
  bridge.decide("w1", "deny"); await pending;
  assert.deepEqual(projected.always, { key: "k", count: 3 });
});
