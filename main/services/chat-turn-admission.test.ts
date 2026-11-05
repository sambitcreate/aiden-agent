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

test("settled cached receipts remain byte-budgeted while allowing generation handoff", () => {
  const admission = new ChatTurnAdmission({ maxAppendTurns: 2, maxAppendBytes: 100 });
  const first = admission.tryBegin("chat-1", "turn-1", "owner", false);
  const second = admission.tryBegin("chat-2", "turn-2", "owner", false);
  assert.ok(first && second);
  first.reserveAppendPayload(100);
  first.settleAsyncWork({ retainAppendPayloadUntilRelease: true });
  assert.equal(admission.owns("chat-1", "turn-1", "owner"), true);
  assert.throws(() => second.reserveAppendPayload(1), /Too many messages/u);
  assert.equal(admission.handoff("chat-1", "turn-1", "owner", () => {}), true);
  second.reserveAppendPayload(100);
  second.settleAsyncWork({ retainAppendPayloadUntilRelease: true });
  second.release();
  const third = admission.tryBegin("chat-3", "turn-3", "owner", false);
  assert.ok(third);
  third.reserveAppendPayload(100);
  third.release();
  third.settleAsyncWork();
});

test("a lease that ends before, during or after its append keeps bytes charged to the actual holder", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const admission = new ChatTurnAdmission({ leaseTtlMs: 10, maxAppendTurns: 1, maxAppendBytes: 10 });
  const probe = () => {
    const lease = admission.tryBegin("chat-probe", "turn-probe", "probe", false);
    assert.ok(lease);
    let admitted = true;
    try { lease.reserveAppendPayload(10); } catch { admitted = false; }
    lease.release();
    lease.settleAsyncWork();
    return admitted;
  };

  const before = admission.tryBegin("chat-before", "turn", "owner", false);
  assert.ok(before);
  before.release();
  assert.throws(() => before.reserveAppendPayload(10), /no longer available/u);
  before.settleAsyncWork();
  assert.equal(probe(), true, "A lease revoked before reserving never held capacity");

  const during = admission.tryBegin("chat-during", "turn", "owner", false);
  assert.ok(during);
  during.reserveAppendPayload(10);
  t.mock.timers.tick(10);
  assert.equal(during.isActive(), false);
  assert.equal(admission.isAdmitted("chat-during"), true, "Unsettled IO still occupies the chat");
  assert.equal(probe(), false, "The in-flight append still holds its bytes after expiry");
  during.settleAsyncWork();
  assert.equal(admission.isAdmitted("chat-during"), false);
  assert.equal(probe(), true);

  const after = admission.tryBegin("chat-after", "turn", "owner", false);
  assert.ok(after);
  after.reserveAppendPayload(10);
  after.settleAsyncWork({ retainAppendPayloadUntilRelease: true });
  assert.equal(probe(), false, "A cached receipt holds its bytes while the lease is live");
  t.mock.timers.tick(10);
  assert.equal(admission.isAdmitted("chat-after"), false);
  assert.equal(probe(), true, "Expiry of a settled lease is the receipt's real release");
});

test("a stale lease cannot change the replacement turn on the same chat", () => {
  const admission = new ChatTurnAdmission({ maxAppendTurns: 2, maxAppendBytes: 100 });
  const stale = admission.tryBegin("chat-1", "turn-1", "owner-a", false);
  assert.ok(stale);
  stale.reserveAppendPayload(60);
  stale.release();
  stale.settleAsyncWork();

  const replacement = admission.tryBegin("chat-1", "turn-2", "owner-b", false);
  assert.ok(replacement);
  replacement.reserveAppendPayload(100);

  stale.release();
  stale.settleAsyncWork();
  assert.throws(() => stale.reserveAppendPayload(1), /no longer available/u);
  assert.equal(admission.releaseMatching("chat-1", "turn-1", "owner-a"), false);
  assert.equal(admission.handoff("chat-1", "turn-1", "owner-a", () => {
    assert.fail("A stale identity cannot register a generation");
  }), false);
  assert.equal(replacement.isActive(), true);
  assert.equal(admission.isAdmitted("chat-1"), true);
  const rival = admission.tryBegin("chat-2", "turn-3", "owner-c", false);
  assert.ok(rival);
  assert.throws(() => rival.reserveAppendPayload(1), /Too many messages/u);
});

test("competing owners for one chat get one lease and the loser disturbs nothing", () => {
  const admission = new ChatTurnAdmission();
  const winner = admission.tryBegin("chat-1", "turn-renderer-a", "renderer-a", false);
  assert.ok(winner);
  assert.equal(admission.tryBegin("chat-1", "turn-renderer-b", "renderer-b", false), null);
  assert.equal(admission.tryBegin("chat-1", "turn-schedule", "scheduler", false), null);
  assert.equal(admission.tryBegin("chat-1", "turn-remote", "remote", false), null);
  assert.equal(admission.tryBegin("chat-2", "turn-busy", "renderer-a", true), null);
  winner.settleAsyncWork();
  assert.equal(admission.owns("chat-1", "turn-renderer-b", "renderer-b"), false);
  assert.equal(admission.owns("chat-1", "turn-renderer-a", "renderer-b"), false);
  assert.equal(admission.handoff("chat-1", "turn-renderer-a", "renderer-b", () => {
    assert.fail("A mismatched owner cannot register a generation");
  }), false);
  assert.equal(admission.handoff("chat-1", "turn-renderer-a", "renderer-a", () => {}), true);
  assert.equal(winner.isActive(), false);
  assert.equal(admission.isAdmitted("chat-1"), false);
});

test("release callbacks run once, after authority is gone, and late registrations run at once", () => {
  const admission = new ChatTurnAdmission();
  const lease = admission.tryBegin("chat-1", "turn-1", "owner", false);
  assert.ok(lease);
  const order: string[] = [];
  lease.onReleased(() => {
    order.push(`first:${lease.isActive()}`);
    lease.onReleased(() => order.push("nested"));
    lease.release();
  });
  lease.onReleased(() => order.push("second"));
  lease.release();
  lease.release();
  assert.deepEqual(order, ["first:false", "nested", "second"]);
  lease.onReleased(() => order.push("late"));
  assert.deepEqual(order, ["first:false", "nested", "second", "late"]);
});

test("a failed registration leaves the turn and its skill charge with the lease", () => {
  const admission = new ChatTurnAdmission({ maxPreparedTurns: 1, maxPreparedBytes: 1024 * 1024 });
  const lease = admission.tryBegin("chat-1", "turn-1", "owner", false);
  assert.ok(lease);
  lease.reserveSkillPreparation();
  lease.prepareSkillInvocation(preparedSkill);
  lease.settleAsyncWork();

  let failedRelease = () => {};
  assert.throws(
    () => admission.handoff("chat-1", "turn-1", "owner", (_skill, release) => {
      failedRelease = release;
      release();
      throw new Error("registration failed");
    }),
    /registration failed/u,
  );
  assert.equal(lease.isActive(), true);
  assert.equal(admission.owns("chat-1", "turn-1", "owner"), true);
  const rival = admission.tryBegin("chat-2", "turn-2", "owner", false);
  assert.ok(rival);
  assert.throws(() => rival.reserveSkillPreparation(), /Too many skill messages/u);
  failedRelease();
  assert.throws(
    () => rival.reserveSkillPreparation(),
    /Too many skill messages/u,
    "A failed registration's release callback no longer owns the charge",
  );

  let seen: unknown;
  assert.equal(admission.handoff("chat-1", "turn-1", "owner", (skill, release) => {
    seen = skill;
    release();
  }), true, "The caller may retry while the lease is intact");
  assert.equal(seen, preparedSkill);
  failedRelease();
  rival.reserveSkillPreparation();
  assert.throws(() => {
    const third = admission.tryBegin("chat-3", "turn-3", "owner", false);
    assert.ok(third);
    third.reserveSkillPreparation();
  }, /Too many skill messages/u, "The retry released the one slot exactly once");
});

test("a skill release requested during registration completes exactly once at transfer", () => {
  const admission = new ChatTurnAdmission({ maxPreparedTurns: 1, maxPreparedBytes: 1024 * 1024 });
  const lease = admission.tryBegin("chat-1", "turn-1", "owner", false);
  assert.ok(lease);
  lease.reserveSkillPreparation();
  lease.prepareSkillInvocation(preparedSkill);
  lease.settleAsyncWork();
  let release = () => {};
  assert.equal(admission.handoff("chat-1", "turn-1", "owner", (_skill, releaseSkill) => {
    release = releaseSkill;
    releaseSkill();
  }), true);
  release();
  const next = admission.tryBegin("chat-2", "turn-2", "owner", false);
  const rival = admission.tryBegin("chat-3", "turn-3", "owner", false);
  assert.ok(next && rival);
  next.reserveSkillPreparation();
  assert.throws(() => rival.reserveSkillPreparation(), /Too many skill messages/u);
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
