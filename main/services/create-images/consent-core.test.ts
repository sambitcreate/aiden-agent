import assert from "node:assert/strict";
import test from "node:test";
import { CONSENT_TTL_MS, RunConsentStore, type ConsentDraft } from "./consent-core.js";

const draft: ConsentDraft = {
  workflowId: "wf",
  workflowRevision: 2,
  scope: { kind: "all" },
  requests: [{ nodeId: "g", variant: 0, provider: "openrouter", providerLabel: "OpenRouter", model: "m", modelLabel: "Model",
    referenceCount: 0, referenceBytes: 0, pendingReferenceCount: 0 }],
  totalRequests: 1,
  estimate: { kind: "unknown" },
};

function store() {
  let clock = 10_000;
  let id = 0;
  const consents = new RunConsentStore<string>({ now: () => clock, newId: () => `consent-${(id += 1)}` });
  return { consents, advance: (ms: number) => (clock += ms) };
}

test("a consent names the plan, expires five minutes later and is single-use", () => {
  const { consents } = store();
  const plan = consents.issue("window-a", draft, "digest");
  assert.deepEqual({ ...plan, consentId: "x" }, { ...draft, consentId: "x", createdAt: 10_000, expiresAt: 10_000 + CONSENT_TTL_MS });
  assert.deepEqual(consents.consume(plan.consentId, "window-a"), { ok: true, plan, internal: "digest" });
  assert.deepEqual(consents.consume(plan.consentId, "window-a"), { ok: false });
});

test("another window can neither use a consent nor burn it", () => {
  const { consents } = store();
  const plan = consents.issue("window-a", draft, "digest");
  assert.deepEqual(consents.consume(plan.consentId, "window-b"), { ok: false });
  assert.equal(consents.consume(plan.consentId, "window-a").ok, true);
});

test("a consent is valid until its expiry instant and not after", () => {
  const { consents, advance } = store();
  const early = consents.issue("window-a", draft, "a");
  const late = consents.issue("window-a", draft, "b");
  advance(CONSENT_TTL_MS - 1);
  assert.equal(consents.consume(early.consentId, "window-a").ok, true);
  advance(1);
  assert.deepEqual(consents.consume(late.consentId, "window-a"), { ok: false });
  assert.equal(consents.pending(), 0);
});

test("pending consents are capped; the oldest is dropped first", () => {
  const { consents } = store();
  const first = consents.issue("window-a", draft, "first");
  for (let index = 0; index < 64; index += 1) consents.issue("window-a", draft, `n${index}`);
  assert.equal(consents.pending(), 64);
  assert.deepEqual(consents.consume(first.consentId, "window-a"), { ok: false });
});
