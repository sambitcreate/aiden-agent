import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { AidenRemoteHostFeedService, type AidenRemoteHostFeedState } from "./aiden-remote-host-feed.js";
import { AidenRemoteHostRunService } from "./aiden-remote-host-runs.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AidenRemoteCapability } from "./aiden-remote-protocol.js";
import type { AidenRemoteChatSummaryProjection } from "./aiden-remote-chats.js";
import { HostRunRegistry } from "./host-run-registry.js";
import { PeerHostRegistry, type PeerClient, type StoredPeerHost } from "./peer-host-registry.js";
import {
  PEER_BACKOFF_STEPS_MS,
  PEER_HOST_FEED_CHANNEL,
  PEER_HOST_STATE_CHANNEL,
  PEER_RUN_FRAME_CHANNEL,
  PEER_STABLE_MS,
  PEER_WAKE_COALESCE_MS,
  PeerHostManager,
  peerBackoffDelay,
  peerNetworkFingerprint,
} from "./peer-host-manager.js";
import { PEER_RUN_EVICT_MS } from "./peer-run-subscriptions.js";
import { PeerEventFrames, PeerTransportError, type PeerRequest, type PeerStreamEnd } from "./peer-transport.js";
import type {
  PeerHostFeedMessage,
  PeerHostStatus,
  PeerRunFrameMessage,
} from "../../renderer/shared/peer-host.js";

const CAPABILITIES = ["chat:read", "chat:write", "host:events", "runs:observe", "runs:control"];
const FEATURES = ["host-events-v1", "run-streams-v1", "run-control-v1"];
const CREDENTIAL = "c".repeat(43);
const ENDPOINT = "https://server.example/api/aiden/v1";

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

/** The most recent stream state a window was told about. */
function streamState(messages: readonly PeerRunFrameMessage[]): string | undefined {
  const states = messages.flatMap((message) => (message.kind === "state" ? [message.state] : []));
  return last(states);
}

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

/** Lets promise chains and SSE pumps run to quiescence. */
async function settle(): Promise<void> {
  for (let round = 0; round < 25; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The `ServerResponse` surface the real host SSE writers use. */
class Wire extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  constructor(private readonly hooks: { write(chunk: string): void; end(): void; destroy(): void }) {
    super();
  }
  writeHead(): this {
    return this;
  }
  write(chunk: string): boolean {
    this.hooks.write(chunk);
    return true;
  }
  end(): this {
    this.writableEnded = true;
    queueMicrotask(() => {
      this.emit("finish");
      this.hooks.end();
    });
    return this;
  }
  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    this.hooks.destroy();
    return this;
  }
}

interface Session {
  path: string;
  /** The transport's five-minute session cap. */
  cap(): void;
  /** The connection drops without the cap. */
  drop(): void;
}

function summary(id: string, title: string, updatedAt = 2_000): AidenRemoteChatSummaryProjection {
  return {
    id,
    workspaceId: "workspace-1",
    title,
    titlePending: false,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    revision: `rev_${id}_${updatedAt}`,
    activity: "idle",
  } as AidenRemoteChatSummaryProjection;
}

function peerError(error: unknown): unknown {
  if (error instanceof PeerTransportError) return error;
  if (error instanceof AidenRemoteServiceError) {
    if ((error.status === 401 || error.status === 403) && error.code !== "capability_denied")
      return new PeerTransportError("authentication_required", error.status);
    return new PeerTransportError("request_failed", error.status, {
      code: error.code,
      retryable: error.retryable,
    });
  }
  return new PeerTransportError("unavailable");
}

/**
 * One paired host built from the real host-side services: run registry, run
 * streams and host feed. Its client speaks the transport's contract.
 */
class FakeHost {
  readonly calls: string[] = [];
  readonly sessions = new Set<Session>();
  readonly runs: HostRunRegistry;
  readonly service: AidenRemoteHostRunService;
  readonly feed: AidenRemoteHostFeedService;
  readonly state: { current: AidenRemoteHostFeedState };
  server: () => unknown = () => ({
    protocolVersion: 1,
    instanceId: this.id,
    capabilities: CAPABILITIES,
    features: FEATURES,
  });
  json: (input: PeerRequest) => Promise<unknown> = async () => {
    throw new PeerTransportError("request_failed", 404, { code: "not_found", retryable: false });
  };
  /** Holds a finished stream's resolution until the returned promise settles. */
  endGate: ((path: string) => Promise<void> | undefined) | undefined;
  private readonly device = {
    id: "desktop",
    capabilities: new Set<AidenRemoteCapability>(CAPABILITIES as AidenRemoteCapability[]),
  };

  constructor(readonly id: string, title: string) {
    const now = () => 5_000;
    this.runs = new HostRunRegistry({ now, epoch: `runs_${id}` });
    this.service = new AidenRemoteHostRunService({
      registry: this.runs,
      controls: {
        cancel: () => false,
        approve: () => false,
        answer: () => "rejected",
        admitInput: async () => ({ admitted: false }) as never,
      },
      now,
      heartbeatMs: 3_600_000,
    });
    this.state = {
      current: {
        summaries: [summary("chat-1", title)],
        botChatIds: new Set(),
        workspaces: [],
        bots: [],
      } as unknown as AidenRemoteHostFeedState,
    };
    this.feed = new AidenRemoteHostFeedService({
      source: { read: async () => this.state.current },
      now,
      epoch: `epoch_${id}`,
      debounceMs: 3_600_000,
      heartbeatMs: 3_600_000,
    });
  }

  client(): PeerClient {
    return {
      json: async (input) => {
        this.calls.push(`${input.method ?? "GET"} ${input.path}`);
        if (input.path === "/server") return this.server();
        if (input.path === "/device/capabilities") return { capabilities: CAPABILITIES };
        return this.json(input);
      },
      events: (input, onFrame) => this.events(input, onFrame),
    };
  }

  /** Requests other than identity checks. */
  traffic(): string[] {
    return this.calls.filter((call) => call !== "GET /server");
  }

  streams(prefix: string): Session[] {
    return [...this.sessions].filter((session) => session.path.startsWith(prefix));
  }

  async change(next: Partial<AidenRemoteHostFeedState>): Promise<void> {
    this.state.current = { ...this.state.current, ...next };
    this.feed.invalidate();
    await this.feed.refresh();
  }

  async noteRun(runId: string): Promise<void> {
    this.feed.noteRun(this.runs.summary(runId)!, false);
    await this.feed.refresh();
  }

  close(): void {
    this.feed.close();
    this.service.revokeDevice("desktop");
  }

  private events(input: PeerRequest, onFrame: (frame: string) => void): Promise<PeerStreamEnd> {
    this.calls.push(`EVENTS ${input.path}${input.lastEventId ? ` @${input.lastEventId}` : ""}`);
    return new Promise<PeerStreamEnd>((resolve, reject) => {
      const reader = new PeerEventFrames();
      const pending: string[] = [];
      let opened = false;
      let endPending = false;
      let done = false;
      const finish = (settleWith: () => void) => {
        if (done) return;
        done = true;
        this.sessions.delete(session);
        input.signal?.removeEventListener("abort", onAbort);
        settleWith();
      };
      const deliver = (chunk: string) => reader.push(Buffer.from(chunk), onFrame, () => {});
      const wire = new Wire({
        write: (chunk) => {
          if (done) return;
          if (opened) deliver(chunk);
          else pending.push(chunk);
        },
        end: () => {
          if (!opened) {
            endPending = true;
            return;
          }
          const gate = this.endGate?.(input.path);
          if (gate) void gate.then(() => finish(() => resolve({ reason: "eof" })));
          else finish(() => resolve({ reason: "eof" }));
        },
        destroy: () => finish(() => reject(new PeerTransportError("unavailable"))),
      });
      const session: Session = {
        path: input.path,
        cap: () => {
          finish(() => resolve({ reason: "capped" }));
          wire.destroy();
        },
        drop: () => wire.destroy(),
      };
      const onAbort = () => {
        finish(() => reject(new PeerTransportError("unavailable")));
        wire.destroy();
      };
      if (input.signal?.aborted) return onAbort();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.sessions.add(session);
      this.route(input, wire as unknown as ServerResponse).then(
        () => {
          if (done) return;
          opened = true;
          input.onOpen?.();
          for (const chunk of pending.splice(0)) deliver(chunk);
          if (endPending) finish(() => resolve({ reason: "eof" }));
        },
        (error: unknown) => finish(() => reject(peerError(error))),
      );
    });
  }

  private async route(input: PeerRequest, wire: ServerResponse): Promise<void> {
    const path = input.path;
    if (path === "/host/events") {
      await this.feed.open(this.device, input.lastEventId, wire);
      return;
    }
    const run = /^\/runs\/([^/]+)\/events$/u.exec(path);
    if (run) {
      this.service.openRunEvents(this.device, decodeURIComponent(run[1]!), Number(input.lastEventId ?? 0), wire);
      return;
    }
    const chat = /^\/chats\/([^/]+)\/runs\/current\/events$/u.exec(path);
    if (chat) {
      if (input.lastEventId !== undefined && input.lastEventId !== "0")
        throw new AidenRemoteServiceError("invalid_request", "Resume a run through its run ID.", 400);
      const runId = this.service.currentRunId(decodeURIComponent(chat[1]!));
      this.service.openRunEvents(this.device, runId, 0, wire);
      return;
    }
    throw new AidenRemoteServiceError("run_gone", "Not found.", 404);
  }
}

function stored(id: string, enabled = true): StoredPeerHost {
  return {
    id,
    name: id,
    endpoint: ENDPOINT,
    serverSpkiSha256: `sha256/${Buffer.alloc(32, 7).toString("base64")}`,
    deviceId: `device_${id}`,
    credential: CREDENTIAL,
    enabled,
    capabilities: CAPABILITIES,
    features: FEATURES,
  };
}

function setup(hosts: FakeHost[], records = hosts.map((host) => stored(host.id))) {
  const timers = new FakeTimers();
  const byId = new Map(hosts.map((host) => [host.id, host]));
  let saved = records;
  const registry = new PeerHostRegistry({
    storage: {
      load: async () => saved,
      save: async (next) => {
        saved = next;
      },
    },
    localInstanceId: async () => "self",
    deviceName: "Desktop",
    clientVersion: "1",
    platform: "mac",
    client: (trust) => byId.get((trust as StoredPeerHost).id)!.client(),
  });
  const sent: { channel: string; payload: unknown }[] = [];
  const manager = new PeerHostManager({
    registry,
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    now: () => timers.now,
    random: () => 0.5,
    timers,
  });
  const advance = async (ms: number) => {
    timers.advance(ms);
    await settle();
  };
  const statuses = (hostId: string) =>
    sent
      .filter((entry) => entry.channel === PEER_HOST_STATE_CHANNEL)
      .map((entry) => entry.payload as PeerHostStatus)
      .filter((status) => status.hostId === hostId);
  const status = (hostId: string) => manager.statuses().find((entry) => entry.hostId === hostId)!;
  const feed = (hostId: string) =>
    sent
      .filter((entry) => entry.channel === PEER_HOST_FEED_CHANNEL)
      .map((entry) => entry.payload as PeerHostFeedMessage)
      .filter((message) => message.hostId === hostId);
  const frames = (hostId: string) =>
    sent
      .filter((entry) => entry.channel === PEER_RUN_FRAME_CHANNEL)
      .map((entry) => entry.payload as PeerRunFrameMessage)
      .filter((message) => message.hostId === hostId);
  const events = (hostId: string) =>
    frames(hostId).flatMap((message) => (message.kind === "event" ? [message.event] : []));
  const close = () => {
    manager.close();
    for (const host of hosts) host.close();
  };
  return { timers, registry, manager, sent, advance, statuses, status, feed, frames, events, close };
}

test("two hosts with colliding chat and run IDs keep separate feeds and live runs", async () => {
  const a = new FakeHost("host_a", "Plans on A");
  const b = new FakeHost("host_b", "Plans on B");
  for (const host of [a, b]) host.runs.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  const harness = setup([a, b]);
  try {
    await harness.manager.whenReady();
    await settle();
    assert.equal(harness.status("host_a").state.kind, "connected");
    assert.equal(harness.status("host_a").feed, "live");
    assert.equal(harness.status("host_b").feed, "live");
    assert.equal(harness.manager.feedSnapshot("host_a")?.summaries[0]?.title, "Plans on A");
    assert.equal(harness.manager.feedSnapshot("host_b")?.summaries[0]?.title, "Plans on B");

    const onA = await harness.manager.runSubscribe("host_a", { chatId: "chat-1" }, 0, "window-1");
    const onB = await harness.manager.runSubscribe("host_b", { chatId: "chat-1" }, 0, "window-1");
    assert.notEqual(onA.subscriptionId, onB.subscriptionId);
    a.runs.publish("run-1", "chat:delta", { delta: "written on A" });
    b.runs.publish("run-1", "chat:delta", { delta: "written on B" });
    await settle();
    const textA = JSON.stringify(harness.events("host_a"));
    const textB = JSON.stringify(harness.events("host_b"));
    assert.match(textA, /written on A/);
    assert.doesNotMatch(textA, /written on B/);
    assert.match(textB, /written on B/);
    assert.doesNotMatch(textB, /written on A/);
    assert.deepEqual(a.streams("/chats/"), a.streams("/chats/").slice(0, 1), "one stream per host");

    // Nothing that reaches a window carries the pairing secret or the address.
    const everything = JSON.stringify(harness.sent);
    assert.equal(everything.includes(CREDENTIAL), false);
    assert.equal(everything.includes("server.example"), false);
  } finally {
    harness.close();
  }
});

test("a pin or identity mismatch blocks without retrying and only re-enabling clears it", async () => {
  const host = new FakeHost("host_a", "Plans");
  const revoked = new FakeHost("host_b", "Other");
  // The pinned transport reports a certificate that no longer matches as identity_changed.
  host.server = () => {
    throw new PeerTransportError("identity_changed");
  };
  // A revoked credential is a terminal 403 the transport maps to authentication_required.
  revoked.server = () => {
    throw new PeerTransportError("authentication_required", 403, { code: "credential_revoked", retryable: false });
  };
  const harness = setup([host, revoked]);
  try {
    await harness.manager.whenReady();
    await settle();
    assert.deepEqual(harness.status("host_a").state, { kind: "blocked", reason: "identity_changed" });
    assert.deepEqual(harness.status("host_b").state, { kind: "blocked", reason: "auth" });

    harness.manager.wake();
    await harness.advance(10 * 60_000);
    assert.deepEqual(host.calls, ["GET /server"], "a blocked host is never retried");
    assert.deepEqual(revoked.calls, ["GET /server"]);
    const outcome = await harness.manager.call("host_a", { operation: "summaries" });
    assert.deepEqual(outcome, {
      ok: false,
      error: { code: "identity_changed", message: new PeerTransportError("identity_changed").message },
    });
    assert.deepEqual(host.calls, ["GET /server"], "operations on a blocked host make no traffic");

    host.server = () => ({ protocolVersion: 1, instanceId: "host_a", capabilities: CAPABILITIES, features: FEATURES });
    await harness.manager.setEnabled("host_a", false);
    await harness.manager.setEnabled("host_a", true);
    await settle();
    assert.equal(harness.status("host_a").state.kind, "connected");
    assert.equal(harness.status("host_b").state.kind, "blocked");
  } finally {
    harness.close();
  }
});

test("reconnects back off 3, 4, 8, 16 and 30 seconds and reset after 30 seconds connected", async () => {
  const host = new FakeHost("host_a", "Plans");
  host.server = () => {
    throw new PeerTransportError("unavailable");
  };
  const harness = setup([host]);
  try {
    await harness.manager.whenReady();
    await settle();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const state = harness.status("host_a").state;
      assert.equal(state.kind, "backoff");
      const delay = (state as { retryAt: number }).retryAt - harness.timers.now;
      delays.push(delay);
      await harness.advance(delay - 1);
      assert.equal(harness.status("host_a").state.kind, "backoff", "no attempt before the delay");
      await harness.advance(1);
    }
    assert.deepEqual(delays, [...PEER_BACKOFF_STEPS_MS, 30_000]);
    assert.equal(host.calls.length, 7);

    host.server = () => ({ protocolVersion: 1, instanceId: "host_a", capabilities: CAPABILITIES, features: FEATURES });
    await harness.advance(30_000);
    assert.equal(harness.status("host_a").state.kind, "connected");

    // A drop inside the stable window keeps the long delay...
    host.streams("/host/events")[0]!.drop();
    await settle();
    let state = harness.status("host_a").state as { kind: string; retryAt: number };
    assert.equal(state.kind, "backoff");
    assert.equal(state.retryAt - harness.timers.now, 30_000);
    await harness.advance(30_000);
    assert.equal(harness.status("host_a").state.kind, "connected");

    // ...while one after 30 seconds connected starts the schedule again.
    await harness.advance(PEER_STABLE_MS);
    host.streams("/host/events")[0]!.drop();
    await settle();
    state = harness.status("host_a").state as { kind: string; retryAt: number };
    assert.equal(state.retryAt - harness.timers.now, PEER_BACKOFF_STEPS_MS[0]);
  } finally {
    harness.close();
  }
  // Jitter stays within a fifth of the step either way.
  assert.equal(peerBackoffDelay(1, () => 0), 2_400);
  assert.equal(peerBackoffDelay(1, () => 1), 3_600);
  assert.equal(peerBackoffDelay(9, () => 0.5), 30_000);
});

test("Reconnect restarts a backing-off host at once and leaves a blocked host alone", async () => {
  const offline = new FakeHost("host_a", "Plans");
  const blocked = new FakeHost("host_b", "Other");
  offline.server = () => {
    throw new PeerTransportError("unavailable");
  };
  blocked.server = () => {
    throw new PeerTransportError("identity_changed");
  };
  const harness = setup([offline, blocked]);
  try {
    await harness.manager.whenReady();
    await settle();
    // Two failures stretch the schedule beyond its first step.
    let state = harness.status("host_a").state as { kind: string; retryAt: number };
    await harness.advance(state.retryAt - harness.timers.now);
    state = harness.status("host_a").state as { kind: string; retryAt: number };
    assert.equal(state.kind, "backoff");
    assert.equal(offline.calls.length, 2);

    offline.server = () => ({ protocolVersion: 1, instanceId: "host_a", capabilities: CAPABILITIES, features: FEATURES });
    harness.manager.reconnect("host_a");
    await settle();
    assert.equal(offline.calls.filter((call) => call === "GET /server").length, 3, "no wait for the backoff");
    assert.equal(harness.status("host_a").state.kind, "connected");

    harness.manager.reconnect("host_b");
    harness.manager.reconnect("host_unknown");
    await harness.advance(10 * 60_000);
    assert.deepEqual(blocked.calls, ["GET /server"], "a blocked host is never retried");
    assert.deepEqual(harness.status("host_b").state, { kind: "blocked", reason: "identity_changed" });

    // A connected host is not torn down by a stray reconnect.
    const generation = harness.status("host_a").generation;
    harness.manager.reconnect("host_a");
    await settle();
    assert.equal(harness.status("host_a").generation, generation);

    // Failing again after a manual reconnect starts the schedule from its first step.
    offline.server = () => {
      throw new PeerTransportError("unavailable");
    };
    offline.streams("/host/events")[0]!.drop();
    await settle();
    await harness.advance(PEER_STABLE_MS);
    state = harness.status("host_a").state as { kind: string; retryAt: number };
    assert.equal(state.kind, "backoff");
    harness.manager.reconnect("host_a");
    await settle();
    state = harness.status("host_a").state as { kind: string; retryAt: number };
    assert.equal(state.retryAt - harness.timers.now, PEER_BACKOFF_STEPS_MS[0]);
  } finally {
    harness.close();
  }
});

test("a superseded connection attempt cannot move the host, and generations only increase", async () => {
  const host = new FakeHost("host_a", "Plans");
  let release!: () => void;
  const late = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  host.server = () => {
    const answer = { protocolVersion: 1, instanceId: "host_a", capabilities: CAPABILITIES, features: FEATURES };
    if (!first) return answer;
    first = false;
    return late.then(() => answer);
  };
  const harness = setup([host]);
  try {
    await harness.manager.whenReady();
    await settle();
    assert.equal(harness.status("host_a").state.kind, "connecting");
    harness.manager.wake();
    await harness.advance(PEER_WAKE_COALESCE_MS);
    assert.equal(harness.status("host_a").state.kind, "connected");
    release();
    await settle();
    assert.equal(harness.status("host_a").state.kind, "connected");
    const seen = harness.statuses("host_a");
    assert.equal(seen.some((status) => status.state.kind === "backoff"), false);
    for (let index = 1; index < seen.length; index += 1)
      assert.ok(seen[index]!.generation >= seen[index - 1]!.generation, "generations never go back");
    assert.equal(host.streams("/host/events").length, 1, "only the current connection opened a feed");
  } finally {
    harness.close();
  }
});

test("feed and run streams cross the five-minute cap without gaps or duplicates", async () => {
  const host = new FakeHost("host_a", "Plans");
  host.runs.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  const harness = setup([host]);
  try {
    await harness.manager.whenReady();
    await settle();
    await harness.manager.runSubscribe("host_a", { runId: "run-1" }, 0, "window-1");
    await settle();
    host.runs.publish("run-1", "chat:delta", { delta: "one" });
    await settle();
    const before = last(harness.events("host_a"))!.sequence;

    for (const session of [...host.sessions]) session.cap();
    await settle();
    // Silent resumptions still count as live.
    assert.equal(harness.status("host_a").feed, "live");
    assert.equal(harness.status("host_a").state.kind, "connected");
    host.runs.publish("run-1", "chat:delta", { delta: "two" });
    host.runs.publish("run-1", "chat:done", { chat: { messages: [] } });
    await host.change({ summaries: [summary("chat-1", "Renamed", 9_000)] });
    await settle();

    assert.ok(host.calls.includes(`EVENTS /runs/run-1/events @${before}`), "the run resumed from its cursor");
    const sequences = harness.events("host_a").map((event) => [event.sequence, event.type]);
    const expected = sequences.map((_, index) => index + 1);
    // run.ended repeats the terminal sequence; everything else is consecutive.
    assert.deepEqual(
      sequences.map(([sequence]) => sequence),
      [...expected.slice(0, -1), expected[expected.length - 2]],
    );
    assert.equal(last(sequences)![1], "run.ended");
    const runFrames = harness.frames("host_a");
    assert.equal(streamState(runFrames), "ended");

    const feed = harness.feed("host_a");
    assert.deepEqual(
      feed.filter((message) => message.change.type === "reset").length,
      1,
      "the resumed feed did not resend its snapshot",
    );
    assert.ok(host.calls.some((call) => call.startsWith("EVENTS /host/events @epoch_host_a:")));
    assert.equal(harness.manager.feedSnapshot("host_a")?.summaries[0]?.title, "Renamed");
  } finally {
    harness.close();
  }
});

test("a chat's stream parks after its run, ignores the replay on reconnect and follows the next run", async () => {
  const host = new FakeHost("host_a", "Plans");
  host.runs.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  const harness = setup([host]);
  try {
    await harness.manager.whenReady();
    await settle();
    await harness.manager.runSubscribe("host_a", { chatId: "chat-1" }, 0, "window-1");
    await settle();
    host.runs.publish("run-1", "chat:delta", { delta: "first answer" });
    host.runs.publish("run-1", "chat:done", { chat: { messages: [] } });
    await settle();
    const ended = harness.events("host_a").length;
    assert.equal(last(harness.events("host_a"))?.type, "run.ended");
    assert.equal(streamState(harness.frames("host_a")), "idle");

    // Reconnecting probes the chat again; the host replays the finished run.
    harness.manager.wake();
    await harness.advance(PEER_WAKE_COALESCE_MS);
    assert.equal(host.calls.filter((call) => call === "EVENTS /chats/chat-1/runs/current/events").length, 2);
    assert.equal(harness.events("host_a").length, ended, "nothing already shown is repeated");

    // The feed announces the chat's next run and the stream follows it.
    host.runs.begin({ runId: "run-2", chatId: "chat-1", origin: "renderer" });
    host.runs.publish("run-2", "chat:delta", { delta: "second answer" });
    await host.noteRun("run-2");
    await settle();
    const next = harness.events("host_a").slice(ended);
    assert.ok(next.length > 0);
    assert.deepEqual(new Set(next.map((event) => event.streamId)), new Set(["run-2"]));
    assert.match(JSON.stringify(next), /second answer/);

    // Repeated terminal updates for the run already shown change nothing.
    host.runs.publish("run-2", "chat:done", { chat: { messages: [] } });
    await settle();
    await host.noteRun("run-2");
    await settle();
    assert.equal(streamState(harness.frames("host_a")), "idle");
    const probes = () => host.calls.filter((call) => call === "EVENTS /chats/chat-1/runs/current/events").length;
    const probed = probes();
    const shown = harness.events("host_a").length;

    // A short run can first appear in the feed already finished; it is still followed.
    host.runs.begin({ runId: "run-3", chatId: "chat-1", origin: "renderer" });
    host.runs.publish("run-3", "chat:delta", { delta: "third answer" });
    host.runs.publish("run-3", "chat:done", { chat: { messages: [] } });
    await host.noteRun("run-3");
    await settle();
    assert.equal(probes(), probed + 1);
    const third = harness.events("host_a").slice(shown);
    assert.deepEqual(new Set(third.map((event) => event.streamId)), new Set(["run-3"]));
    assert.match(JSON.stringify(third), /third answer/);
    assert.equal(last(third)?.type, "run.ended");
    assert.equal(streamState(harness.frames("host_a")), "idle");
    assert.equal(host.calls.filter((call) => call === "GET /server").length, 2, "no reconnect was needed");
  } finally {
    harness.close();
  }
});

test("windows share one live stream that closes five minutes after its last viewer leaves", async () => {
  const host = new FakeHost("host_a", "Plans");
  host.runs.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  const harness = setup([host]);
  try {
    await harness.manager.whenReady();
    await settle();
    const first = await harness.manager.runSubscribe("host_a", { runId: "run-1" }, 0, "window-1");
    const second = await harness.manager.runSubscribe("host_a", { runId: "run-1" }, 0, "window-2");
    await settle();
    assert.equal(first.key, second.key);
    assert.equal(host.streams("/runs/").length, 1);
    assert.equal(harness.manager.runUnsubscribe(first.subscriptionId, "window-2"), false, "only its owner releases it");
    assert.equal(harness.manager.runUnsubscribe(first.subscriptionId, "window-1"), true);
    harness.manager.releaseOwner("window-2");

    await harness.advance(PEER_RUN_EVICT_MS - 1);
    assert.equal(host.streams("/runs/").length, 1, "a returning viewer can still rejoin");
    await harness.advance(1);
    assert.equal(host.streams("/runs/").length, 0);

    // A late viewer reopens and replays from the host.
    const again = await harness.manager.runSubscribe("host_a", { runId: "run-1" }, 0, "window-1");
    await settle();
    assert.equal(host.streams("/runs/").length, 1);
    assert.equal(host.calls.filter((call) => call.startsWith("EVENTS /runs/run-1/events")).length, 2);
    assert.equal(again.events.length, 0, "a fresh stream starts empty and fills by broadcast");
  } finally {
    harness.close();
  }
});

test("a disabled host makes no requests at all", async () => {
  const active = new FakeHost("host_a", "Plans");
  const idle = new FakeHost("host_b", "Other");
  active.runs.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  const harness = setup([active, idle], [stored("host_a"), stored("host_b", false)]);
  try {
    await harness.manager.whenReady();
    await settle();
    await assert.rejects(harness.manager.runSubscribe("host_b", { runId: "run-1" }, 0, "window-1"), /disabled/);
    const outcome = await harness.manager.call("host_b", { operation: "summaries" });
    assert.equal(outcome.ok, false);
    harness.manager.wake();
    await harness.advance(10 * 60_000);
    assert.deepEqual(idle.calls, []);
    assert.equal(harness.status("host_b").state.kind, "disabled");

    await harness.manager.runSubscribe("host_a", { runId: "run-1" }, 0, "window-1");
    await settle();
    assert.equal(active.sessions.size, 2);
    await harness.manager.setEnabled("host_a", false);
    await settle();
    const after = active.calls.length;
    harness.manager.wake();
    await harness.advance(10 * 60_000);
    assert.equal(active.calls.length, after);
    assert.equal(active.sessions.size, 0);
    assert.equal(harness.status("host_a").state.kind, "disabled");
    assert.equal(last(harness.statuses("host_a"))?.state.kind, "disabled");
    assert.equal(streamState(harness.frames("host_a")), "gone");
    assert.equal(harness.manager.feedSnapshot("host_a"), null, "a disabled host keeps no rows");
  } finally {
    harness.close();
  }
});

test("sleep, unlock and network changes coalesce into one reconnect that resumes the feed", async () => {
  const host = new FakeHost("host_a", "Plans");
  const harness = setup([host]);
  try {
    await harness.manager.whenReady();
    await settle();
    const resets = () => harness.feed("host_a").filter((message) => message.change.type === "reset").length;
    assert.equal(resets(), 1);
    harness.manager.wake();
    await harness.advance(100);
    harness.manager.wake();
    harness.manager.wake();
    await harness.advance(PEER_WAKE_COALESCE_MS);
    assert.deepEqual(host.calls.filter((call) => call === "GET /server").length, 2);
    assert.equal(host.calls.filter((call) => call.startsWith("EVENTS /host/events @")).length, 1);
    assert.equal(resets(), 1);
    assert.deepEqual(
      harness.feed("host_a").flatMap((message) => (message.change.type === "stale" ? [message.change.stale] : [])),
      [true, false],
      "rows were marked stale while reconnecting",
    );
  } finally {
    harness.close();
  }
  assert.equal(
    peerNetworkFingerprint({ en0: [{ address: "10.0.0.2", internal: false }], lo0: [{ address: "127.0.0.1", internal: true }] }),
    peerNetworkFingerprint({ lo0: [], en0: [{ address: "10.0.0.2", internal: false }] }),
  );
  assert.notEqual(
    peerNetworkFingerprint({ en0: [{ address: "10.0.0.2", internal: false }] }),
    peerNetworkFingerprint({ en0: [{ address: "10.0.0.3", internal: false }] }),
  );
});

test("an ambiguous mutation is reconciled with one read and never replayed", async () => {
  const host = new FakeHost("host_a", "Plans");
  host.runs.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  const harness = setup([host]);
  try {
    await harness.manager.whenReady();
    await settle();
    await host.noteRun("run-1");
    await settle();
    host.json = async (input) => {
      if (input.method === "GET") throw new PeerTransportError("request_failed", 404, { code: "chat_not_found", retryable: false });
      throw new PeerTransportError("unavailable");
    };
    const cancel = await harness.manager.call("host_a", {
      operation: "runCancel",
      resourceId: "run-1",
      idempotencyKey: "key-cancel-000000001",
      body: {},
    });
    assert.equal(cancel.ok, false);
    assert.equal(!cancel.ok && cancel.error.code, "outcome_unknown");
    assert.deepEqual(!cancel.ok && cancel.error.reconciled, {
      run: harness.manager.feedSnapshot("host_a")!.runs.find((run) => run.runId === "run-1"),
    });
    assert.deepEqual(host.traffic().filter((call) => !call.startsWith("EVENTS")), ["POST /runs/run-1/cancel"]);

    const rename = await harness.manager.call("host_a", {
      operation: "renameChat",
      resourceId: "chat-1",
      revision: "rev_1",
      body: { title: "New" },
    });
    assert.deepEqual(!rename.ok && rename.error.reconciled, { chat: null }, "the chat no longer exists");
    assert.deepEqual(host.traffic().filter((call) => !call.startsWith("EVENTS")), [
      "POST /runs/run-1/cancel",
      "PATCH /chats/chat-1",
      "GET /chats/chat-1",
    ]);

    // A failed read is just an error: reads are not reconciled.
    const read = await harness.manager.call("host_a", { operation: "chat", resourceId: "chat-1" });
    assert.equal(!read.ok && read.error.code, "request_failed");
    assert.equal(!read.ok && read.error.status, 404);
    const invalid = await harness.manager.call("host_a", { operation: "send", resourceId: "../x" });
    assert.equal(!invalid.ok && invalid.error.code, "invalid_request");
    assert.equal(harness.status("host_a").state.kind, "connected", "a failed operation does not drop the host");
  } finally {
    harness.close();
  }
});

test("a newer run announced while the previous stream is still closing is followed", async () => {
  const host = new FakeHost("host_a", "Plans");
  host.runs.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  const harness = setup([host]);
  try {
    await harness.manager.whenReady();
    await settle();
    await harness.manager.runSubscribe("host_a", { chatId: "chat-1" }, 0, "window-1");
    await settle();
    let release!: () => void;
    host.endGate = (path) =>
      path === "/chats/chat-1/runs/current/events"
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined;
    host.runs.publish("run-1", "chat:done", { chat: { messages: [] } });
    await settle();
    assert.equal(last(harness.events("host_a"))?.type, "run.ended");

    // Run 2 is announced after run 1's terminal frame, before its request settles.
    host.endGate = undefined;
    host.runs.begin({ runId: "run-2", chatId: "chat-1", origin: "renderer" });
    host.runs.publish("run-2", "chat:delta", { delta: "second answer" });
    await host.noteRun("run-2");
    await settle();
    release();
    await settle();

    const next = harness.events("host_a").filter((event) => event.streamId === "run-2");
    assert.match(JSON.stringify(next), /second answer/);
    assert.equal(streamState(harness.frames("host_a")), "streaming");
  } finally {
    harness.close();
  }
});

test("a request admitted by a superseded connection cannot block the reconnected host", async () => {
  const host = new FakeHost("host_a", "Plans");
  const harness = setup([host]);
  try {
    await harness.manager.whenReady();
    await settle();
    let reject!: (error: unknown) => void;
    host.json = () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      });
    const held = harness.manager.call("host_a", { operation: "summaries" });
    await settle();

    harness.manager.wake();
    await harness.advance(PEER_WAKE_COALESCE_MS);
    const reconnected = harness.status("host_a");
    assert.equal(reconnected.state.kind, "connected");

    reject(new PeerTransportError("authentication_required", 401));
    const outcome = await held;
    assert.equal(!outcome.ok && outcome.error.code, "authentication_required", "the caller still learns why");
    await harness.advance(60_000);
    assert.equal(harness.status("host_a").state.kind, "connected");
    assert.equal(harness.status("host_a").generation, reconnected.generation);

    // The same failure on the current connection does block it.
    host.json = async () => {
      throw new PeerTransportError("authentication_required", 401);
    };
    await harness.manager.call("host_a", { operation: "summaries" });
    assert.deepEqual(harness.status("host_a").state, { kind: "blocked", reason: "auth" });
  } finally {
    harness.close();
  }
});
