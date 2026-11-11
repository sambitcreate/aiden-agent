import assert from "node:assert/strict";
import test from "node:test";
import { createChatOwedTurns, type OwedTurnPlan } from "./chat-owed-turns.js";
import {
  createChatRunInputAdmission,
  type ChatRunInputGenerationRef,
} from "./chat-run-input-admission.js";
import type { Chat } from "./types.js";

type Origin = "user_stop" | "chat_deletion" | "application_shutdown";
type Context = { model: string };

/**
 * A chat host the way main wires one: a run that ended while input was being
 * saved, the real admission and the real owed-turn registry. Each owed turn
 * the registry starts is recorded the way main runs it: a plan with a Stop
 * origin is a turn that stops at once, one with none is a turn the model
 * answers.
 */
function host(options: { refuses?: (chatId: string) => boolean } = {}) {
  const turns: Array<{ plan: OwedTurnPlan<Context, Origin>; outcome: "answered" | "stopped" }> = [];
  const owedTurns = createChatOwedTurns<Context, Origin>({
    refuses: options.refuses ?? (() => false),
    start: (plan) => turns.push({ plan, outcome: plan.stopOrigin ? "stopped" : "answered" }),
  });
  const saved: string[] = [];
  let ids = 0;
  let duringSave: (() => void) | undefined;
  let queueOpen = true;
  const generation: ChatRunInputGenerationRef = {
    chatId: "chat-1",
    owner: { documentId: "doc-1" },
    cancelRequested: false,
    owedTurn: { hold: () => owedTurns.hold("stream-1") },
    agent: {
      queueAdmissionBlocked: () => undefined,
      queueSteer: () => (queueOpen ? { accepted: true, queue: "steer" } : { accepted: false, reason: "not-active" }),
      queueFollowUp: () =>
        queueOpen ? { accepted: true, queue: "follow-up" } : { accepted: false, reason: "not-active" },
    } as unknown as ChatRunInputGenerationRef["agent"],
  };
  const active = new Map([["stream-1", generation]]);
  const admission = createChatRunInputAdmission({
    active,
    isChatDeleting: () => false,
    appendMessage: async (chatId, message) => {
      duringSave?.();
      saved.push(message.id!);
      return { id: chatId, messages: [] } as unknown as Chat;
    },
    readChat: async () => null,
    newMessageId: () => `message-${(ids += 1)}`,
  });
  owedTurns.open("stream-1", { chatId: "chat-1", ownerDocumentId: "doc-1", context: { model: "m" } });
  /** What main does when the run finishes: record its outcome, leave the active map, settle. */
  const finishRun = (outcome: { committed?: string[]; failed?: boolean } = {}) => {
    queueOpen = false;
    const recordedStop = generation.cancelRequested;
    active.delete("stream-1");
    owedTurns.settle("stream-1", {
      committed: (outcome.committed ?? []).map((messageId) => ({ messageId })),
      recordedStop,
    });
    return { recordedStop, failed: outcome.failed === true };
  };
  /** The person's Stop, as main's cancel handles it for this stream. */
  const stop = () => {
    if (active.has("stream-1")) generation.cancelRequested = true;
    owedTurns.stop("stream-1", "user_stop", "doc-1");
  };
  return {
    owedTurns,
    admission,
    generation,
    turns,
    saved,
    finishRun,
    stop,
    closeQueue: () => {
      queueOpen = false;
    },
    setDuringSave: (hook: (() => void) | undefined) => {
      duringSave = hook;
    },
  };
}

test("input saved while the run ends is answered by exactly one owed turn once the run settles", async () => {
  const h = host();
  // agent_end closes the queue and the run settles while the input is saving.
  h.setDuringSave(() => h.finishRun());
  const receipt = await h.admission.admit({ streamId: "stream-1", mode: "queue", text: "then this" });
  assert.deepEqual(receipt, { admitted: true, queue: "follow-up", committed: true, messageId: "message-1" });
  assert.deepEqual(h.turns, [
    {
      plan: { chatId: "chat-1", settledStreamId: "stream-1", context: { model: "m" }, inputs: [{ messageId: "message-1" }] },
      outcome: "answered",
    },
  ]);
  assert.equal(h.owedTurns.isHolding("chat-1"), false);
});

test("the owed turn waits for input still being saved, and the chat stays busy meanwhile", async () => {
  const h = host();
  h.closeQueue();
  let busyWhileSaving: boolean | undefined;
  h.setDuringSave(() => {
    h.finishRun();
    busyWhileSaving = h.owedTurns.isHolding("chat-1");
    assert.equal(h.turns.length, 0, "nothing starts while an input is still being saved");
  });
  await h.admission.admit({ streamId: "stream-1", mode: "queue", text: "late" });
  assert.equal(busyWhileSaving, true);
  assert.equal(h.turns.length, 1);
  assert.equal(h.owedTurns.isHolding("chat-1"), false);
});

test("saved input Pi still held when the run ended comes first, then input registered after, each once", async () => {
  const owedTurns = createChatOwedTurns<Context, Origin>({
    refuses: () => false,
    start: (plan) => started.push(plan),
  });
  const started: OwedTurnPlan<Context, Origin>[] = [];
  owedTurns.open("s", { chatId: "c", ownerDocumentId: "d", context: { model: "m" } });
  const hold = owedTurns.hold("s")!;
  assert.equal(hold.register({ messageId: "late", hookContext: "ctx" }), true);
  owedTurns.settle("s", { committed: [{ messageId: "drained" }, { messageId: "late" }], recordedStop: false });
  assert.equal(started.length, 0);
  hold.release();
  hold.release();
  assert.deepEqual(started.map((plan) => plan.inputs), [[{ messageId: "drained" }, { messageId: "late" }]]);
  owedTurns.settle("s", { committed: [{ messageId: "again" }], recordedStop: false });
  assert.equal(started.length, 1, "a run settles once");
});

test("Stop right after a follow-up receipt leaves exactly one stopped turn and runs nothing", async () => {
  // The receipt came back while the run was still settling: Stop reaches the
  // run before it records its outcome (it records the Stop itself), or just
  // after (the owed turn then stops at once). Either way one stopped turn.
  for (const stopLands of ["before the run records", "after the run records"] as const) {
    const h = host();
    h.closeQueue();
    const receipt = await h.admission.admit({ streamId: "stream-1", mode: "queue", text: "next" });
    assert.equal(receipt.admitted && receipt.queue, "follow-up", stopLands);
    let settled: { recordedStop: boolean };
    if (stopLands === "before the run records") {
      h.stop();
      settled = h.finishRun();
    } else {
      h.generation.cancelRequested = false;
      const pending = h.owedTurns.hold("stream-1")!; // the run's own settlement is still in flight
      settled = h.finishRun();
      h.stop();
      pending.release();
    }
    const stoppedTurns = (settled.recordedStop ? 1 : 0) + h.turns.filter((turn) => turn.outcome === "stopped").length;
    assert.equal(stoppedTurns, 1, stopLands);
    assert.equal(h.turns.filter((turn) => turn.outcome === "answered").length, 0, `${stopLands}: nothing reruns`);
    assert.deepEqual(h.saved, ["message-1"], `${stopLands}: the input stays as history`);
  }
});

test("a run that fails after saving the input still starts the owed turn exactly once", async () => {
  const h = host();
  h.setDuringSave(() => h.finishRun({ failed: true }));
  const receipt = await h.admission.admit({ streamId: "stream-1", mode: "queue", text: "after the failure" });
  assert.equal(receipt.admitted, true);
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0]!.outcome, "answered");
  // A second admission after the run is gone is never owed by that run.
  const later = await h.admission.admit({ streamId: "stream-1", mode: "queue", text: "too late" });
  assert.deepEqual(later, { admitted: false, reason: "run_not_active", committed: false });
  assert.equal(h.turns.length, 1);
});

test("an owed turn that throws on start is reported once and never retried", () => {
  const errors: unknown[] = [];
  let starts = 0;
  const owedTurns = createChatOwedTurns<Context, Origin>({
    refuses: () => false,
    start: () => {
      starts += 1;
      throw new Error("no provider");
    },
    onStartError: (error) => errors.push(error),
  });
  owedTurns.open("s", { chatId: "c", ownerDocumentId: "d", context: { model: "m" } });
  const hold = owedTurns.hold("s")!;
  hold.register({ messageId: "m1" });
  owedTurns.settle("s", { committed: [], recordedStop: false });
  hold.release();
  owedTurns.settle("s", { committed: [{ messageId: "m1" }], recordedStop: false });
  assert.equal(starts, 1);
  assert.equal(errors.length, 1);
  assert.equal(owedTurns.hold("s"), undefined, "the run owes nothing more");
});

test("input saved while the chat is being deleted or the app quits is reported saved, never queued", async () => {
  for (const closing of ["chat deleted", "app quitting"] as const) {
    let deleting = false;
    const h = host({ refuses: () => deleting });
    h.setDuringSave(() => {
      if (closing === "chat deleted") deleting = true;
      else h.owedTurns.shutDown();
      h.finishRun();
    });
    const receipt = await h.admission.admit({ streamId: "stream-1", mode: "queue", text: "orphan" });
    assert.deepEqual(receipt, { admitted: false, reason: "run_not_active", committed: true, messageId: "message-1" }, closing);
    assert.equal(h.turns.length, 0, closing);
  }
});

test("a chat deleted after its input registered starts no owed turn", async () => {
  let deleting = false;
  const h = host({ refuses: () => deleting });
  h.closeQueue();
  const receipt = await h.admission.admit({ streamId: "stream-1", mode: "queue", text: "registered" });
  assert.equal(receipt.admitted, true);
  deleting = true;
  h.finishRun();
  assert.equal(h.turns.length, 0);
});

test("a run that ends with nothing owed starts nothing", () => {
  const h = host();
  h.finishRun();
  assert.equal(h.turns.length, 0);
});

test("a Stop naming another document leaves the settled run's owed turn alone", () => {
  const owedTurns = createChatOwedTurns<Context, Origin>({ refuses: () => false, start: () => undefined });
  owedTurns.open("s", { chatId: "c", ownerDocumentId: "doc-a", context: { model: "m" } });
  assert.equal(owedTurns.stop("s", "user_stop", "doc-b"), false);
  assert.notEqual(owedTurns.hold("s"), undefined);
  assert.equal(owedTurns.stop("s", "user_stop", "doc-a"), true);
  assert.equal(owedTurns.hold("s"), undefined, "a stopped run takes no more owed input");
});
