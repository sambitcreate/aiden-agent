import assert from "node:assert/strict";
import test from "node:test";
import { AIDEN_REMOTE_PROTOCOL_VERSION } from "./aiden-remote-protocol.js";
import { PEER_BACKOFF_STEPS_MS, PeerHostManager, type PeerManagerRegistry } from "./peer-host-manager.js";
import { PEER_BOT_SESSION_CHANNEL } from "./peer-bot-sessions.js";
import { PeerTransportError, type PeerRequest, type PeerStreamEnd } from "./peer-transport.js";
import type { PeerHostView } from "../../renderer/shared/peer-host.js";
import type { PeerBotSessionMessage } from "../../renderer/shared/peer-bot-session.js";

class FakeTimers {
  now = 1_000_000;
  private next = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();
  set = (callback: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, callback });
    return id;
  };
  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.now || !this.pending.has(id)) continue;
      this.pending.delete(id);
      timer.callback();
    }
  }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 25; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

const VIEW: PeerHostView = {
  id: "host_a",
  name: "Studio",
  enabled: true,
  state: "connected",
  features: ["bot-durable-session-v1", "bot-activity-v1"],
  capabilities: ["chat:read", "chat:write", "bot:read", "bot:write"],
};

function frame(type: string, seq: number, payload: unknown, epoch = "e1"): string {
  return `id: ${epoch}:${seq}\nevent: ${type}\ndata: ${JSON.stringify({
    protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
    botId: "bot_1",
    epoch,
    seq,
    type,
    payload,
  })}`;
}

function snapshot(epoch: string, text: string): string {
  return frame(
    "snapshot",
    0,
    {
      session: {
        botId: "bot_1",
        epoch,
        seq: 0,
        state: "idle",
        interrupted: false,
        entries: [{ type: "message", id: "m1", role: "user", text }],
        hasOlder: false,
        question: null,
        approval: null,
      },
    },
    epoch,
  );
}

interface OpenStream {
  path: string;
  send(frame: string): void;
  /** The host ends the stream cleanly, as it does when the session closes. */
  end(): void;
  /** The host refuses the stream. */
  refuse(status: number): void;
  aborted: boolean;
}

function harness(view: PeerHostView = VIEW) {
  const timers = new FakeTimers();
  const streams: OpenStream[] = [];
  const messages: PeerBotSessionMessage[] = [];
  const registry: PeerManagerRegistry = {
    list: async () => [view],
    connect: async () => view,
    request: (_id: string, input: Omit<PeerRequest, "credential">, onFrame?: (frame: string) => void) =>
      new Promise<unknown>((resolve, reject) => {
        const stream: OpenStream = {
          path: input.path,
          aborted: false,
          send: (text) => onFrame?.(text),
          end: () => resolve({ reason: "eof" } satisfies PeerStreamEnd),
          refuse: (status) => reject(new PeerTransportError("request_failed", status)),
        };
        input.signal?.addEventListener("abort", () => {
          stream.aborted = true;
          reject(new PeerTransportError("unavailable"));
        });
        streams.push(stream);
        input.onOpen?.();
      }),
    setEnabled: async () => undefined,
    remove: async () => undefined,
    onChanged: () => () => undefined,
    attachConnectionState: () => undefined,
  };
  const manager = new PeerHostManager({
    registry,
    broadcast: (channel, payload) => {
      if (channel === PEER_BOT_SESSION_CHANNEL) messages.push(payload as PeerBotSessionMessage);
    },
    timers,
    now: () => timers.now,
    random: () => 0.5,
  });
  return { manager, timers, streams, messages };
}

const events = (messages: readonly PeerBotSessionMessage[]) =>
  messages.flatMap((message) => (message.kind === "event" ? [message.event] : []));

test("windows following one host Bot share a single session stream and get its parsed events", async () => {
  const { manager, streams, messages } = harness();
  try {
    await manager.whenReady();
    await settle();
    const a = await manager.botSessionSubscribe("host_a", "bot_1", "window-a");
    const b = await manager.botSessionSubscribe("host_a", "bot_1", "window-b");
    await settle();
    assert.notEqual(a.subscriptionId, b.subscriptionId);
    assert.deepEqual(streams.map((stream) => stream.path), ["/bots/bot_1/session/events"]);

    streams[0]!.send(snapshot("e1", "hello"));
    streams[0]!.send(frame("state", 1, { state: "running", interrupted: false }));
    streams[0]!.send(frame("partial", 2, { text: "Hi th" }));
    assert.deepEqual(
      events(messages).map((event) => [event.type, event.seq]),
      [["snapshot", 0], ["state", 1], ["partial", 2]],
    );
    assert.ok(messages.some((message) => message.kind === "state" && message.state === "streaming"));

    // The stream stays open until its last window lets go.
    assert.equal(manager.botSessionUnsubscribe(a.subscriptionId, "window-a"), true);
    assert.equal(streams[0]!.aborted, false);
    assert.equal(manager.botSessionUnsubscribe(a.subscriptionId, "window-b"), false);
    manager.releaseOwner("window-b");
    await settle();
    assert.equal(streams[0]!.aborted, true);
  } finally {
    manager.close();
  }
});

test("a closed session reopens at once and adopts the new epoch's snapshot; a host that keeps closing backs off", async () => {
  const { manager, timers, streams, messages } = harness();
  try {
    await manager.whenReady();
    await settle();
    await manager.botSessionSubscribe("host_a", "bot_1", "window-a");
    await settle();
    streams[0]!.send(snapshot("e1", "before"));
    streams[0]!.send(frame("closed", 1, {}));
    streams[0]!.end();
    await settle();
    assert.equal(streams.length, 2, "a reset or reopen needs no backoff");
    assert.equal(
      messages.some((message) => message.kind === "state" && message.state === "waiting"),
      false,
      "no Reconnecting flash",
    );
    streams[1]!.send(snapshot("e2", "after"));
    const seen = events(messages);
    const last = seen[seen.length - 1];
    assert.equal(last?.type, "snapshot");
    assert.equal(last?.epoch, "e2");

    for (const index of [1, 2]) {
      streams[index]!.send(frame("closed", 1, {}));
      streams[index]!.end();
      await settle();
    }
    assert.equal(streams.length, 3, "the third close in a row waits");
    timers.advance(PEER_BACKOFF_STEPS_MS[0] * 2);
    await settle();
    assert.equal(streams.length, 4);
  } finally {
    manager.close();
  }
});

test("a refused stream ends for good and tells the windows the Bot is gone", async () => {
  const { manager, timers, streams, messages } = harness();
  try {
    await manager.whenReady();
    await settle();
    const { subscriptionId } = await manager.botSessionSubscribe("host_a", "bot_1", "window-a");
    await settle();
    streams[0]!.refuse(404);
    await settle();
    timers.advance(60_000);
    await settle();
    assert.equal(streams.length, 1);
    const final = messages[messages.length - 1];
    assert.equal(final?.kind === "state" && final.state, "gone");
    assert.equal(manager.botSessionUnsubscribe(subscriptionId, "window-a"), false);
  } finally {
    manager.close();
  }
});

test("a malformed frame drops the connection, forwards nothing and retries", async () => {
  const { manager, timers, streams, messages } = harness();
  try {
    await manager.whenReady();
    await settle();
    await manager.botSessionSubscribe("host_a", "bot_1", "window-a");
    await settle();
    streams[0]!.send(frame("snapshot", 0, { session: { botId: "bot_1" } }));
    await settle();
    assert.equal(streams[0]!.aborted, true);
    assert.equal(events(messages).length, 0);
    timers.advance(PEER_BACKOFF_STEPS_MS[1]);
    await settle();
    assert.equal(streams.length, 2);
  } finally {
    manager.close();
  }
});

test("a host that does not share its Bots' sessions refuses the subscription", async () => {
  const { manager, streams } = harness({ ...VIEW, features: ["host-events-v1"] });
  try {
    await manager.whenReady();
    await assert.rejects(manager.botSessionSubscribe("host_a", "bot_1", "window-a"), /does not share/);
    assert.equal(streams.length, 0);
  } finally {
    manager.close();
  }
});

test("a newer host's session opens here: unknown states, entries and events degrade instead of failing", async () => {
  const { manager, streams, messages } = harness();
  try {
    await manager.whenReady();
    await settle();
    await manager.botSessionSubscribe("host_a", "bot_1", "window-a");
    await settle();
    streams[0]!.send(
      frame("snapshot", 0, {
        session: {
          botId: "bot_1",
          epoch: "e1",
          seq: 0,
          state: "paused",
          interrupted: false,
          entries: [
            { type: "message", id: "m1", role: "user", text: "Book the flight" },
            { type: "hand_off", id: "h1", text: "Sign in for me" },
          ],
          hasOlder: false,
          question: null,
          approval: null,
          pausedBy: "person",
        },
      }),
    );
    streams[0]!.send(frame("hand_off", 1, { handOff: { id: "h1" } }));
    streams[0]!.send(frame("partial", 2, { text: "Still here" }));
    await settle();
    const seen = events(messages);
    const opened = seen[0];
    assert.equal(opened?.type, "snapshot");
    if (opened?.type === "snapshot") {
      assert.equal(opened.payload.session.state, "unavailable", "an unknown state reads as unavailable");
      assert.deepEqual(opened.payload.session.entries.map((entry) => entry.id), ["m1"], "an unreadable entry is left out");
    }
    assert.ok(
      messages.some((message) => message.kind === "resync"),
      "an unreadable event asks the windows to read the session again",
    );
    assert.equal(seen[seen.length - 1]?.type, "partial", "the stream carries on");
    assert.equal(streams.length, 1);
    assert.equal(streams[0]!.aborted, false);
  } finally {
    manager.close();
  }
});

test("a frame that is not a Bot session event at all still fails the stream", async () => {
  const { manager, streams } = harness();
  try {
    await manager.whenReady();
    await settle();
    await manager.botSessionSubscribe("host_a", "bot_1", "window-a");
    await settle();
    streams[0]!.send(snapshot("e1", "hello"));
    streams[0]!.send(`event: partial\ndata: ${JSON.stringify({ protocolVersion: 2, botId: "bot_1", epoch: "e1", seq: 1, type: "partial", payload: { text: "x" } })}`);
    await settle();
    assert.equal(streams[0]!.aborted, true);
  } finally {
    manager.close();
  }
});
