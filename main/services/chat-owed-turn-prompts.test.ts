import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTENDED_TURN_PROMPT_LIFETIME_MS,
  createOwedTurnPrompts,
  OWED_TURN_PROMPT_LIFETIME_MS,
  withPromptLifetime,
} from "./chat-owed-turn-prompts.js";

/**
 * The owed-turn cards as main wires them, with a hand-driven clock. A card
 * that expires is answered the way the coordinators would be: the approval
 * is denied, the question closed; both then report settlement back.
 */
function board() {
  let now = Date.parse("2026-11-11T10:00:00.000Z");
  const timers: Array<{ at: number; run: () => void; cleared: boolean }> = [];
  const changed: string[] = [];
  const expired: string[] = [];
  const prompts = createOwedTurnPrompts({
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    notifyChanged: (chatId) => changed.push(chatId),
    expireApproval: (id) => {
      expired.push(`approval:${id}`);
      prompts.settled(id);
    },
    expireQuestion: (id) => {
      expired.push(`question:${id}`);
      prompts.settled(id);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (!timer.cleared && timer.at <= now) {
        timer.cleared = true;
        timer.run();
      }
    }
  };
  return { prompts, changed, expired, advance, now: () => now };
}

const approval = (overrides: Record<string, unknown> = {}) => ({
  streamId: "owed-1",
  approvalId: "approval-1",
  toolCallId: "call-1",
  toolName: "bash",
  summary: "Run npm test",
  scopes: ["once", "chat"],
  ...overrides,
});

const question = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  promptId: "question-1",
  streamId: "owed-1",
  toolCallId: "call-2",
  questions: [{ question: "Which branch?", header: "Branch", multiSelect: false, options: [] }],
  ...overrides,
});

test("an owed turn's approval is shown for its chat only, with Allow and its lasting scopes", () => {
  const b = board();
  b.prompts.publish("chat-1", "chat:approval", approval());
  assert.deepEqual(b.changed, ["chat-1"]);
  assert.equal(b.prompts.approvalForChat("chat-2"), null);
  assert.deepEqual(b.prompts.approvalForChat("chat-1"), {
    approvalId: "approval-1",
    streamId: "owed-1",
    chatId: "chat-1",
    summary: "Run npm test",
    toolCallId: "call-1",
    toolName: "bash",
    expiresAt: new Date(b.now() + OWED_TURN_PROMPT_LIFETIME_MS).toISOString(),
    canAllow: true,
    scopes: ["chat"],
  });
  assert.equal(b.prompts.canDecide("chat-1", "approval-1", "allow"), true);
  assert.equal(b.prompts.canDecide("chat-2", "approval-1", "deny"), false, "another chat cannot answer it");
});

test("a model operation that needs its owning window can only be denied away from it", () => {
  const b = board();
  b.prompts.publish("chat-1", "chat:approval", approval({ toolName: "generate_image" }));
  const card = b.prompts.approvalForChat("chat-1")!;
  assert.equal(card.canAllow, false);
  assert.equal(card.scopes, undefined);
  assert.equal(b.prompts.canDecide("chat-1", "approval-1", "allow"), false);
  assert.equal(b.prompts.canDecide("chat-1", "approval-1", "deny"), true);
});

test("an answered approval disappears and its expiry never fires", () => {
  const b = board();
  b.prompts.publish("chat-1", "chat:approval", approval());
  b.prompts.settled("approval-1");
  assert.equal(b.prompts.approvalForChat("chat-1"), null);
  assert.equal(b.prompts.canDecide("chat-1", "approval-1", "deny"), false);
  assert.deepEqual(b.changed, ["chat-1", "chat-1"]);
  b.advance(OWED_TURN_PROMPT_LIFETIME_MS);
  assert.deepEqual(b.expired, []);
});

test("an approval nobody answers is denied after the phone card lifetime", () => {
  const b = board();
  b.prompts.publish("chat-1", "chat:approval", approval());
  b.advance(OWED_TURN_PROMPT_LIFETIME_MS - 1);
  assert.deepEqual(b.expired, []);
  b.advance(1);
  assert.deepEqual(b.expired, ["approval:approval-1"]);
  assert.equal(b.prompts.approvalForChat("chat-1"), null);
});

test("a goal round's approval waits 30 minutes, then is denied and its turn hears it expired", () => {
  const b = board();
  const heard: string[] = [];
  const lifetime = { ms: ATTENDED_TURN_PROMPT_LIFETIME_MS, expired: (chatId: string, kind: string) => heard.push(`${chatId}:${kind}`) };
  b.prompts.publish("chat-1", "chat:approval", approval({ streamId: "goal-1" }), lifetime);
  assert.equal(b.prompts.approvalForChat("chat-1")!.expiresAt, new Date(b.now() + 30 * 60_000).toISOString());
  b.advance(OWED_TURN_PROMPT_LIFETIME_MS);
  // Still open past an owed turn's five minutes.
  assert.deepEqual(b.expired, []);
  assert.equal(b.prompts.canDecide("chat-1", "approval-1", "allow"), true);
  b.advance(ATTENDED_TURN_PROMPT_LIFETIME_MS - OWED_TURN_PROMPT_LIFETIME_MS);
  assert.deepEqual(b.expired, ["approval:approval-1"]);
  assert.deepEqual(heard, ["chat-1:approval"]);
});

test("an answered goal-round card never reports expiry, nor does a question closed at the agent's own deadline", () => {
  const b = board();
  const heard: string[] = [];
  const lifetime = { ms: ATTENDED_TURN_PROMPT_LIFETIME_MS, expired: (chatId: string, kind: string) => heard.push(`${chatId}:${kind}`) };
  b.prompts.publish("chat-1", "chat:approval", approval({ streamId: "goal-1" }), lifetime);
  b.prompts.settled("approval-1");
  b.prompts.publish(
    "chat-1",
    "chat:questionnaire",
    question({ streamId: "goal-1", expiresAt: new Date(b.now() + 60_000).toISOString() }),
    lifetime,
  );
  b.advance(ATTENDED_TURN_PROMPT_LIFETIME_MS);
  assert.deepEqual(b.expired, ["question:question-1"]);
  assert.deepEqual(heard, []);
});

test("a question closes at the agent's own deadline, never later than the card lifetime", () => {
  const early = board();
  early.prompts.publish(
    "chat-1",
    "chat:questionnaire",
    question({ expiresAt: new Date(early.now() + 60_000).toISOString() }),
  );
  assert.equal(early.prompts.questionForChat("chat-1")!.expiresAt, new Date(early.now() + 60_000).toISOString());
  early.advance(60_000);
  assert.deepEqual(early.expired, ["question:question-1"]);
  assert.equal(early.prompts.questionForChat("chat-1"), null);

  const late = board();
  late.prompts.publish(
    "chat-1",
    "chat:questionnaire",
    question({ expiresAt: new Date(late.now() + 60 * 60_000).toISOString() }),
  );
  late.advance(OWED_TURN_PROMPT_LIFETIME_MS);
  assert.deepEqual(late.expired, ["question:question-1"]);
});

test("an open question is the chat's, with its questions, until it is answered", () => {
  const b = board();
  b.prompts.publish("chat-1", "chat:questionnaire", question());
  assert.equal(b.prompts.questionForChat("chat-2"), null);
  assert.equal(b.prompts.hasQuestion("chat-2", "question-1"), false);
  assert.deepEqual(b.prompts.questionForChat("chat-1"), {
    promptId: "question-1",
    streamId: "owed-1",
    chatId: "chat-1",
    toolCallId: "call-2",
    questions: [{ question: "Which branch?", header: "Branch", multiSelect: false, options: [] }],
    expiresAt: new Date(b.now() + OWED_TURN_PROMPT_LIFETIME_MS).toISOString(),
  });
  b.prompts.settled("question-1");
  assert.equal(b.prompts.hasQuestion("chat-1", "question-1"), false);
});

test("the owed turn ending takes its open cards with it", () => {
  const b = board();
  b.prompts.publish("chat-1", "chat:approval", approval());
  b.prompts.publish("chat-1", "chat:questionnaire", question());
  b.prompts.publish("chat-2", "chat:approval", approval({ approvalId: "approval-2", streamId: "owed-2" }));
  b.prompts.publish("chat-1", "chat:done", { streamId: "owed-1" });
  assert.equal(b.prompts.approvalForChat("chat-1"), null);
  assert.equal(b.prompts.questionForChat("chat-1"), null);
  assert.equal(b.prompts.approvalForChat("chat-2")?.approvalId, "approval-2", "another turn's card stays");
  b.advance(OWED_TURN_PROMPT_LIFETIME_MS);
  assert.deepEqual(b.expired, ["approval:approval-2"]);
});

/** A window's owner wrapped for a goal round on screen, with a hand-driven clock. */
function windowRound() {
  let now = Date.parse("2026-11-11T10:00:00.000Z");
  const timers: Array<{ at: number; run: () => void; cleared: boolean }> = [];
  const sent: string[] = [];
  const expired: string[] = [];
  const answered = new Set<string>();
  const expiredCards: string[] = [];
  const owner = withPromptLifetime(
    { id: 7, documentId: "window-doc", isDestroyed: () => false, send: (channel) => sent.push(channel), onInvalidated: () => () => undefined },
    "chat-1",
    { ms: ATTENDED_TURN_PROMPT_LIFETIME_MS, expired: (chatId, kind) => expired.push(`${chatId}:${kind}`) },
    {
      now: () => now,
      setTimer: (run, ms) => {
        const timer = { at: now + ms, run, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
      expireApproval: (id) => {
        if (answered.has(id)) return false;
        expiredCards.push(`approval:${id}`);
        return true;
      },
      expireQuestion: (id) => {
        if (answered.has(id)) return false;
        expiredCards.push(`question:${id}`);
        return true;
      },
    },
  );
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (!timer.cleared && timer.at <= now) {
        timer.cleared = true;
        timer.run();
      }
    }
  };
  return { owner, sent, expired, expiredCards, answered, advance, now: () => now };
}

test("a goal round on screen shows its cards in the window, and one unanswered for 30 minutes is denied and reported", () => {
  const round = windowRound();
  assert.equal(round.owner.documentId, "window-doc", "the window still owns the round");
  round.owner.send("chat:approval", { approvalId: "a1", streamId: "s1", toolName: "bash", toolCallId: "t1", summary: "Run tests" });
  round.owner.send("chat:approval", { approvalId: "a2", streamId: "s1", toolName: "bash", toolCallId: "t2", summary: "Run lint" });
  assert.deepEqual(round.sent, ["chat:approval", "chat:approval"], "the window gets its cards as usual");
  round.answered.add("a2"); // the person answered the second card in the window
  round.advance(ATTENDED_TURN_PROMPT_LIFETIME_MS - 1);
  assert.deepEqual(round.expired, [], "29 minutes is not long enough");
  round.advance(1);
  assert.deepEqual(round.expiredCards, ["approval:a1"], "only the unanswered card is denied");
  assert.deepEqual(round.expired, ["chat-1:approval"], "and the goal hears it once");
});

test("a goal round on screen: a question past 30 minutes closes, its own sooner deadline doesn't count, and the round ending stops the clock", () => {
  const round = windowRound();
  round.owner.send("chat:questionnaire", { promptId: "q1", streamId: "s1", toolCallId: "t1", questions: [] });
  round.owner.send("chat:questionnaire", {
    promptId: "q2", streamId: "s1", toolCallId: "t2", questions: [],
    expiresAt: new Date(round.now() + 60_000).toISOString(),
  });
  round.advance(ATTENDED_TURN_PROMPT_LIFETIME_MS);
  assert.deepEqual(round.expiredCards, ["question:q1"], "the agent's own one-minute question closes itself");
  assert.deepEqual(round.expired, ["chat-1:question"]);

  const ended = windowRound();
  ended.owner.send("chat:approval", { approvalId: "a1", streamId: "s1", toolName: "bash", toolCallId: "t1", summary: "Run tests" });
  ended.owner.send("chat:done", { streamId: "s1" });
  ended.advance(ATTENDED_TURN_PROMPT_LIFETIME_MS);
  assert.deepEqual(ended.expired, [], "a round that ended has no card left to expire");
  assert.deepEqual(ended.sent, ["chat:approval", "chat:done"]);
});
