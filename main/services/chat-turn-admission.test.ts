import assert from "node:assert/strict";
import test from "node:test";
import { ChatTurnAdmission } from "./chat-turn-admission.js";

const preparedSkill = {
  formattedPrompt: "x".repeat(256),
  provenance: {
    version: 1 as const,
    name: "Review",
    source: "configured" as const,
  },
  workspaceId: "workspace-1",
  userMessageId: "message-1",
};

test("append payload admission bounds concurrent distinct-chat retention and releases exactly", () => {
  const admission = new ChatTurnAdmission({
    maxAppendTurns: 2,
    maxAppendBytes: 100,
  });
  const first = admission.tryBegin("chat-1", "turn-1", "owner", false);
  const second = admission.tryBegin("chat-2", "turn-2", "owner", false);
  const rejected = admission.tryBegin("chat-3", "turn-3", "owner", false);
  assert.ok(first && second && rejected);

  first.reserveAppendPayload(60);
  second.reserveAppendPayload(40);
  assert.throws(() => rejected.reserveAppendPayload(1), /Too many messages/);
  assert.throws(() => first.reserveAppendPayload(1), /no longer available/);

  first.release();
  assert.throws(() => rejected.reserveAppendPayload(60), /Too many messages/);
  first.settleAsyncWork();
  rejected.reserveAppendPayload(60);
  second.release();
  second.settleAsyncWork();
  rejected.release();
  rejected.settleAsyncWork();

  const recovered = admission.tryBegin("chat-4", "turn-4", "owner", false);
  assert.ok(recovered);
  recovered.reserveAppendPayload(100);
  recovered.release();
  recovered.settleAsyncWork();
});

test("append payload admission rejects byte overflow without leaking its lease budget", () => {
  const admission = new ChatTurnAdmission({
    maxAppendTurns: 1,
    maxAppendBytes: 10,
  });
  const oversized = admission.tryBegin("chat-1", "turn-1", "owner", false);
  assert.ok(oversized);
  assert.throws(() => oversized.reserveAppendPayload(11), /Too many messages/);
  oversized.release();
  oversized.settleAsyncWork();

  const exact = admission.tryBegin("chat-2", "turn-2", "owner", false);
  assert.ok(exact);
  exact.reserveAppendPayload(10);
  exact.release();
  exact.settleAsyncWork();
});

test("generation handoff remains closed until append async work has settled", () => {
  const admission = new ChatTurnAdmission();
  const lease = admission.tryBegin("chat-1", "turn-1", "owner-1", false);
  assert.ok(lease);
  let registrations = 0;

  assert.equal(admission.owns("chat-1", "turn-1", "owner-1"), false);
  assert.equal(
    admission.handoff("chat-1", "turn-1", "owner-1", () => {
      registrations += 1;
    }),
    false,
  );
  assert.equal(registrations, 0);
  assert.equal(lease.isActive(), true);

  lease.settleAsyncWork();
  assert.equal(admission.owns("chat-1", "turn-1", "owner-1"), true);
  assert.equal(
    admission.handoff("chat-1", "turn-1", "owner-1", () => {
      registrations += 1;
    }),
    true,
  );
  assert.equal(registrations, 1);
  assert.equal(admission.isAdmitted("chat-1"), false);
});

test("handed-off skill prompts remain globally charged until generation cleanup", () => {
  const admission = new ChatTurnAdmission({
    maxPreparedTurns: 1,
    maxPreparedBytes: 1024 * 1024,
  });
  const first = admission.tryBegin("chat-1", "turn-1", "owner-1", false);
  assert.ok(first);
  first.reserveSkillPreparation();
  first.prepareSkillInvocation(preparedSkill);
  first.settleAsyncWork();
  let releaseActiveSkill = () => {};
  assert.equal(
    admission.handoff(
      "chat-1",
      "turn-1",
      "owner-1",
      (_skill, releaseReservation) => {
        releaseActiveSkill = releaseReservation;
      },
    ),
    true,
  );

  const second = admission.tryBegin("chat-2", "turn-2", "owner-2", false);
  assert.ok(second);
  assert.throws(
    () => second.reserveSkillPreparation(),
    /Too many skill messages/u,
  );
  releaseActiveSkill();
  releaseActiveSkill();
  second.reserveSkillPreparation();
  second.release();
  second.settleAsyncWork();
});

test("lease expiry revokes authority without releasing retained append bytes early", async () => {
  const admission = new ChatTurnAdmission({
    leaseTtlMs: 15,
    maxAppendTurns: 1,
    maxAppendBytes: 10,
  });
  const stalled = admission.tryBegin(
    "chat-stalled",
    "turn-stalled",
    "owner-a",
    false,
  );
  assert.ok(stalled);
  stalled.reserveAppendPayload(10);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(stalled.isActive(), false);

  const next = admission.tryBegin("chat-next", "turn-next", "owner-b", false);
  assert.ok(next);
  assert.throws(() => next.reserveAppendPayload(10), /Too many messages/);
  stalled.settleAsyncWork();
  next.reserveAppendPayload(10);
  next.release();
  next.settleAsyncWork();
});

test("indeterminate append fences the renderer document until process restart", () => {
  const admission = new ChatTurnAdmission();
  assert.equal(admission.requiresAppendReconciliation("owner-a"), false);
  admission.markAppendReconciliationRequired("owner-a");
  assert.equal(admission.requiresAppendReconciliation("owner-a"), true);
  assert.equal(admission.requiresAppendReconciliation("owner-b"), false);
  assert.equal(
    admission.tryBegin("chat-fenced", "turn-fenced", "owner-a", false),
    null,
  );

  // Releasing ordinary turn state must not accidentally clear the durability
  // fence. Only constructing a new process-owned admission instance does.
  admission.releaseAll();
  assert.equal(admission.requiresAppendReconciliation("owner-a"), true);
  admission.clearAppendReconciliationRequired("owner-a");
  assert.equal(admission.requiresAppendReconciliation("owner-a"), false);
  assert.equal(
    new ChatTurnAdmission().requiresAppendReconciliation("owner-a"),
    false,
  );
});
