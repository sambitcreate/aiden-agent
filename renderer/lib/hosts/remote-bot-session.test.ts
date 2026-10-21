import assert from "node:assert/strict";
import test from "node:test";
import type { PeerBotSessionMessage } from "../../shared/peer-bot-session";
import type { PeerOperationOutcome } from "../../shared/peer-host";
import { botTranscriptRows } from "../../main/bots/bot-transcript-rows";
import contract from "../../../protocol/aiden-remote/v1/fixtures/contract.json";
import {
  parseAidenRemoteBotSession,
  parseAidenRemoteBotSessionEvent,
  type AidenRemoteBotSession,
  type AidenRemoteBotSessionEvent,
} from "../../../main/services/aiden-remote-protocol";
import { RemoteBotSessionFollower, type RemoteBotSessionTransport } from "./remote-bot-session-follower";
import {
  applyRemoteBotSessionEvent,
  hostServesBotHandoffs,
  hostSharesBotSessions,
  remoteBotSessionView,
  type RemoteBotSessionView,
} from "./remote-bot-session";

function session(change: Partial<AidenRemoteBotSession> = {}): AidenRemoteBotSession {
  return {
    botId: "bot_1",
    epoch: "e1",
    seq: 4,
    state: "idle",
    interrupted: false,
    entries: [
      { type: "message", id: "m1", role: "user", text: "Plan my week", createdAt: "2026-10-20T09:00:00.000Z" },
      { type: "message", id: "m2", role: "assistant", text: "Here is the plan.", createdAt: "2026-10-20T09:00:05.000Z" },
    ],
    hasOlder: false,
    question: null,
    approval: null,
    ...change,
  };
}

function event(seq: number, body: Pick<AidenRemoteBotSessionEvent, "type" | "payload">, epoch = "e1"): AidenRemoteBotSessionEvent {
  return { protocolVersion: 1, botId: "bot_1", epoch, seq, ...body } as AidenRemoteBotSessionEvent;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeTransport(reads: AidenRemoteBotSession[] | ((attempt: number) => PeerOperationOutcome)) {
  let handler: ((message: PeerBotSessionMessage) => void) | null = null;
  let attempt = 0;
  const unsubscribed: string[] = [];
  const transport: RemoteBotSessionTransport = {
    subscribe: async () => ({ subscriptionId: "sub_1", state: "streaming" }),
    unsubscribe: async (id) => unsubscribed.push(id),
    onMessage: (next) => {
      handler = next;
      return () => {
        handler = null;
      };
    },
    read: async () => {
      const index = attempt++;
      if (typeof reads === "function") return reads(index);
      return { ok: true, value: reads[Math.min(index, reads.length - 1)] };
    },
  };
  return {
    transport,
    reads: () => attempt,
    unsubscribed,
    push: (body: AidenRemoteBotSessionEvent) => handler?.({ kind: "event", hostId: "host_a", botId: "bot_1", event: body }),
    state: (state: "waiting" | "streaming" | "gone") => handler?.({ kind: "state", hostId: "host_a", botId: "bot_1", state }),
    listening: () => handler !== null,
  };
}

test("the host's session draws as the same transcript rows a local Bot chat shows", () => {
  const view = remoteBotSessionView(
    session({
      state: "running",
      partial: "Checking your calendar",
      entries: [
        { type: "message", id: "m1", role: "user", text: "Daily check-in", label: "Morning routine" },
        { type: "message", id: "m2", role: "assistant", text: "Cut off", interrupted: true },
        { type: "failed_turn", id: "m2:failed", retryText: "Try again" },
        { type: "connect_card", id: "c1", pluginId: "notion", name: "Notion", iconId: "notion", reason: "To read your notes", status: "pending" },
      ],
      queued: [{ submissionId: "s9", mode: "queue", text: "and Friday?" }],
      activity: { phase: "a_phase_from_a_newer_mac", startedAt: 5 },
    }),
  );
  const rows = botTranscriptRows(view.snapshot.entries, view.snapshot.partial, {
    running: view.snapshot.state.kind === "running",
    level: "summary",
    queued: view.snapshot.queued,
  });
  const kinds = rows.map((row) => row.kind);
  assert.ok(kinds.includes("routine"), "a routine's input shows its label");
  assert.ok(kinds.includes("failed"), "a failed reply offers Retry");
  assert.ok(kinds.includes("connect"));
  assert.ok(kinds.includes("queued"));
  const streaming = rows.find((row) => row.kind === "assistant" && row.text === "Checking your calendar");
  assert.ok(streaming, "the reply being written shows as it streams");
  const queued = rows.find((row) => row.kind === "queued");
  assert.equal(queued?.kind === "queued" && queued.submissionId, "s9");
  assert.equal(view.snapshot.activity?.phase, "working", "an unknown phase reads as working");
  assert.equal(view.snapshot.queued[0]?.mode, "followUp");
});

test("a follower reads the session, then applies live events in order", async () => {
  const fake = fakeTransport([session()]);
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  assert.equal(follower.getState().view?.snapshot.entries.length, 2);

  fake.push(event(5, { type: "state", payload: { state: "running", interrupted: false } }));
  fake.push(event(6, { type: "partial", payload: { text: "Thinking about" } }));
  fake.push(event(7, { type: "approval", payload: { approval: { waitId: "w1", toolCallId: "t1", toolName: "bash", summary: "ls", canAllow: true } } }));
  const view = follower.getState().view!;
  assert.equal(view.snapshot.state.kind, "running");
  assert.equal(view.snapshot.partial, "Thinking about");
  assert.equal(view.approval?.waitId, "w1");

  fake.push(event(8, { type: "entry", payload: { entry: { type: "message", id: "m3", role: "assistant", text: "Done." } } }));
  fake.push(event(9, { type: "partial", payload: { text: "" } }));
  const shown = follower.getState().view?.snapshot.entries ?? [];
  assert.equal(shown[shown.length - 1]?.id, "m3");
  assert.equal(follower.getState().view?.snapshot.partial, null);
  assert.equal(fake.reads(), 1);
  follower.stop();
  await settle();
  assert.deepEqual(fake.unsubscribed, ["sub_1"]);
  assert.equal(fake.listening(), false);
});

test("an entry the host updates keeps its place in the transcript", async () => {
  const fake = fakeTransport([session()]);
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  fake.push(event(5, { type: "entry", payload: { entry: { type: "message", id: "m1", role: "user", text: "Plan my whole week" } } }));
  fake.push(event(6, { type: "entry", payload: { entry: { type: "message", id: "m3", role: "assistant", text: "Done." } } }));
  const entries = follower.getState().view?.snapshot.entries ?? [];
  assert.deepEqual(entries.map((entry) => entry.id), ["m1", "m2", "m3"]);
  const first = entries[0];
  assert.equal(first?.type === "user" && first.text, "Plan my whole week");
  follower.stop();
});

test("a gap or a new epoch makes the follower read the session again; a snapshot replaces it outright", async () => {
  const fake = fakeTransport([session(), session({ seq: 12, entries: [] })]);
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  fake.push(event(7, { type: "partial", payload: { text: "skipped ahead" } }));
  await settle();
  assert.equal(fake.reads(), 2);
  assert.equal(follower.getState().view?.snapshot.seq, 12);
  assert.equal(follower.getState().view?.snapshot.partial, null, "the skipped-ahead event was not applied");

  fake.push(event(0, { type: "snapshot", payload: { session: session({ epoch: "e2", seq: 0, entries: [] }) } }, "e2"));
  assert.equal(follower.getState().view?.snapshot.epoch, "e2");
  assert.equal(fake.reads(), 2, "a snapshot needs no read");
});

test("events that arrive while the first read is in flight apply on top of it", async () => {
  let release!: (outcome: PeerOperationOutcome) => void;
  const fake = fakeTransport(() => ({ ok: true, value: session() }));
  fake.transport.read = () => new Promise((resolve) => (release = resolve));
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  fake.push(event(4, { type: "partial", payload: { text: "already folded" } }));
  fake.push(event(5, { type: "partial", payload: { text: "new" } }));
  release({ ok: true, value: session() });
  await settle();
  assert.equal(follower.getState().view?.snapshot.partial, "new");
  assert.equal(follower.getState().view?.snapshot.seq, 5);
});

test("a host that says the Bot is gone, or failed to answer, is reported, and reload retries", async () => {
  const gone = fakeTransport(() => ({ ok: false, error: { code: "request_failed", status: 404, message: "Not found." } }));
  const lost = new RemoteBotSessionFollower(gone.transport, "host_a", "bot_1");
  lost.start();
  await settle();
  assert.equal(lost.getState().gone, true);

  const outcomes: PeerOperationOutcome[] = [
    { ok: false, error: { code: "unavailable", message: "Studio isn't reachable." } },
    { ok: true, value: session() },
  ];
  const flaky = fakeTransport((attempt) => outcomes[attempt]!);
  const follower = new RemoteBotSessionFollower(flaky.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  assert.equal(follower.getState().failed, "Studio isn't reachable.");
  follower.reload();
  await settle();
  assert.equal(follower.getState().failed, null);
  assert.equal(follower.getState().view?.snapshot.entries.length, 2);

  flaky.state("gone");
  assert.equal(follower.getState().gone, true);
});

test("Try again after the stream could not be joined joins it again", async () => {
  const fake = fakeTransport([session()]);
  let joins = 0;
  fake.transport.subscribe = async () => {
    joins += 1;
    if (joins === 1) throw new Error("Studio isn't reachable.");
    return { subscriptionId: "sub_2", state: "streaming" };
  };
  fake.transport.read = async () =>
    joins === 1 ? { ok: false, error: { code: "unavailable", message: "Studio isn't reachable." } } : { ok: true, value: session() };
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  assert.equal(follower.getState().failed, "Studio isn't reachable.");
  follower.reload();
  await settle();
  assert.equal(joins, 2);
  assert.equal(follower.getState().stream, "streaming");
  fake.push(event(5, { type: "partial", payload: { text: "live again" } }));
  assert.equal(follower.getState().view?.snapshot.partial, "live again");
  follower.stop();
  await settle();
  assert.deepEqual(fake.unsubscribed, ["sub_2"]);
});

test("only hosts that serve durable Bot sessions to this Mac get the Bot conversation", () => {
  const grants = ["bot:read", "bot:write", "chat:read", "chat:write"];
  assert.equal(hostSharesBotSessions({ features: ["bot-durable-session-v1"], capabilities: grants }), true);
  assert.equal(hostSharesBotSessions({ features: [], capabilities: grants }), false);
  assert.equal(hostSharesBotSessions({ features: ["bot-durable-session-v1"], capabilities: ["bot:read", "chat:read"] }), false);
});

/** The shared fixture's frames, applied in order as the follower would. */
function applyAll(view: RemoteBotSessionView, events: readonly unknown[]): RemoteBotSessionView[] {
  const steps: RemoteBotSessionView[] = [];
  let current = view;
  for (const raw of events) {
    const next = applyRemoteBotSessionEvent(current, parseAidenRemoteBotSessionEvent(raw));
    assert.ok(next, "every fixture frame follows the one before it");
    current = next;
    steps.push(current);
  }
  return steps;
}

test("a host's hand-off card, its answer and the person's pause reach this Mac as the shared fixture has them", () => {
  const fixture = contract.botHandoffs;
  const opened = remoteBotSessionView(parseAidenRemoteBotSession(fixture.session));
  assert.deepEqual(opened.handoff, fixture.session.handoff);
  assert.equal(opened.paused, false);
  assert.equal(opened.snapshot.state.kind, "running");

  const [shown, settled, answered, paused] = applyAll(opened, fixture.events);
  assert.equal(shown!.handoff?.waitId, fixture.session.handoff.waitId);
  assert.equal(settled!.handoff, null, "a settled card goes away");
  const rows = botTranscriptRows(answered!.snapshot.entries, null, { running: true, level: "summary", queued: [] });
  const mine = rows.filter((row) => row.kind === "user").map((row) => (row.kind === "user" ? row.text : ""));
  assert.ok(
    mine.includes("You did this: Enter the 2FA code your bank sent you\n\nThe code was from 9:01."),
    "the person's answer reads as their own message, with the note",
  );
  assert.equal(paused!.paused, true);
  assert.equal(paused!.snapshot.state.kind, "idle", "nothing runs while the Bot is paused");

  // The pause lifts onto the turn it cut short.
  const resumed = applyRemoteBotSessionEvent(
    paused!,
    parseAidenRemoteBotSessionEvent({ ...fixture.events[3], seq: 45, payload: { state: "interrupted", interrupted: true } }),
  );
  assert.equal(resumed?.paused, false);
  assert.equal(resumed?.snapshot.state.kind, "interrupted");

  const reread = remoteBotSessionView(parseAidenRemoteBotSession(fixture.pausedSession));
  assert.equal(reread.paused, true);
  assert.equal(reread.handoff, null);
});

test("a host that does not send this Mac hand-offs shows the Mac-only line, and a pause as unavailable", () => {
  const legacy = contract.botHandoffs.legacy;
  const opened = remoteBotSessionView(parseAidenRemoteBotSession(legacy.session));
  assert.equal(opened.handoff, null);
  const notice = opened.snapshot.entries.find((entry) => entry.id.startsWith("handoff-notice:"));
  assert.equal(notice?.type === "assistant" && notice.text, "Scout needs you on your Mac: Enter the 2FA code your bank sent you");
  const steps = applyAll(opened, legacy.events);
  const last = steps[steps.length - 1]!;
  assert.equal(last.paused, false);
  assert.equal(last.snapshot.state.kind, "unavailable");
  assert.ok(steps.every((step) => step.handoff === null));
});

test("only a host that granted this Mac bot:handoffs gets hand-off answers and Pause from here", () => {
  assert.equal(hostServesBotHandoffs({ capabilities: ["bot:read", "bot:write", "bot:handoffs"] }), true);
  assert.equal(hostServesBotHandoffs({ capabilities: ["bot:read", "bot:write", "bot:activity"] }), false);
});
