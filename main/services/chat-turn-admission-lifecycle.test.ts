import assert from "node:assert/strict";
import test from "node:test";
import { SLASH_LIMITS } from "../../renderer/shared/slash-commands.js";
import { ChatTurnAdmission, type ChatTurnLease } from "./chat-turn-admission.js";
import {
  INITIAL_CHAT_TURN_LIFECYCLE,
  transitionChatTurn,
  transitionChatTurnSkillCustody,
  type ChatTurnEvent,
  type ChatTurnLifecycle,
  type ChatTurnSkillCustody,
} from "./chat-turn-admission-lifecycle.js";

const roomy = { turns: 0, bytes: 0, maxTurns: 4, maxBytes: 100 };

function run(events: ChatTurnEvent[], from = INITIAL_CHAT_TURN_LIFECYCLE) {
  let state: ChatTurnLifecycle = from;
  const effects: string[] = [];
  for (const event of events) {
    const next = transitionChatTurn(state, event);
    state = next.state;
    for (const effect of next.effects) {
      effects.push(effect.type === "budget"
        ? `${effect.pool}:${effect.turns}:${effect.bytes}`
        : effect.type);
    }
  }
  return { state, effects };
}

test("expiry before settlement refunds nothing until the admitted work settles", () => {
  const revoked = run([
    { type: "reserve-append", bytes: 10, pool: roomy },
    { type: "revoke" },
  ]);
  assert.deepEqual(revoked.effects, ["append:1:10", "revoked"]);
  assert.deepEqual(
    run([{ type: "settle", retainAppend: false }], revoked.state).effects,
    ["append:-1:-10", "finalize"],
  );
});

test("a retained receipt is refunded only when its lease ends", () => {
  const settled = run([
    { type: "reserve-append", bytes: 10, pool: roomy },
    { type: "settle", retainAppend: true },
  ]);
  assert.deepEqual(settled.effects, ["append:1:10"]);
  assert.deepEqual(run([{ type: "revoke" }], settled.state).effects, [
    "revoked",
    "append:-1:-10",
    "finalize",
  ]);
});

test("registration succeeding moves the skill charge out of the lease", () => {
  const registering = run([
    { type: "reserve-skill", bytes: 50, pool: roomy },
    { type: "prepare-skill", bytes: 20 },
    { type: "settle", retainAppend: false },
    { type: "begin-registration" },
  ]);
  assert.deepEqual(registering.effects, ["skill:1:50", "skill:0:-30"]);
  assert.deepEqual(
    run([{ type: "registration-succeeded" }], registering.state).effects,
    ["revoked", "finalize"],
    "The lease does not refund bytes the generation now holds",
  );
});

test("a revoke during registration waits for its outcome", () => {
  const registering = run([
    { type: "reserve-skill", bytes: 50, pool: roomy },
    { type: "settle", retainAppend: false },
    { type: "begin-registration" },
  ]).state;
  const revoked = run([{ type: "revoke" }], registering);
  assert.deepEqual(revoked.effects, ["revoked"]);
  assert.deepEqual(
    run([{ type: "registration-failed" }], revoked.state).effects,
    ["skill:-1:-50", "finalize"],
    "With no generation, the lease still holds the charge and refunds it",
  );
  assert.deepEqual(
    run([{ type: "registration-succeeded" }], revoked.state).effects,
    ["finalize"],
  );
});

test("slots are frozen during registration so custody bytes cannot go stale", () => {
  const registering = run([
    { type: "reserve-skill", bytes: 50, pool: roomy },
    { type: "settle", retainAppend: false },
    { type: "begin-registration" },
  ]).state;
  for (const event of [
    { type: "prepare-skill", bytes: 1 },
    { type: "reserve-append", bytes: 1, pool: roomy },
    { type: "begin-registration" },
  ] satisfies ChatTurnEvent[]) {
    assert.equal(transitionChatTurn(registering, event).rejected, "unavailable");
  }
});

test("handoff needs live authority and settled preparation", () => {
  assert.equal(
    transitionChatTurn(INITIAL_CHAT_TURN_LIFECYCLE, { type: "begin-registration" }).rejected,
    "unavailable",
  );
  const settledThenRevoked = run([
    { type: "settle", retainAppend: false },
    { type: "revoke" },
  ]).state;
  assert.equal(
    transitionChatTurn(settledThenRevoked, { type: "begin-registration" }).rejected,
    "unavailable",
  );
});

test("reservations reject malformed bytes and full pools without a charge", () => {
  for (const bytes of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      transitionChatTurn(INITIAL_CHAT_TURN_LIFECYCLE, { type: "reserve-append", bytes, pool: roomy }).rejected,
      "unavailable",
    );
  }
  for (const pool of [
    { ...roomy, turns: 4 },
    { ...roomy, bytes: 91 },
  ]) {
    const result = transitionChatTurn(INITIAL_CHAT_TURN_LIFECYCLE, { type: "reserve-append", bytes: 10, pool });
    assert.equal(result.rejected, "capacity");
    assert.deepEqual(result.effects, []);
  }
});

test("skill custody refunds at most once in every order", () => {
  const events = ["release-requested", "transferred", "registration-failed"] as const;
  const orders = events.flatMap((a) => events.flatMap((b) => events.map((c) => [a, b, c])));
  for (const start of ["lease", "released"] as const) {
    for (const order of orders) {
      let custody: ChatTurnSkillCustody = start;
      let refunds = 0;
      for (const event of order) {
        const next = transitionChatTurnSkillCustody(custody, event);
        custody = next.custody;
        if (next.refund) refunds += 1;
      }
      const failedFirst = order.indexOf("registration-failed");
      const transferred = order.indexOf("transferred");
      const shouldRefund =
        start === "lease" &&
        transferred !== -1 &&
        (failedFirst === -1 || transferred < failedFirst) &&
        order.includes("release-requested");
      assert.equal(refunds, shouldRefund ? 1 : 0, `${start}: ${order.join(", ")}`);
    }
  }
});

/** Small seeded generator, so a failure names a replayable sequence. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_TURNS = 3;
const MAX_APPEND_BYTES = 30;
const CHATS = ["chat-a", "chat-b", "chat-c", "chat-d"];

const skillPrompt = {
  formattedPrompt: "x".repeat(32),
  provenance: { version: 1 as const, name: "Review", source: "configured" as const },
  workspaceId: "workspace-1",
  userMessageId: "message-1",
};

const SKILL_SLOT_BYTES = SLASH_LIMITS.formattedInvocationBytes;
const oneByteSkill = { ...skillPrompt, formattedPrompt: "x" };

function assertPoolIsWhole(admission: ChatTurnAdmission, label: string): void {
  // The owner exposes no counters, so a pool is measured the way a sender meets
  // it. A negative charge would admit more than the limit; a leaked one, less.
  const leases: ChatTurnLease[] = [];
  const begin = (index: number) => {
    const lease = admission.tryBegin(`probe-${index}`, `probe-${index}`, "probe", false);
    assert.ok(lease, `${label}: chat stayed occupied`);
    leases.push(lease);
    return lease;
  };
  const end = (lease: ChatTurnLease) => {
    lease.release();
    lease.settleAsyncWork();
  };

  // Append: every turn slot, then exactly the byte limit.
  for (let index = 0; index < MAX_TURNS; index += 1) {
    begin(index).reserveAppendPayload(index === 0 ? MAX_APPEND_BYTES : 0);
  }
  const overAppend = begin(MAX_TURNS);
  assert.throws(() => overAppend.reserveAppendPayload(0), /Too many messages/u, `${label}: append turns`);
  leases.splice(0).forEach(end);
  const byteProbe = begin(0);
  assert.throws(
    () => byteProbe.reserveAppendPayload(MAX_APPEND_BYTES + 1),
    /Too many messages/u,
    `${label}: append bytes over`,
  );
  byteProbe.reserveAppendPayload(MAX_APPEND_BYTES);
  leases.splice(0).forEach(end);

  // Skill bytes bind before skill turns here: three slots fill the byte limit
  // and a fourth turn is still free. One byte short must refuse a fourth slot.
  const [first, second, third] = [begin(0), begin(1), begin(2)];
  for (const lease of [first, second, third]) lease!.reserveSkillPreparation();
  first!.prepareSkillInvocation(oneByteSkill);
  const fourth = begin(3);
  assert.throws(
    () => fourth.reserveSkillPreparation(),
    /Too many skill/u,
    `${label}: one byte short of a slot`,
  );
  end(first!);
  fourth.reserveSkillPreparation();

  // Shrink everything: bytes are free, so now only the turn limit can refuse.
  second!.prepareSkillInvocation(oneByteSkill);
  third!.prepareSkillInvocation(oneByteSkill);
  fourth.prepareSkillInvocation(oneByteSkill);
  const fifth = begin(4);
  fifth.reserveSkillPreparation();
  const sixth = begin(5);
  assert.throws(() => sixth.reserveSkillPreparation(), /Too many skill/u, `${label}: skill turns`);
  leases.splice(0).forEach(end);
}

test("generated event orders keep one owner per chat and exact pool accounting", () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const random = mulberry32(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const admission = new ChatTurnAdmission({
      maxAppendTurns: MAX_TURNS,
      maxAppendBytes: MAX_APPEND_BYTES,
      maxPreparedTurns: MAX_TURNS + 1,
      maxPreparedBytes: MAX_TURNS * SKILL_SLOT_BYTES,
    });
    const leases: ChatTurnLease[] = [];
    const generationRefunds: (() => void)[] = [];
    const registrationsByTurn = new Map<string, number>();
    const trace: string[] = [];
    let turn = 0;

    const anyLease = () => (leases.length ? pick(leases) : undefined);
    const attempt = (action: () => void) => {
      try {
        action();
      } catch {
        // Rejected operations are part of the sequence, not failures.
      }
    };
    const actions: Record<string, () => void> = {
      begin() {
        turn += 1;
        const chatId = pick(CHATS);
        const lease = admission.tryBegin(chatId, `turn-${turn}`, pick(["a", "b"]), false);
        if (lease) leases.push(lease);
      },
      reserveAppend() {
        const lease = anyLease();
        attempt(() => lease?.reserveAppendPayload(Math.floor(random() * 12)));
      },
      reserveSkill() {
        const lease = anyLease();
        attempt(() => lease?.reserveSkillPreparation());
      },
      prepareSkill() {
        const lease = anyLease();
        attempt(() => lease?.prepareSkillInvocation(skillPrompt));
      },
      settle() {
        anyLease()?.settleAsyncWork();
      },
      settleRetained() {
        anyLease()?.settleAsyncWork({ retainAppendPayloadUntilRelease: true });
      },
      release() {
        anyLease()?.release();
      },
      releaseChat() {
        admission.releaseChat(pick(CHATS));
      },
      refundGeneration() {
        const refund = generationRefunds.length ? pick(generationRefunds) : undefined;
        refund?.();
      },
      handoff() {
        const lease = anyLease();
        if (!lease) return;
        const mode = pick(["plain", "throws", "releases", "refunds", "nested"]);
        attempt(() => admission.handoff(lease.chatId, lease.turnId, lease.ownerId, (_skill, refund) => {
          registrationsByTurn.set(lease.turnId, (registrationsByTurn.get(lease.turnId) ?? 0) + 1);
          if (mode === "throws") {
            registrationsByTurn.set(lease.turnId, registrationsByTurn.get(lease.turnId)! - 1);
            generationRefunds.push(refund);
            throw new Error("registration failed");
          }
          generationRefunds.push(refund);
          if (mode === "releases") lease.release();
          if (mode === "refunds") refund();
          if (mode === "nested") admission.handoff(lease.chatId, lease.turnId, lease.ownerId, () => {
            registrationsByTurn.set(lease.turnId, registrationsByTurn.get(lease.turnId)! + 1);
          });
        }));
      },
    };
    const names = Object.keys(actions);
    for (let step = 0; step < 60; step += 1) {
      const name = pick(names);
      trace.push(name);
      actions[name]!();
    }

    const label = `seed ${seed}: ${trace.join(" ")}`;
    for (const count of registrationsByTurn.values()) assert.ok(count <= 1, label);
    for (const lease of leases) {
      lease.release();
      lease.settleAsyncWork();
    }
    for (const refund of generationRefunds) {
      refund();
      refund();
    }
    for (const chatId of CHATS) assert.equal(admission.isAdmitted(chatId), false, label);
    assertPoolIsWhole(admission, label);
  }
});
