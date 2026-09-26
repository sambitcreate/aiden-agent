import assert from "node:assert/strict";
import test from "node:test";
import {
  FormFillBatchError,
  FormFillBatchLedger,
  FORM_FILL_BATCH_VERSION,
  formFillPlanDigest,
  type FormFillBatchPlan,
} from "./batch-core.js";

function makePlan(
  overrides: Partial<FormFillBatchPlan> = {},
): FormFillBatchPlan {
  return {
    version: FORM_FILL_BATCH_VERSION,
    planId: "ffp-test-1",
    chatId: "chat-1",
    generationId: "gen-1",
    documentId: "doc-1",
    attachmentId: "att-1",
    attachmentHash: "a".repeat(64),
    attachmentName: "patient.txt",
    window: { pid: 42, windowId: 7, appName: "Safari", title: "Registration" },
    controllerEpoch: 3,
    actions: [
      {
        order: 0,
        elementIndex: 5,
        elementToken: "tok-5",
        role: "AXTextField",
        label: "First name",
        action: "fill",
        entityIndex: 0,
        value: "Ada",
        source: { attachmentId: "att-1", label: "First name", line: 2 },
      },
      {
        order: 1,
        elementIndex: 6,
        role: "AXTextField",
        label: "Last name",
        action: "fill",
        entityIndex: 1,
        value: "Lovelace",
        source: { attachmentId: "att-1", label: "Last name", line: 3 },
      },
    ],
    maxActions: 2,
    submit: false,
    expiresAt: 1_000_000,
    ...overrides,
  };
}

test("digest is stable and covers every bound field", () => {
  const plan = makePlan();
  const digest = formFillPlanDigest(plan);
  assert.equal(digest, formFillPlanDigest({ ...plan }));
  const mutations: Array<[string, Partial<FormFillBatchPlan>]> = [
    ["chat", { chatId: "chat-2" }],
    ["generation", { generationId: "gen-2" }],
    ["document", { documentId: "doc-2" }],
    ["attachment", { attachmentId: "att-2" }],
    ["attachment hash", { attachmentHash: "b".repeat(64) }],
    [
      "window",
      {
        window: {
          pid: 42,
          windowId: 8,
          appName: "Safari",
          title: "Registration",
        },
      },
    ],
    ["epoch", { controllerEpoch: 4 }],
    ["expiry", { expiresAt: 2_000_000 }],
    [
      "action value",
      {
        actions: [{ ...plan.actions[0], value: "Grace" }, plan.actions[1]],
      },
    ],
    ["submit", { submit: true as never }],
  ];
  for (const [name, patch] of mutations) {
    assert.notEqual(
      formFillPlanDigest({ ...plan, ...patch }),
      digest,
      `digest must change when ${name} changes`,
    );
  }
});

test("authorize issues a one-use token bound to the minted digest", () => {
  const ledger = new FormFillBatchLedger({ now: () => 500_000 });
  const plan = makePlan();
  const digest = ledger.mint(plan);
  const { token } = ledger.authorize(plan.planId, digest);
  assert.match(token, /^ffb-/);
  const bound = ledger.consume(token, plan);
  assert.equal(bound.planId, plan.planId);
  assert.equal(ledger.statusOf(plan.planId), "consumed");
});

test("consume rejects a second use and an unapproved call", () => {
  const ledger = new FormFillBatchLedger({ now: () => 500_000 });
  const plan = makePlan();
  const digest = ledger.mint(plan);
  const { token } = ledger.authorize(plan.planId, digest);
  ledger.consume(token, plan);
  assert.throws(
    () => ledger.consume(token, plan),
    (error: unknown) =>
      error instanceof FormFillBatchError && error.code === "plan_consumed",
  );
  assert.throws(
    () => ledger.consume("ffb-forged", plan),
    (error: unknown) =>
      error instanceof FormFillBatchError && error.code === "not_authorized",
  );
});

test("authorize rejects a plan whose contents changed after review", () => {
  const ledger = new FormFillBatchLedger({ now: () => 500_000 });
  const plan = makePlan();
  ledger.mint(plan);
  assert.throws(
    () => ledger.authorize(plan.planId, "0".repeat(64)),
    (error: unknown) =>
      error instanceof FormFillBatchError && error.code === "plan_mismatch",
  );
});

test("consume rejects a tampered plan passed at execution", () => {
  const ledger = new FormFillBatchLedger({ now: () => 500_000 });
  const plan = makePlan();
  const digest = ledger.mint(plan);
  const { token } = ledger.authorize(plan.planId, digest);
  const tampered = {
    ...plan,
    actions: [{ ...plan.actions[0], value: "Mallory" }, plan.actions[1]],
  };
  assert.throws(
    () => ledger.consume(token, tampered),
    (error: unknown) =>
      error instanceof FormFillBatchError && error.code === "plan_mismatch",
  );
});

test("expiry, revocation, and generation revocation fail closed", () => {
  let now = 500_000;
  const ledger = new FormFillBatchLedger({ now: () => now });
  const expired = makePlan({ planId: "ffp-exp" });
  ledger.mint(expired);
  now = 2_000_000;
  assert.throws(
    () => ledger.authorize(expired.planId, ledger.digestOf(expired.planId)!),
    (error: unknown) =>
      error instanceof FormFillBatchError && error.code === "plan_expired",
  );
  assert.equal(ledger.statusOf(expired.planId), "expired");

  now = 500_000;
  const revoked = makePlan({ planId: "ffp-rev" });
  const revokedDigest = ledger.mint(revoked);
  ledger.revoke(revoked.planId);
  assert.throws(
    () => ledger.authorize(revoked.planId, revokedDigest),
    (error: unknown) =>
      error instanceof FormFillBatchError && error.code === "plan_revoked",
  );

  const generationPlan = makePlan({ planId: "ffp-gen", generationId: "gen-9" });
  const generationDigest = ledger.mint(generationPlan);
  ledger.revokeGeneration("gen-9");
  assert.throws(
    () => ledger.authorize(generationPlan.planId, generationDigest),
    (error: unknown) =>
      error instanceof FormFillBatchError && error.code === "plan_revoked",
  );

  const otherGeneration = makePlan({
    planId: "ffp-gen2",
    generationId: "gen-8",
  });
  const otherDigest = ledger.mint(otherGeneration);
  assert.equal(ledger.statusOf(otherGeneration.planId), "pending");
  ledger.revokeAll();
  assert.throws(
    () => ledger.authorize(otherGeneration.planId, otherDigest),
    (error: unknown) =>
      error instanceof FormFillBatchError && error.code === "plan_revoked",
  );
});

test("row deselection authorizes a strict subset with its own digest", () => {
  const ledger = new FormFillBatchLedger({ now: () => 500_000 });
  const plan = makePlan();
  const digest = ledger.mint(plan);
  const { token, plan: derived } = ledger.authorize(plan.planId, digest, [1]);
  assert.deepEqual(derived.excludedOrders, [1]);
  assert.notEqual(formFillPlanDigest(derived), digest);
  assert.throws(
    () => ledger.authorize(makePlan({ planId: "ffp-x" }).planId, digest, [9]),
    (error: unknown) =>
      error instanceof FormFillBatchError && error.code === "plan_unknown",
  );
  ledger.consume(token, derived);
  // Token is bound to the derived digest — replaying the unfiltered plan fails.
  const ledger2 = new FormFillBatchLedger({ now: () => 500_000 });
  const plan2 = makePlan({ planId: "ffp-2" });
  const digest2 = ledger2.mint(plan2);
  const { token: token2 } = ledger2.authorize(plan2.planId, digest2, [0]);
  assert.throws(
    () => ledger2.consume(token2, plan2),
    (error: unknown) =>
      error instanceof FormFillBatchError && error.code === "plan_mismatch",
  );
  assert.throws(
    () =>
      new FormFillBatchLedger({ now: () => 500_000 }).authorize(
        plan.planId,
        digest,
      ),
    (error: unknown) =>
      error instanceof FormFillBatchError && error.code === "plan_unknown",
  );
});

test("deselection of a row outside the plan is rejected", () => {
  const ledger = new FormFillBatchLedger({ now: () => 500_000 });
  const plan = makePlan();
  const digest = ledger.mint(plan);
  assert.throws(
    () => ledger.authorize(plan.planId, digest, [7]),
    (error: unknown) =>
      error instanceof FormFillBatchError && error.code === "plan_mismatch",
  );
});
