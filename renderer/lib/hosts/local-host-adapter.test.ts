import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_HOST_ID, type PeerRunEvent, type PeerRunSubscription } from "../../shared/peer-host";
import type { LocalRunFrameMessage } from "../../shared/local-run-frames";
import { ChatSessionControl } from "./chat-session-control";
import { ChatIntentLedger } from "./chat-intent-ledger";
import { LocalHostAdapter, type LocalChatApis } from "./local-host-adapter";

function recordingApis(overrides: Partial<LocalChatApis> = {}) {
  const calls: unknown[][] = [];
  const apis: LocalChatApis = {
    rename: async (...args) => void calls.push(["rename", ...args]),
    remove: async (...args) => void calls.push(["remove", ...args]),
    markRead: async (...args) => {
      calls.push(["markRead", ...args]);
      return true;
    },
    approve: async (...args) => void calls.push(["approve", ...args]),
    answerQuestionnaire: async (...args) => {
      calls.push(["answerQuestionnaire", ...args]);
      return { status: "expired" as const };
    },
    respondRemoteApproval: async (...args) => {
      calls.push(["respondRemoteApproval", ...args]);
      return { resolved: true as const };
    },
    respondRemoteQuestion: async (...args) => {
      calls.push(["respondRemoteQuestion", ...args]);
      return { status: "answered" as const };
    },
    stop: async (...args) => {
      calls.push(["stop", ...args]);
      return false;
    },
    admitRunInput: async (...args) => {
      calls.push(["admitRunInput", ...args]);
      return { admitted: true, queue: "steer" as const, committed: true, messageId: "m9" };
    },
    observeRun: async (...args) => {
      calls.push(["observeRun", ...args]);
      return { subscriptionId: "sub-1", key: "sub-1", runId: null, chatId: args[0], state: "idle", events: [], truncated: false };
    },
    unobserveRun: async (...args) => {
      calls.push(["unobserveRun", ...args]);
      return true;
    },
    onRunFrame: () => () => {},
    stopHostRun: async (...args) => {
      calls.push(["stopHostRun", ...args]);
      return true;
    },
    ...overrides,
  };
  return { apis, calls };
}

test("this Mac is always online and offers its local panels", () => {
  const adapter = new LocalHostAdapter(recordingApis().apis);
  assert.equal(adapter.hostId, LOCAL_HOST_ID);
  assert.equal(adapter.status().availability, "online");
  for (const capability of ["send", "cancel", "respondApproval", "answerQuestion", "steer", "rename", "remove", "localPanels", "observe"] as const) {
    assert.ok(adapter.capabilities().has(capability), capability);
  }
});

test("local control goes to this Mac's chat APIs with the pane's arguments", async () => {
  const { apis, calls } = recordingApis();
  const adapter = new LocalHostAdapter(apis);
  const session = new ChatSessionControl(adapter, { hostId: LOCAL_HOST_ID, chatId: "c1" }, new ChatIntentLedger());
  session.attach();

  await session.rename("Renamed");
  assert.equal(await session.cancel("stream-1"), false, "the stop result is the local one");
  assert.deepEqual(await session.submitInput("stream-1", "steer", "Use tables"), {
    admitted: true,
    queue: "steer",
    committed: true,
    messageId: "m9",
  });
  await session.respondApproval({ approvalId: "a1", decision: "allow", formFillExcludedOrders: [2] });
  await session.respondApproval({ approvalId: "a2", decision: "deny" });
  const answer = await session.answerQuestion({
    promptId: "q1",
    response: { version: 1, promptId: "q1", cancelled: false, answers: [{ questionIndex: 0, kind: "custom", answer: "Yes" }] },
  });
  assert.equal(answer?.status, "expired");
  await session.remove();

  assert.deepEqual(calls, [
    ["rename", "c1", "Renamed"],
    ["stop", "stream-1"],
    ["admitRunInput", "stream-1", { mode: "steer", text: "Use tables" }],
    ["approve", "a1", "allow", { formFillExcludedOrders: [2] }],
    ["approve", "a2", "deny", undefined],
    [
      "answerQuestionnaire",
      "q1",
      { version: 1, promptId: "q1", cancelled: false, answers: [{ questionIndex: 0, kind: "custom", answer: "Yes" }] },
    ],
    ["remove", "c1"],
  ]);
});

test("a prompt from a turn this Mac hosts for a phone resolves through the Remote service", async () => {
  const { apis, calls } = recordingApis();
  const adapter = new LocalHostAdapter(apis);
  await adapter.respondApproval("c1", { approvalId: "a1", decision: "allow", scope: "chat", source: "remote" });
  await adapter.respondApproval("c1", { approvalId: "a2", decision: "deny", scope: "chat", source: "remote" });
  assert.deepEqual(calls, [
    ["respondRemoteApproval", "c1", "a1", "allow", "chat"],
    ["respondRemoteApproval", "c1", "a2", "deny", undefined],
  ]);
});

test("local failures reach the pane unchanged", async () => {
  const { apis } = recordingApis({
    approve: async () => {
      throw new Error("That approval is no longer pending.");
    },
  });
  const adapter = new LocalHostAdapter(apis);
  await assert.rejects(adapter.respondApproval("c1", { approvalId: "a1", decision: "allow" }), {
    message: "That approval is no longer pending.",
  });
});

test("phone-owned questions use host settlement and preserve an answer from another device", async () => {
  const { apis, calls } = recordingApis({
    answerQuestionnaire: async () => { throw new Error("Wrong renderer owner"); },
    respondRemoteQuestion: async (...args) => {
      calls.push(["respondRemoteQuestion", ...args]);
      return { status: "elsewhere" };
    },
  });
  const session = new ChatSessionControl(new LocalHostAdapter(apis), { hostId: LOCAL_HOST_ID, chatId: "c1" }, new ChatIntentLedger());
  session.attach();
  const result = await session.answerQuestion({
    source: "remote", promptId: "q1",
    response: { version: 1, promptId: "q1", cancelled: false, answers: [{ questionIndex: 0, kind: "custom", answer: "Every weekday" }] },
  });
  assert.equal(result?.status, "elsewhere");
  // The host scope comes from the attached session, not from the answer payload.
  // A single host dispatch must retain it even when another device answered first.
  assert.deepEqual(calls.map(([route, chatId, promptId]) => [route, chatId, promptId]), [
    ["respondRemoteQuestion", "c1", "q1"],
  ]);
});

test("local turns never go through the host send path", async () => {
  const { apis, calls } = recordingApis();
  await assert.rejects(new LocalHostAdapter(apis).send("c1", { text: "Hi", idempotencyKey: "aiden-0000000000000000" }), {
    code: "unsupported",
  });
  assert.deepEqual(calls, []);
});

function runEvent(runId: string, sequence: number, type: string, payload: Record<string, unknown> = {}): PeerRunEvent {
  return { protocolVersion: 1, streamId: runId, sequence, timestamp: new Date(sequence).toISOString(), type, terminal: false, payload };
}

/** A frame transport whose `observeRun` resolves only when the test says so. */
function frameTransport() {
  const handlers = new Set<(message: LocalRunFrameMessage) => void>();
  let resolve: (subscription: PeerRunSubscription) => void = () => {};
  const observed = new Promise<PeerRunSubscription>((settle) => {
    resolve = settle;
  });
  return {
    emit: (message: LocalRunFrameMessage) => {
      for (const handler of handlers) handler(message);
    },
    listeners: () => handlers.size,
    resolve: (subscription: PeerRunSubscription) => resolve(subscription),
    overrides: {
      observeRun: () => observed,
      onRunFrame: (handler: (message: LocalRunFrameMessage) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    } satisfies Partial<LocalChatApis>,
  };
}

function recordingObserver() {
  const seen: string[] = [];
  return {
    seen,
    observer: {
      onSubscription: (subscription: PeerRunSubscription) =>
        seen.push(`subscription:${subscription.runId}:${subscription.events.map((event) => event.sequence).join(",")}`),
      onEvent: (event: PeerRunEvent) => seen.push(`${event.type}@${event.sequence}`),
      onState: (state: string) => seen.push(`state:${state}`),
      onError: (error: { message: string }) => seen.push(`error:${error.message}`),
    },
  };
}

test("frames that beat the subscription are replayed after its buffered events, for this subscription only", async () => {
  const transport = frameTransport();
  const { apis } = recordingApis(transport.overrides);
  const { seen, observer } = recordingObserver();
  const close = new LocalHostAdapter(apis).observe("c1", observer);

  transport.emit({ subscriptionId: "sub-1", chatId: "c1", frames: [{ kind: "event", event: runEvent("run-1", 3, "text_delta", { text: "lo" }) }] });
  transport.emit({ subscriptionId: "sub-other", chatId: "c1", frames: [{ kind: "event", event: runEvent("run-9", 1, "text_delta") }] });
  transport.emit({ subscriptionId: "sub-1", chatId: "c2", frames: [{ kind: "event", event: runEvent("run-2", 1, "text_delta") }] });
  assert.deepEqual(seen, [], "nothing is delivered before the subscription");

  transport.resolve({
    subscriptionId: "sub-1",
    key: "sub-1",
    runId: "run-1",
    chatId: "c1",
    state: "streaming",
    events: [runEvent("run-1", 1, "run.started"), runEvent("run-1", 2, "text_delta", { text: "Hel" })],
    truncated: false,
  });
  await new Promise((settle) => setImmediate(settle));
  transport.emit({
    subscriptionId: "sub-1",
    chatId: "c1",
    frames: [
      { kind: "event", event: runEvent("run-1", 4, "done") },
      { kind: "state", runId: "run-1", state: "ended" },
    ],
  });

  assert.deepEqual(seen, ["subscription:run-1:1,2", "text_delta@3", "done@4", "state:ended"]);
  close();
  transport.emit({ subscriptionId: "sub-1", chatId: "c1", frames: [{ kind: "event", event: runEvent("run-1", 5, "text_delta") }] });
  assert.equal(seen.length, 4, "a closed observation hears nothing more");
  assert.equal(transport.listeners(), 0);
});

test("an observation closed before main answered is released as soon as it does", async () => {
  const transport = frameTransport();
  const { apis, calls } = recordingApis(transport.overrides);
  const { seen, observer } = recordingObserver();
  const close = new LocalHostAdapter(apis).observe("c1", observer);
  close();
  transport.resolve({ subscriptionId: "sub-7", key: "sub-7", runId: "run-1", chatId: "c1", state: "streaming", events: [], truncated: false });
  await new Promise((settle) => setImmediate(settle));
  assert.deepEqual(calls, [["unobserveRun", "sub-7"]]);
  assert.deepEqual(seen, []);
});

test("a refused observation reports an error instead of hanging", async () => {
  const { apis } = recordingApis({
    observeRun: async () => {
      throw new Error("The application document changed.");
    },
  });
  const { seen, observer } = recordingObserver();
  new LocalHostAdapter(apis).observe("c1", observer);
  await new Promise((settle) => setImmediate(settle));
  assert.deepEqual(seen, ["error:The application document changed."]);
});

test("Stop uses host authority only for a run this window is watching but does not own", async () => {
  const { apis, calls } = recordingApis({
    observeRun: async (chatId) => ({
      subscriptionId: "sub-1",
      key: "sub-1",
      runId: "run-phone",
      chatId,
      state: "streaming",
      events: [],
      truncated: false,
    }),
  });
  const adapter = new LocalHostAdapter(apis);
  assert.equal(await adapter.cancel("c1", { runId: "run-phone" }), false, "an unwatched run is not escalated");

  const close = adapter.observe("c1", recordingObserver().observer);
  await new Promise((settle) => setImmediate(settle));
  assert.equal(await adapter.cancel("c1", { runId: "run-phone" }), true);
  assert.equal(await adapter.cancel("c1", { runId: "run-elsewhere" }), false);
  close();
  assert.equal(await adapter.cancel("c1", { runId: "run-phone" }), false, "closing the observation drops the authority");

  assert.deepEqual(
    calls.filter(([route]) => route === "stop" || route === "stopHostRun"),
    [
      ["stop", "run-phone"],
      ["stop", "run-phone"],
      ["stopHostRun", "run-phone"],
      ["stop", "run-elsewhere"],
      ["stop", "run-phone"],
    ],
  );
});
