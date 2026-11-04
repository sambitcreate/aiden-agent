import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBotApprovalTallies, BOT_APPROVAL_TALLIES_FILE } from "./bot-approval-tallies.js";
import { botSessionDirectory } from "../bot-routine-notes.js";
import { createBotApprovals, publicBotApprovalPrompt } from "./bot-approvals.js";
import type { BotApprovalRequest, BotApprovalDecision, BotAllowListRelease } from "./bot-extension.js";
import { waitFor } from "./test-support/faux.js";

const target = { kind: "connection", serverId: "calendar", tool: "create_event" } as const;
const request = (waitId = "w1"): BotApprovalRequest => ({ botId: "bot-1", waitId, toolCallId: "provider-duplicate", toolName: "calendar__create_event",
  summary: "Create event", authorizationFingerprint: `fp-${waitId}`, signal: undefined });
const rememberedRequest = (waitId = "w1"): BotApprovalRequest => ({ ...request(waitId),
  allowList: { target, requirementsFingerprint: "requirements", consentRevision: "consent" } });
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
  const input = { ...rememberedRequest(), assertCurrent: async () => { if (!current) throw new Error("delivery expired"); } };
  assert.deepEqual(await bridge.request(input), saved);
  current = false;
  await assert.rejects(bridge.request(input), /delivery expired/u);
  assert.equal(lookups, 1); assert.equal(published, 0);
});

test("bridge: a mismatched saved decision cannot satisfy another fingerprint", async () => {
  const bridge = createBotApprovals({ publish() {}, lookupDecision: async () => ({ id: "w1", authorizationFingerprint: "old", answer: "allow", source: "person" }) });
  await assert.rejects(bridge.request(rememberedRequest()), /decision.*identity|fingerprint/iu);
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
  await assert.rejects(bridge.request({ ...rememberedRequest(), assertCurrent: async () => { if (!current) throw new Error("deadline expired"); } }), /deadline expired/u);
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

for (const toolName of ["calendar__create_event", "computer_use"]) {
  test(`bridge: unreadable tally evidence does not block an unremembered ${toolName} card`, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-approval-isolation-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const botDirectory = botSessionDirectory(directory, "bot-1");
    await mkdir(botDirectory, { recursive: true });
    await writeFile(path.join(botDirectory, BOT_APPROVAL_TALLIES_FILE), "corrupt tally evidence");
    const tallies = createBotApprovalTallies({ profileDir: () => directory });
    const bridge = createBotApprovals({ publish() {}, lookupDecision: (...args) => tallies.decision(...args) });
    let failure: unknown;
    const pending = bridge.request({ ...request(toolName), toolName });
    void pending.catch(error => { failure = error; });
    await waitFor(() => bridge.pending().length === 1 || failure !== undefined);
    if (bridge.pending().length) bridge.decide(toolName, "allow");
    assert.equal(failure, undefined, "an ordinary rule or Computer Use card has no tally recovery obligation");
    assert.equal((await pending).answer, "allow");
    await assert.rejects(bridge.request(rememberedRequest("remembered")), /tally|approval|read|repair/iu);
    assert.deepEqual(bridge.pending(), [], "remembered classes remain fenced by the damaged evidence");
  });
}


for (const prepared of [false, true]) {
  test(`bridge: expiry settles a held automatic release without waiting for its callback (prepared=${prepared})`, async () => {
    const bridge = createBotApprovals({ publish() {} });
    let complete!: (value: BotApprovalDecision | undefined) => void;
    const pending = bridge.request({ ...rememberedRequest(), prepareAllowListRelease: () =>
      new Promise<BotApprovalDecision | undefined>(resolve => { complete = resolve; }) });
    const releasing = bridge.releaseFromAllowList("w1", grant);
    assert.equal(bridge.decide("w1", "deny", undefined, "expiry"), true);
    assert.deepEqual(await pending, { id: "w1", authorizationFingerprint: "fp-w1", answer: "deny", source: "expiry" });
    assert.equal(bridge.pending().length, 0);
    complete(prepared ? { id: "automatic", authorizationFingerprint: "new", answer: "allow", source: "allow_list" } : undefined);
    assert.equal(await releasing, false);
  });
}
