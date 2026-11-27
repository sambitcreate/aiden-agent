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
  carryOlderRemoteBotEntries,
  hostServesBotHandoffs,
  hostSharesBotSessions,
  remoteBotPlanView,
  remoteBotSessionGap,
  remoteBotSessionGapDescription,
  remoteBotSessionView,
  withOlderRemoteBotEntries,
  withRereadOlderRemoteBotEntries,
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
    resync: () => handler?.({ kind: "resync", hostId: "host_a", botId: "bot_1" }),
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

test("Try again after the host ended the stream as gone joins a new stream", async () => {
  const fake = fakeTransport([session()]);
  let joins = 0;
  fake.transport.subscribe = async () => {
    joins += 1;
    return { subscriptionId: `sub_${joins}`, state: "streaming" };
  };
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  fake.state("gone");
  assert.equal(follower.getState().gone, true);
  follower.reload();
  await settle();
  assert.equal(joins, 2, "the ended stream is not counted as joined");
  assert.equal(follower.getState().gone, false);
  fake.state("streaming");
  fake.push(event(5, { type: "partial", payload: { text: "live again" } }));
  assert.equal(follower.getState().view?.snapshot.partial, "live again");
});

test("only hosts that serve durable Bot sessions to this Mac get the Bot conversation", () => {
  const grants = ["bot:read", "bot:write", "chat:read", "chat:write"];
  assert.equal(hostSharesBotSessions({ features: ["bot-durable-session-v1"], capabilities: grants }), true);
  assert.equal(hostSharesBotSessions({ features: [], capabilities: grants }), false);
  assert.equal(hostSharesBotSessions({ features: ["bot-durable-session-v1"], capabilities: ["bot:read", "chat:read"] }), false);
});

test("a host that can't share a Bot's conversation is told the step that would help", () => {
  // A desktop at revision 25+ serves durable sessions; this Mac's pairing lacks the grants.
  const repair = { features: ["bot-delete-v1", "bot-durable-session-v1"] };
  assert.equal(remoteBotSessionGap(repair), "repair");
  assert.match(remoteBotSessionGapDescription(repair, "Studio"), /Pair this device with Studio again/);

  // `aiden serve` with durable Bot sessions off: updating would not help, the server's owner opts in.
  const server = { features: ["bot-delete-v1"] };
  assert.equal(remoteBotSessionGap(server), "enable_durable");
  const serverCopy = remoteBotSessionGapDescription(server, "nas");
  assert.match(serverCopy, /aiden bots enable-durable/);
  assert.match(serverCopy, /on nas/);
  assert.doesNotMatch(serverCopy, /Update Aiden/);

  // A host older than revision 25 advertises neither Bot token.
  const older = { features: [] };
  assert.equal(remoteBotSessionGap(older), "update");
  assert.equal(remoteBotSessionGapDescription(older, "Old Mac"), "Update Aiden on Old Mac to chat with its Bots here.");
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
  assert.equal(notice?.type === "assistant" && notice.text, "Scout needs you on your computer: Enter the 2FA code your bank sent you");
  const steps = applyAll(opened, legacy.events);
  const notices = (view: RemoteBotSessionView) => view.snapshot.entries.filter((entry) => entry.id.startsWith("handoff-notice:"));
  assert.equal(notices(steps[1]!).length, 0, "the line goes once the hand-off settles");
  const last = steps[steps.length - 1]!;
  assert.equal(last.paused, false);
  assert.equal(last.snapshot.state.kind, "unavailable");
  assert.ok(steps.every((step) => step.handoff === null));
  // The frames end where a fresh read of the session stands.
  assert.deepEqual(last, remoteBotSessionView(parseAidenRemoteBotSession(legacy.pausedSession)));
});

test("only a host that granted this Mac bot:handoffs gets hand-off answers and Pause from here", () => {
  assert.equal(hostServesBotHandoffs({ capabilities: ["bot:read", "bot:write", "bot:handoffs"] }), true);
  assert.equal(hostServesBotHandoffs({ capabilities: ["bot:read", "bot:write", "bot:activity"] }), false);
});

test("something newer than this Mac reads makes the follower read the session again", async () => {
  const fake = fakeTransport([session(), session({ seq: 9, state: "unavailable" })]);
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  fake.resync();
  await settle();
  assert.equal(fake.reads(), 2);
  assert.equal(follower.getState().view?.snapshot.seq, 9);
  follower.stop();
});

test("a burst of unreadable frames during a read becomes one follow-up read, and its answer is adopted", async () => {
  const fake = fakeTransport([session()]);
  const pending: ((outcome: PeerOperationOutcome) => void)[] = [];
  fake.transport.read = () => new Promise((resolve) => pending.push(resolve));
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  pending[0]!({ ok: true, value: session() });
  await settle();
  fake.resync();
  await settle();
  assert.equal(pending.length, 2, "the first resync reads");
  for (let index = 0; index < 12; index += 1) fake.resync();
  await settle();
  assert.equal(pending.length, 2, "no overlapping reads while one is out");
  pending[1]!({ ok: true, value: session({ seq: 7 }) });
  await settle();
  assert.equal(follower.getState().view?.snapshot.seq, 7, "the answer in hand is shown");
  assert.equal(pending.length, 3, "one more read covers what arrived meanwhile");
  pending[2]!({ ok: true, value: session({ seq: 9 }) });
  await settle();
  assert.equal(follower.getState().view?.snapshot.seq, 9);
  assert.equal(pending.length, 3);
  follower.stop();
});

test("a host's access card reaches this Mac's chat as the card it answers by wait id, and a cleared frame takes it away", () => {
  const card = { waitId: "access-55", target: "folder" as const, label: "Reports", place: "~/Reports", why: "Summarize reports.", choices: ["not_now", "once"] as Array<"not_now" | "once"> };
  const view = remoteBotSessionView(session({ accessRequest: card }));
  assert.deepEqual(view.snapshot.accessRequest, {
    botId: "bot_1", waitId: "access-55", toolCallId: "access-55", target: "folder", label: "Reports", place: "~/Reports",
    why: "Summarize reports.", choices: ["not_now", "once"],
  });
  const cleared = applyRemoteBotSessionEvent(view, event(5, { type: "access_request", payload: { accessRequest: null } }));
  assert.equal(cleared?.snapshot.seq, 5);
  assert.equal(cleared?.snapshot.accessRequest, null);
  assert.deepEqual(cleared?.snapshot.entries, view.snapshot.entries);
});

test("a host's plan reaches this Mac's chat as the plan card, and every change to it is a new revision", () => {
  const plan = parseAidenRemoteBotSession(contract.botPlans.session).plan!;
  const before = remoteBotSessionView(session());
  assert.equal(before.snapshot.plan, null);
  const after = applyRemoteBotSessionEvent(before, event(5, { type: "plan", payload: { plan } }));
  const shown = after?.snapshot.plan;
  assert.ok(shown);
  assert.equal(shown.planId, plan.planId);
  assert.equal(shown.botId, "bot_1");
  assert.equal(shown.status, plan.status);
  assert.deepEqual(shown.steps, plan.steps);
  assert.deepEqual(shown.items.map(({ line, details }) => ({ line, details })), plan.items.map(({ line, details }) => ({ line, details })));
  assert.equal(new Set(shown.items.map(({ id }) => id)).size, plan.items.length, "each item has its own key");
  // Reading the session again (a reload, a reconnect) shows the same card, so
  // it keeps its revision, its key, and with them its busy and error state.
  const reread = remoteBotSessionView(session({ seq: 9, plan }));
  assert.equal(reread.snapshot.plan?.revision, shown.revision);
  const again = applyRemoteBotSessionEvent(after!, event(6, { type: "plan", payload: { plan: { ...plan, status: "active" } } }));
  assert.notEqual(again?.snapshot.plan?.revision, shown.revision);
  const stepDone = { ...plan, steps: plan.steps.map((step, index) => (index === 0 ? { ...step, status: "done" as const } : step)) };
  assert.notEqual(remoteBotPlanView("bot_1", stepDone).revision, shown.revision, "a step finishing is a change too");
  assert.equal(applyRemoteBotSessionEvent(again!, event(7, { type: "plan", payload: { plan: null } }))?.snapshot.plan, null);
});

test("a host's memory line and routine suggestion become this Mac's own transcript rows", () => {
  const view = remoteBotSessionView(
    session({
      entries: [
        { type: "memory_update", id: "mem-1", createdAt: "2026-11-24T08:00:00.000Z" },
        {
          type: "routine_proposal", id: "rp-1", proposalId: "4b1f8a52-7f0e-4b8e-9d55-3f2c1a6b7e10", name: "Morning brief",
          prompt: "Summarize my day.", label: "Weekdays at 8:00 AM", status: "accepted", routineId: "routine-9",
        },
      ],
    }),
  );
  const [memory, routine] = view.snapshot.entries;
  assert.equal(memory?.type, "memory_update");
  assert.equal(memory?.at, Date.parse("2026-11-24T08:00:00.000Z"));
  assert.ok(routine?.type === "routine_proposal");
  assert.equal(routine.status, "accepted");
  assert.equal(routine.routineId, "routine-9");
  assert.deepEqual(
    { proposalId: routine.proposal.proposalId, name: routine.proposal.name, label: routine.proposal.label },
    { proposalId: "4b1f8a52-7f0e-4b8e-9d55-3f2c1a6b7e10", name: "Morning brief", label: "Weekdays at 8:00 AM" },
  );
});

test("Load older places the host's earlier page before what is shown, keeps it across a reconnect, and tells an older host apart", async () => {
  const message = (id: string, text: string) => ({ type: "message" as const, id, role: "assistant" as const, text });
  const newest = session({ hasOlder: true, entries: [message("m5", "Five"), message("m6", "Six")] });
  const fake = fakeTransport([newest, newest]);
  const asked: string[] = [];
  const pages: Record<string, PeerOperationOutcome> = {
    m5: { ok: true, value: { botId: "bot_1", epoch: "e1", entries: [message("m3", "Three"), message("m4", "Four")], hasOlder: true } },
    m3: { ok: true, value: { botId: "bot_1", epoch: "e1", entries: [message("m1", "One"), message("m2", "Two")], hasOlder: false } },
  };
  fake.transport.older = async (_hostId, _botId, before) => {
    asked.push(before);
    return pages[before]!;
  };
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  const texts = () => follower.getState().view!.snapshot.entries.map((entry) => (entry as { text?: string }).text);
  assert.deepEqual(await follower.loadOlder(), { kind: "loaded" });
  assert.deepEqual(texts(), ["Three", "Four", "Five", "Six"]);
  assert.equal(follower.getState().view!.hasOlder, true);

  // A reconnect's snapshot of the same session keeps what was loaded, read again from the host.
  fake.push(event(4, { type: "snapshot", payload: { session: session({ seq: 5, hasOlder: true, entries: [message("m5", "Five"), message("m6", "Six"), message("m7", "Seven")] }) } }));
  assert.deepEqual(texts(), ["Three", "Four", "Five", "Six", "Seven"]);
  await settle();
  assert.deepEqual(texts(), ["Three", "Four", "Five", "Six", "Seven"]);

  await follower.loadOlder();
  assert.deepEqual(texts(), ["One", "Two", "Three", "Four", "Five", "Six", "Seven"]);
  assert.equal(follower.getState().view!.hasOlder, false);
  assert.deepEqual(asked, ["m5", "m5", "m3"], "each page ends where the last began");

  // A new epoch is another transcript: the loaded pages go.
  fake.push(event(0, { type: "snapshot", payload: { session: session({ epoch: "e2", seq: 0, hasOlder: true, entries: [message("n1", "New")] }) } }, "e2"));
  assert.deepEqual(texts(), ["New"]);
  follower.stop();

  // A host older than revision 67 has no such route; one that moved on is read again.
  const old = fakeTransport([newest, newest]);
  old.transport.older = async () => ({ ok: false, error: { code: "not_found", message: "This Aiden Remote endpoint does not exist.", status: 404 } });
  const legacy = new RemoteBotSessionFollower(old.transport, "host_a", "bot_1");
  legacy.start();
  await settle();
  assert.deepEqual(await legacy.loadOlder(), { kind: "unsupported" });
  old.transport.older = async () => ({ ok: false, error: { code: "operation_stale", message: "This Bot's chat changed.", status: 409 } });
  assert.deepEqual(await legacy.loadOlder(), { kind: "loaded" });
  await settle();
  assert.equal(old.reads(), 2, "the session is read again");
  legacy.stop();
});

test("a snapshot that rewrote loaded history replaces it, and a page asked for before the snapshot is never placed", async () => {
  const message = (id: string, text: string) => ({ type: "message" as const, id, role: "assistant" as const, text });
  const newest = session({ hasOlder: true, entries: [message("m5", "Five"), message("m6", "Six")] });
  const fake = fakeTransport([newest]);
  // The host's history: "Four" is a routine's input that a later [SILENT] turn hides.
  let history = [message("m1", "One"), message("m2", "Two"), message("m3", "Three"), message("m4", "Four")];
  const asked: Array<[string, number | undefined]> = [];
  let hold: (() => void) | null = null;
  fake.transport.older = async (_hostId, _botId, before, limit) => {
    asked.push([before, limit]);
    // Holds the second Load older (re-reads always ask for a number of entries).
    if (hold === null && asked.length > 1 && limit === undefined) await new Promise<void>((resolve) => (hold = resolve));
    const end = before === "m5" ? history.length : history.findIndex((entry) => entry.id === before);
    if (end < 0) return { ok: false, error: { code: "http_error", status: 409, remoteCode: "operation_stale", message: "This Bot's chat changed. Read it again." } };
    const start = Math.max(0, end - (limit ?? 2));
    return { ok: true, value: { botId: "bot_1", epoch: "e1", entries: history.slice(start, end), hasOlder: start > 0 } };
  };
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  const texts = () => follower.getState().view!.snapshot.entries.map((entry) => (entry as { text?: string }).text);
  await follower.loadOlder();
  assert.deepEqual(texts(), ["Three", "Four", "Five", "Six"]);

  // The host hides "Four" and sends a snapshot of the same epoch: it is gone once the loaded part is read again.
  history = history.filter((entry) => entry.id !== "m4");
  fake.push(event(3, { type: "snapshot", payload: { session: session({ seq: 4, hasOlder: true, entries: [message("m5", "Five"), message("m6", "Six")] }) } }));
  await settle();
  assert.deepEqual(texts(), ["Three", "Five", "Six"], "nothing older than what was shown is added");
  assert.deepEqual(asked[1], ["m5", 2], "the loaded part is read again, as many entries as were kept");

  // A Load older that is out when another snapshot arrives belongs to the history before it.
  const pending = follower.loadOlder();
  await settle();
  fake.push(event(5, { type: "snapshot", payload: { session: session({ seq: 6, hasOlder: true, entries: [message("m5", "Five"), message("m6", "Six")] }) } }));
  await settle();
  hold!();
  assert.deepEqual(await pending, { kind: "loaded" });
  await settle();
  assert.equal(texts().includes("One"), false, "the page asked for before the snapshot was not placed");
  follower.stop();
});

test("loaded history longer than one page survives a same-epoch snapshot whole, and a rewrite in its oldest page still shows", async () => {
  const message = (id: string, text: string) => ({ type: "message" as const, id, role: "assistant" as const, text });
  let history = Array.from({ length: 450 }, (_, index) => message(`h${index}`, `Message ${index}`));
  const newest = () => session({ seq: 4, hasOlder: true, entries: history.slice(-2) });
  const fake = fakeTransport([newest()]);
  const asked: Array<[string, number | undefined]> = [];
  let failAt: number | null = null;
  fake.transport.older = async (_hostId, _botId, before, limit) => {
    asked.push([before, limit]);
    if (failAt === asked.length) return { ok: false, error: { code: "failed", message: "Offline.", status: 503 } };
    const end = history.findIndex((entry) => entry.id === before);
    if (end < 0) return { ok: false, error: { code: "http_error", status: 409, remoteCode: "operation_stale", message: "This Bot's chat changed. Read it again." } };
    const start = Math.max(0, end - (limit ?? 150));
    return { ok: true, value: { botId: "bot_1", epoch: "e1", entries: history.slice(start, end), hasOlder: start > 0 } };
  };
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  const ids = () => follower.getState().view!.snapshot.entries.map((entry) => entry.id);
  await follower.loadOlder();
  await follower.loadOlder();
  const loaded = history.slice(-302).map((entry) => entry.id);
  assert.deepEqual(ids(), loaded);

  // Nothing changed on the host: every one of the 300 loaded entries stays.
  asked.length = 0;
  fake.push(event(4, { type: "snapshot", payload: { session: newest() } }));
  await settle();
  assert.deepEqual(ids(), loaded);
  assert.equal(follower.getState().view!.olderCursor, loaded[0]);
  assert.ok(asked.every(([, limit]) => limit !== undefined && limit <= 200), "each read is a bounded page");

  // The host hides the oldest loaded entry: it goes, and the rest stays.
  history = history.filter((entry) => entry.id !== loaded[0]);
  fake.push(event(4, { type: "snapshot", payload: { session: newest() } }));
  await settle();
  assert.equal(ids().includes(loaded[0]!), false);
  assert.deepEqual(ids().slice(-301), loaded.slice(1));

  // A later page that fails keeps the pages already read, and Load older continues from there.
  asked.length = 0;
  failAt = 2;
  fake.push(event(4, { type: "snapshot", payload: { session: newest() } }));
  await settle();
  const kept = ids();
  assert.equal(kept.length, 202);
  assert.deepEqual(kept, loaded.slice(-202));
  assert.equal(follower.getState().view!.hasOlder, true);
  assert.equal(follower.getState().view!.olderCursor, kept[0]);
  follower.stop();
});

test("re-reading kept history from a newer host covers the same span, entries this Mac leaves out included, and no further", async () => {
  const message = (id: string, text: string) => ({ type: "message" as const, id, role: "assistant" as const, text });
  const newest = session({ hasOlder: true, entries: [message("m5", "Five"), message("m6", "Six")] });
  const fake = fakeTransport([newest]);
  // The host, newer than this Mac: two entries of a kind this Mac can't show sit just before "Five".
  let host = ["m1", "m2", "m3", "m4", "u1", "u2"];
  const asked: Array<[string, number | undefined]> = [];
  fake.transport.older = async (_hostId, _botId, before, limit) => {
    asked.push([before, limit]);
    const end = before === "m5" ? host.length : host.indexOf(before);
    if (end < 0) return { ok: false, error: { code: "http_error", status: 409, remoteCode: "operation_stale", message: "This Bot's chat changed. Read it again." } };
    const start = Math.max(0, end - (limit ?? 2));
    const sent = host.slice(start, end);
    return {
      ok: true,
      value: {
        botId: "bot_1", epoch: "e1", hasOlder: start > 0, olderCursor: sent[0], hostCount: sent.length,
        entries: sent.filter((id) => id.startsWith("m")).map((id) => message(id, id)),
      },
    };
  };
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  const ids = () => follower.getState().view!.snapshot.entries.map((entry) => entry.id);
  const snapshot = (seq: number) =>
    fake.push(event(seq, { type: "snapshot", payload: { session: session({ seq: seq + 1, hasOlder: true, entries: [message("m5", "Five"), message("m6", "Six")] }) } }));
  // Two Load olders: an all-unknown page, then "m3" and "m4".
  await follower.loadOlder();
  assert.deepEqual(ids(), ["m5", "m6"]);
  await follower.loadOlder();
  assert.deepEqual(ids(), ["m3", "m4", "m5", "m6"]);

  // Unchanged history: the re-read spans the four host entries loaded, so "m3" and "m4" stay.
  asked.length = 0;
  snapshot(4);
  await settle();
  assert.deepEqual(asked, [["m5", 4]], "one request, for the host entries the loaded pages spanned");
  assert.deepEqual(ids(), ["m3", "m4", "m5", "m6"]);
  assert.equal(follower.getState().view!.olderCursor, "m3");

  // The host drops "m3", the oldest kept: the re-read is bounded by the span it covered plus a slack,
  // and cut back to "m4", the earliest kept entry the host still has, so "m1" and "m2" are not added.
  host = host.filter((id) => id !== "m3");
  asked.length = 0;
  snapshot(6);
  await settle();
  assert.deepEqual(asked, [["m5", 4], ["m2", 2]]);
  assert.deepEqual(ids(), ["m4", "m5", "m6"]);
  assert.equal(follower.getState().view!.hasOlder, true);
  assert.equal(follower.getState().view!.olderCursor, "m4", "Load older resumes from an entry the host has");
  await follower.loadOlder();
  assert.deepEqual(ids(), ["m1", "m2", "m4", "m5", "m6"]);
  follower.stop();
});

test("a same-epoch snapshot that starts inside the loaded history keeps what was shown, and adds nothing older", async () => {
  const message = (id: string, text: string) => ({ type: "message" as const, id, role: "assistant" as const, text });
  // The host, newer than this Mac: "u…" entries are of kinds this Mac can't show.
  const host = ["m1", "m2", "m3", "m4", "u1", "u2", "m5", "u3", "m6", "m7"];
  const fake = fakeTransport([session({ hasOlder: true, entries: [message("m5", "m5"), message("m6", "m6")] })]);
  const asked: Array<[string, number | undefined]> = [];
  fake.transport.older = async (_hostId, _botId, before, limit) => {
    asked.push([before, limit]);
    const end = host.indexOf(before);
    if (end < 0) return { ok: false, error: { code: "http_error", status: 409, remoteCode: "operation_stale", message: "This Bot's chat changed. Read it again." } };
    const start = Math.max(0, end - (limit ?? 2));
    const sent = host.slice(start, end);
    return {
      ok: true,
      value: {
        botId: "bot_1", epoch: "e1", hasOlder: start > 0, olderCursor: sent[0], hostCount: sent.length,
        entries: sent.filter((id) => id.startsWith("m")).map((id) => message(id, id)),
      },
    };
  };
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  const ids = () => follower.getState().view!.snapshot.entries.map((entry) => entry.id);
  await follower.loadOlder();
  await follower.loadOlder();
  assert.deepEqual(ids(), ["m3", "m4", "m5", "m6"]);

  // A new reply: the snapshot now starts at "m6", so "m5" joins the kept part.
  asked.length = 0;
  fake.push(event(4, { type: "snapshot", payload: { session: session({ seq: 5, hasOlder: true, entries: [message("m6", "m6"), message("m7", "m7")] }) } }));
  await settle();
  assert.deepEqual(ids(), ["m3", "m4", "m5", "m6", "m7"], "everything shown stays, and m1 and m2 are not added");
  assert.equal(follower.getState().view!.olderCursor, "m3", "Load older resumes where it was");
  assert.equal(follower.getState().view!.hasOlder, true);
  assert.ok(asked.length <= 2 && asked.every(([, limit]) => (limit ?? 0) <= 200), JSON.stringify(asked));
  await follower.loadOlder();
  assert.deepEqual(ids(), ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
  follower.stop();
});

test("a shifted snapshot keeps every kept entry the host still has, however many unshown entries sit between them", async () => {
  const message = (id: string, text: string) => ({ type: "message" as const, id, role: "assistant" as const, text });
  // The host, newer than this Mac: five "u…" entries this Mac can't show sit between "m3" and "m4",
  // more than the two entries this Mac keeps across the snapshot.
  let host = ["m1", "m2", "m3", "u1", "u2", "u3", "u4", "u5", "m4", "m5", "m6", "m7"];
  const fake = fakeTransport([session({ hasOlder: true, entries: [message("m3", "m3"), message("m4", "m4"), message("m5", "m5")] })]);
  const asked: Array<[string, number | undefined]> = [];
  fake.transport.older = async (_hostId, _botId, before, limit) => {
    asked.push([before, limit]);
    const end = host.indexOf(before);
    if (end < 0) return { ok: false, error: { code: "http_error", status: 409, remoteCode: "operation_stale", message: "This Bot's chat changed. Read it again." } };
    const start = Math.max(0, end - (limit ?? 2));
    const sent = host.slice(start, end);
    return {
      ok: true,
      value: {
        botId: "bot_1", epoch: "e1", hasOlder: start > 0, olderCursor: sent[0], hostCount: sent.length,
        entries: sent.filter((id) => id.startsWith("m")).map((id) => message(id, id)),
      },
    };
  };
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  const ids = () => follower.getState().view!.snapshot.entries.map((entry) => entry.id);
  const snapshot = (seq: number, entries: string[]) =>
    fake.push(event(seq, { type: "snapshot", payload: { session: session({ seq: seq + 1, hasOlder: true, entries: entries.map((id) => message(id, id)) }) } }));

  // The snapshot now starts at "m5": "m3" and "m4" are kept, and both are read back.
  snapshot(4, ["m5", "m6"]);
  await settle();
  assert.deepEqual(ids(), ["m3", "m4", "m5", "m6"], "nothing shown is lost, and m1 and m2 are not added");
  assert.equal(follower.getState().view!.hasOlder, true);
  assert.ok(asked.every(([, limit]) => (limit ?? 0) <= 200), JSON.stringify(asked));

  // The host drops "m3": the re-read stops at "m4", the earliest kept entry it still has.
  host = host.filter((id) => id !== "m3");
  snapshot(6, ["m6", "m7"]);
  await settle();
  assert.deepEqual(ids(), ["m4", "m5", "m6", "m7"]);
  assert.ok(host.includes(follower.getState().view!.olderCursor ?? ""), "Load older starts from an entry the host has");
  await follower.loadOlder();
  assert.deepEqual(ids(), ["m2", "m4", "m5", "m6", "m7"], "Load older goes on from an entry the host has");
  follower.stop();
});

test("a rewrite that removed every kept entry asks the host about only a few of them", async () => {
  const message = (id: string) => ({ type: "message" as const, id, role: "assistant" as const, text: id });
  const keptIds = Array.from({ length: 30 }, (_, index) => `k${index + 1}`);
  // The host rewrote its history: none of the kept entries is left.
  const host = [...Array.from({ length: 80 }, (_, index) => `h${index + 1}`), "m5", "m6", "m7"];
  const fake = fakeTransport([session({ hasOlder: true, entries: [...keptIds, "m5", "m6"].map(message) })]);
  const asked: Array<[string, number | undefined]> = [];
  fake.transport.older = async (_hostId, _botId, before, limit) => {
    asked.push([before, limit]);
    const end = host.indexOf(before);
    if (end < 0) return { ok: false, error: { code: "http_error", status: 409, remoteCode: "operation_stale", message: "This Bot's chat changed. Read it again." } };
    const start = Math.max(0, end - (limit ?? 2));
    const sent = host.slice(start, end);
    return { ok: true, value: { botId: "bot_1", epoch: "e1", hasOlder: start > 0, olderCursor: sent[0], hostCount: sent.length, entries: sent.map(message) } };
  };
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  fake.push(event(4, { type: "snapshot", payload: { session: session({ seq: 5, hasOlder: true, entries: ["m5", "m6", "m7"].map(message) }) } }));
  await settle();
  const probes = asked.filter(([before]) => before.startsWith("k"));
  assert.ok(probes.length > 0 && probes.length <= 8, JSON.stringify(probes));
  assert.ok(asked.length <= probes.length + 2, JSON.stringify(asked));
  // Kept entries were left unasked, so the loaded part is dropped and Load older starts again.
  assert.deepEqual(follower.getState().view!.snapshot.entries.map((entry) => entry.id), ["m5", "m6", "m7"]);
  assert.equal(follower.getState().view!.hasOlder, true);
  follower.stop();
});

test("running out of questions drops the loaded part rather than show a partial re-read as it", async () => {
  const message = (id: string) => ({ type: "message" as const, id, role: "assistant" as const, text: id });
  const keptIds = Array.from({ length: 12 }, (_, index) => `k${index + 1}`);
  // The host removed the first ten kept entries; "k11" and "k12" remain, far back behind entries this Mac
  // can't show, and two new entries sit where the bounded re-read reaches.
  const host = ["k11", "k12", ...Array.from({ length: 60 }, (_, index) => `u${index + 1}`), "o1", "o2", "m5", "m6", "m7"];
  const fake = fakeTransport([session({ hasOlder: true, entries: [...keptIds, "m5", "m6"].map(message) })]);
  const asked: Array<[string, number | undefined]> = [];
  fake.transport.older = async (_hostId, _botId, before, limit) => {
    asked.push([before, limit]);
    const end = host.indexOf(before);
    if (end < 0) return { ok: false, error: { code: "http_error", status: 409, remoteCode: "operation_stale", message: "This Bot's chat changed. Read it again." } };
    const start = Math.max(0, end - (limit ?? 2));
    const sent = host.slice(start, end);
    return {
      ok: true,
      value: {
        botId: "bot_1", epoch: "e1", hasOlder: start > 0, olderCursor: sent[0], hostCount: sent.length,
        entries: sent.filter((id) => !id.startsWith("u")).map(message),
      },
    };
  };
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  fake.push(event(4, { type: "snapshot", payload: { session: session({ seq: 5, hasOlder: true, entries: ["m5", "m6", "m7"].map(message) }) } }));
  await settle();
  assert.ok(asked.filter(([before]) => before.startsWith("k")).length <= 8, JSON.stringify(asked));
  const ids = follower.getState().view!.snapshot.entries.map((entry) => entry.id);
  assert.deepEqual(ids, ["m5", "m6", "m7"], "a partial re-read missing k11 and k12 is not shown as the loaded part");
  assert.equal(follower.getState().view!.hasOlder, true);
  follower.stop();
});

test("a kept entry the host moved further back than the oldest is still read back", async () => {
  const message = (id: string) => ({ type: "message" as const, id, role: "assistant" as const, text: id });
  // The host moved "m4" before "m3", with an entry this Mac can't show between them.
  const host = ["m1", "m4", "u1", "m3", "m5", "m6", "m7"];
  const fake = fakeTransport([session({ hasOlder: true, entries: ["m3", "m4", "m5", "m6"].map(message) })]);
  const asked: Array<[string, number | undefined]> = [];
  fake.transport.older = async (_hostId, _botId, before, limit) => {
    asked.push([before, limit]);
    const end = host.indexOf(before);
    if (end < 0) return { ok: false, error: { code: "http_error", status: 409, remoteCode: "operation_stale", message: "This Bot's chat changed. Read it again." } };
    const start = Math.max(0, end - (limit ?? 2));
    const sent = host.slice(start, end);
    return {
      ok: true,
      value: {
        botId: "bot_1", epoch: "e1", hasOlder: start > 0, olderCursor: sent[0], hostCount: sent.length,
        entries: sent.filter((id) => id.startsWith("m")).map(message),
      },
    };
  };
  const follower = new RemoteBotSessionFollower(fake.transport, "host_a", "bot_1");
  follower.start();
  await settle();
  fake.push(event(4, { type: "snapshot", payload: { session: session({ seq: 5, hasOlder: true, entries: ["m5", "m6", "m7"].map(message) }) } }));
  await settle();
  assert.deepEqual(asked[0], ["m5", 2], "the first read reaches m3 but not m4");
  assert.deepEqual(follower.getState().view!.snapshot.entries.map((entry) => entry.id), ["m4", "m3", "m5", "m6", "m7"]);
  assert.equal(follower.getState().view!.hasOlder, true);
  follower.stop();
});

test("a host that reorders kept entries keeps every one the re-read finds, in the host's order", () => {
  const message = (id: string) => ({ type: "message" as const, id, role: "assistant" as const, text: id });
  const shown = remoteBotSessionView(session({ hasOlder: true, entries: ["m3", "m4", "m5", "m6"].map(message) }));
  const fresh = remoteBotSessionView(session({ seq: 6, hasOlder: true, entries: ["m5", "m6"].map(message) }));
  const kept = carryOlderRemoteBotEntries(shown, fresh);
  assert.deepEqual(kept.snapshot.entries.map((entry) => entry.id), ["m3", "m4", "m5", "m6"]);
  // The host now has "m4" before "m3".
  const reread = withRereadOlderRemoteBotEntries(kept, 2, fresh, [
    { botId: "bot_1", epoch: "e1", entries: ["m1", "m4", "m3"].map(message), hasOlder: false },
  ]);
  assert.deepEqual(reread.snapshot.entries.map((entry) => entry.id), ["m4", "m3", "m5", "m6"], "m1 is not added and m4 stays");
  assert.equal(reread.hasOlder, true);
  assert.equal(reread.olderCursor, "m4");
});

test("a page whose entries this Mac can't show still moves Load older past them", () => {
  const message = (id: string, text: string) => ({ type: "message" as const, id, role: "assistant" as const, text });
  const view = remoteBotSessionView(session({ hasOlder: true, entries: [message("m5", "Five")] }));
  const skipped = withOlderRemoteBotEntries(view, { botId: "bot_1", epoch: "e1", entries: [], hasOlder: true, olderCursor: "h3" });
  assert.equal(skipped.olderCursor, "h3", "the next page starts before the entries left out");
  assert.equal(skipped.hasOlder, true);
});
