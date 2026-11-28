import assert from "node:assert/strict";
import test from "node:test";
import {
  GOAL_WINDOW_ROUND_CLAIM_MS,
  GoalWindowRounds,
  type GoalWindowDocument,
  type GoalWindowRoundRequest,
} from "./goal-window-rounds.js";

function harness(options: { locked?: boolean } = {}) {
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const lost: Array<{ chatId: string; streamId: string; documentId: string }> = [];
  let locked = options.locked ?? false;
  let tokens = 0;
  const rounds = new GoalWindowRounds<{ round: number }>({
    newToken: () => `token-${++tokens}`,
    screenLocked: () => locked,
    setTimer: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    closedMidRound: ({ chatId, streamId, documentId }) =>
      lost.push({ chatId, streamId, documentId }),
  });
  const documents = new Map<
    string,
    { document: GoalWindowDocument; requests: GoalWindowRoundRequest[] }
  >();
  const window = (documentId: string) => {
    const existing = documents.get(documentId);
    if (existing) return existing;
    const requests: GoalWindowRoundRequest[] = [];
    const entry = {
      document: { documentId, send: (request: GoalWindowRoundRequest) => requests.push(request) },
      requests,
    };
    documents.set(documentId, entry);
    return entry;
  };
  const show = (documentId: string, chatId: string | null, focused = true) =>
    rounds.report(window(documentId).document, { chatId, focused });
  return {
    rounds,
    timers,
    lost,
    show,
    requests: (documentId: string) => window(documentId).requests,
    lock: (value: boolean) => {
      locked = value;
    },
  };
}

test("a due round goes to the focused window showing the chat, which starts it", async () => {
  const h = harness();
  h.show("doc-a", "chat-1", false);
  h.show("doc-b", "chat-1", true);
  h.show("doc-c", "chat-2", true);
  const offered = h.rounds.offer("chat-1", { round: 2 });
  assert.deepEqual(h.requests("doc-a"), [], "an unfocused window isn't asked");
  assert.deepEqual(h.requests("doc-c"), [], "a window on another chat isn't asked");
  const [request] = h.requests("doc-b");
  assert.equal(request?.chatId, "chat-1");

  assert.equal(
    h.rounds.claim(request!.token, "doc-a"),
    undefined,
    "another document can't take it",
  );
  const claim = h.rounds.claim(request!.token, "doc-b");
  assert.deepEqual(claim?.payload, { round: 2 });
  assert.equal(h.rounds.claim(request!.token, "doc-b"), undefined, "a round is taken once");
  claim!.settle({ kind: "started", streamId: "stream-1" });
  assert.equal(await offered, "started");
  assert.equal(h.timers[0]?.cancelled, true, "the claim timer stops once the window takes it");
});

test("with no focused window on the chat, or the screen locked, the round runs without a window at once", async () => {
  const h = harness();
  assert.equal(await h.rounds.offer("chat-1", { round: 2 }), "no-window");
  h.show("doc-a", "chat-1", false);
  assert.equal(await h.rounds.offer("chat-1", { round: 2 }), "no-window");
  h.show("doc-a", "chat-1", true);
  h.lock(true);
  assert.equal(await h.rounds.offer("chat-1", { round: 2 }), "no-window");
  assert.deepEqual(h.requests("doc-a"), [], "a locked screen asks no window");
});

test("a window that declines, doesn't answer in time, or reports another chat leaves the round to run without it", async () => {
  const h = harness();
  h.show("doc-a", "chat-1");
  const declined = h.rounds.offer("chat-1", { round: 2 });
  h.rounds.decline(h.requests("doc-a")[0]!.token, "doc-a");
  assert.equal(await declined, "no-window");

  const silent = h.rounds.offer("chat-1", { round: 3 });
  const timer = h.timers[h.timers.length - 1]!;
  assert.equal(timer.ms, GOAL_WINDOW_ROUND_CLAIM_MS);
  timer.run();
  assert.equal(await silent, "no-window");
  assert.equal(
    h.rounds.claim(h.requests("doc-a")[1]!.token, "doc-a"),
    undefined,
    "a late claim finds nothing",
  );

  const moved = h.rounds.offer("chat-1", { round: 4 });
  h.show("doc-a", "chat-2");
  assert.equal(await moved, "no-window");
});

test("a window that couldn't start the round says so", async () => {
  const h = harness();
  h.show("doc-a", "chat-1");
  const offered = h.rounds.offer("chat-1", { round: 2 });
  h.rounds.claim(h.requests("doc-a")[0]!.token, "doc-a")!.settle({ kind: "busy" });
  assert.equal(await offered, "busy");
  h.rounds.gone("doc-a");
  assert.deepEqual(h.lost, [], "a round that never started isn't the window's to stop");
});

test("the window closing or showing another chat mid-round stops that round; losing focus doesn't", async () => {
  const h = harness();
  h.show("doc-a", "chat-1");
  const first = h.rounds.offer("chat-1", { round: 2 });
  h.rounds
    .claim(h.requests("doc-a")[0]!.token, "doc-a")!
    .settle({ kind: "started", streamId: "stream-1" });
  await first;
  h.show("doc-a", "chat-1", false);
  assert.deepEqual(h.lost, [], "Computer Use takes focus away; the round keeps going");
  h.show("doc-a", "chat-2", false);
  assert.deepEqual(h.lost, [{ chatId: "chat-1", streamId: "stream-1", documentId: "doc-a" }]);

  h.show("doc-a", "chat-1");
  const second = h.rounds.offer("chat-1", { round: 3 });
  h.rounds
    .claim(h.requests("doc-a")[1]!.token, "doc-a")!
    .settle({ kind: "started", streamId: "stream-2" });
  await second;
  h.rounds.gone("doc-a");
  assert.deepEqual(h.lost[h.lost.length - 1], {
    chatId: "chat-1",
    streamId: "stream-2",
    documentId: "doc-a",
  });
  assert.equal(
    await h.rounds.offer("chat-1", { round: 4 }),
    "no-window",
    "a closed window is never asked again",
  );
});

test("a round that settles is no longer the window's, so closing afterwards stops nothing", async () => {
  const h = harness();
  h.show("doc-a", "chat-1");
  const offered = h.rounds.offer("chat-1", { round: 2 });
  h.rounds
    .claim(h.requests("doc-a")[0]!.token, "doc-a")!
    .settle({ kind: "started", streamId: "stream-1" });
  await offered;
  h.rounds.settled("stream-1");
  h.rounds.gone("doc-a");
  assert.deepEqual(h.lost, []);
});

test("a window that switches chats while the round is starting stops it as soon as it starts", async () => {
  const h = harness();
  h.show("doc-a", "chat-1");
  const offered = h.rounds.offer("chat-1", { round: 2 });
  const claim = h.rounds.claim(h.requests("doc-a")[0]!.token, "doc-a")!;
  h.show("doc-a", "chat-2");
  claim.settle({ kind: "started", streamId: "stream-1" });
  assert.equal(await offered, "started");
  assert.deepEqual(h.lost, [{ chatId: "chat-1", streamId: "stream-1", documentId: "doc-a" }]);
});
