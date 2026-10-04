import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { registerPeerHostLiveHandlers, type PeerHostLiveOwner } from "../handlers/peer-host-live.js";
import { AidenRemoteHostFeedService, type AidenRemoteHostFeedState } from "./aiden-remote-host-feed.js";
import { AidenRemoteHostRunService } from "./aiden-remote-host-runs.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AidenRemoteCapability } from "./aiden-remote-protocol.js";
import {
  projectAidenRemoteChatMessagesWindow,
  type AidenRemoteChatSummaryProjection,
} from "./aiden-remote-chats.js";
import { HostRunRegistry } from "./host-run-registry.js";
import { PeerHostRegistry, type PeerClient, type StoredPeerHost } from "./peer-host-registry.js";
import {
  PEER_HOST_STATE_CHANNEL,
  PEER_RUN_FRAME_CHANNEL,
  PEER_WAKE_COALESCE_MS,
  PeerHostManager,
} from "./peer-host-manager.js";
import { PeerEventFrames, PeerTransportError, type PeerRequest, type PeerStreamEnd } from "./peer-transport.js";
import type { PeerHostStatus, PeerRunFrameMessage } from "../../renderer/shared/peer-host.js";
import type { Chat, ChatMessage } from "../../renderer/lib/types.js";
import { RemoteHostAdapter, type PeerHostTransport } from "../../renderer/lib/hosts/remote-host-adapter.js";
import { RemoteChatSession } from "../../renderer/lib/hosts/remote-chat-session.js";
import { remoteRunTranscript } from "../../renderer/lib/hosts/remote-stream-translator.js";

/**
 * The remote chat view's data path end to end: the renderer's adapter and
 * session over main's real live IPC handlers and host supervisor, against a
 * host built from the real run journal, run streams, feed and transcript
 * projection. Only the network and Electron's IPC are stand-ins.
 */

const CAPABILITIES = ["chat:read", "chat:write", "host:events", "runs:observe", "runs:control"];
const FEATURES = [
  "host-events-v1",
  "run-streams-v1",
  "run-control-v1",
  "chat-messages-window-v1",
  "chat-read-state-v1",
];
const CREDENTIAL = "c".repeat(43);
const ENDPOINT = "https://server.example/api/aiden/v1";

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

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

function numbered(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message ${index}`,
    createdAt: 1_000 + index,
  }));
}

/**
 * A paired host built from the real host-side services. Its chat is served
 * through the real messages-window projection, and read markers are recorded.
 */
class FakeHost {
  readonly calls: string[] = [];
  readonly reads: unknown[] = [];
  readonly runs: HostRunRegistry;
  readonly service: AidenRemoteHostRunService;
  readonly feed: AidenRemoteHostFeedService;
  chat: Chat;
  /** Holds a messages-window answer until the returned promise settles. */
  windowGate: (() => Promise<void> | undefined) | undefined;
  private readonly device = {
    id: "desktop",
    capabilities: new Set<AidenRemoteCapability>(CAPABILITIES as AidenRemoteCapability[]),
  };

  constructor(readonly id: string, messages: ChatMessage[], maxEventsPerRun?: number) {
    const now = () => 5_000;
    this.chat = { id: "chat-1", title: "Release notes", createdAt: 1, updatedAt: 2, workspaceId: "ws", messages };
    // Every delta stays its own journal event, so a long reply can outgrow the
    // journal the way a real token stream does under this frozen clock.
    this.runs = new HostRunRegistry({ now, epoch: `runs_${id}`, maxEventsPerRun, deltaCoalesceMs: 0 });
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
    const summary = {
      id: "chat-1",
      workspaceId: "ws",
      title: "Release notes",
      titlePending: false,
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(2_000).toISOString(),
      revision: "rev_chat-1",
      activity: "idle",
    } as AidenRemoteChatSummaryProjection;
    const state = {
      summaries: [summary],
      botChatIds: new Set(),
      workspaces: [],
      bots: [],
    } as unknown as AidenRemoteHostFeedState;
    this.feed = new AidenRemoteHostFeedService({
      source: { read: async () => state },
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
        if (input.path === "/server")
          return { protocolVersion: 1, instanceId: this.id, capabilities: CAPABILITIES, features: FEATURES };
        if (input.path === "/device/capabilities") return { capabilities: CAPABILITIES };
        try {
          return await this.answer(input);
        } catch (error) {
          throw peerError(error);
        }
      },
      events: (input, onFrame) => this.events(input, onFrame),
    };
  }

  /** Persists a turn the way the host does before announcing `done`. */
  append(...messages: ChatMessage[]): void {
    this.chat = { ...this.chat, messages: [...this.chat.messages, ...messages], updatedAt: this.chat.updatedAt + 1 };
  }

  async start(runId: string): Promise<void> {
    this.runs.begin({ runId, chatId: "chat-1", origin: "renderer" });
    this.feed.noteRun(this.runs.summary(runId)!, false);
    await this.feed.refresh();
  }

  windowReads(): string[] {
    return this.calls.filter((call) => call.startsWith("GET /chats/chat-1/messages"));
  }

  close(): void {
    this.feed.close();
    this.service.revokeDevice("desktop");
  }

  private async answer(input: PeerRequest): Promise<unknown> {
    const url = new URL(input.path, "https://host.invalid");
    if (url.pathname === "/chats/chat-1/messages") {
      // Projected now, answered after the gate: a read that crosses a reconnect.
      const before = url.searchParams.get("before") ?? undefined;
      const window = projectAidenRemoteChatMessagesWindow(this.chat, {
        ...(before ? { before } : {}),
        limit: Number(url.searchParams.get("limit")),
      });
      await this.windowGate?.();
      return JSON.parse(JSON.stringify(window));
    }
    if (url.pathname === "/chats/chat-1/read" && input.method === "POST") {
      this.reads.push(input.body);
      return undefined; // 204
    }
    throw new AidenRemoteServiceError("run_gone", "Not found.", 404);
  }

  private events(input: PeerRequest, onFrame: (frame: string) => void): Promise<PeerStreamEnd> {
    this.calls.push(`EVENTS ${input.path}`);
    return new Promise<PeerStreamEnd>((resolve, reject) => {
      const reader = new PeerEventFrames();
      const pending: string[] = [];
      let opened = false;
      let endPending = false;
      let done = false;
      const finish = (settleWith: () => void) => {
        if (done) return;
        done = true;
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
          if (!opened) endPending = true;
          else finish(() => resolve({ reason: "eof" }));
        },
        destroy: () => finish(() => reject(new PeerTransportError("unavailable"))),
      });
      const onAbort = () => {
        finish(() => reject(new PeerTransportError("unavailable")));
        wire.destroy();
      };
      if (input.signal?.aborted) return onAbort();
      input.signal?.addEventListener("abort", onAbort, { once: true });
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
    if (input.path === "/host/events") {
      await this.feed.open(this.device, input.lastEventId, wire);
      return;
    }
    const run = /^\/runs\/([^/]+)\/events$/u.exec(input.path);
    if (run) {
      this.service.openRunEvents(this.device, decodeURIComponent(run[1]!), Number(input.lastEventId ?? 0), wire);
      return;
    }
    const chat = /^\/chats\/([^/]+)\/runs\/current\/events$/u.exec(input.path);
    if (chat) {
      const runId = this.service.currentRunId(decodeURIComponent(chat[1]!));
      this.service.openRunEvents(this.device, runId, 0, wire);
      return;
    }
    throw new AidenRemoteServiceError("run_gone", "Not found.", 404);
  }
}

/** One renderer document; the live handlers key subscriptions by it. */
class FakeDocument implements PeerHostLiveOwner {
  readonly key = "window-1";
  isDestroyed(): boolean {
    return false;
  }
  onInvalidated(): () => void {
    return () => {};
  }
}

async function setup(host: FakeHost) {
  const timers = new FakeTimers();
  let saved: StoredPeerHost[] = [
    {
      id: host.id,
      name: "Studio",
      endpoint: ENDPOINT,
      serverSpkiSha256: `sha256/${Buffer.alloc(32, 7).toString("base64")}`,
      deviceId: `device_${host.id}`,
      credential: CREDENTIAL,
      enabled: true,
      capabilities: CAPABILITIES,
      features: FEATURES,
    },
  ];
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
    client: () => host.client(),
  });

  // Electron's IPC: notifications are serialized and delivered asynchronously.
  const frameListeners = new Set<(message: PeerRunFrameMessage) => void>();
  const stateListeners = new Set<(status: PeerHostStatus) => void>();
  const delivered: unknown[] = [];
  const manager = new PeerHostManager({
    registry,
    broadcast: (channel, payload) => {
      const copy = structuredClone(payload);
      delivered.push(copy);
      queueMicrotask(() => {
        if (channel === PEER_RUN_FRAME_CHANNEL)
          for (const listener of [...frameListeners]) listener(copy as PeerRunFrameMessage);
        if (channel === PEER_HOST_STATE_CHANNEL)
          for (const listener of [...stateListeners]) listener(copy as PeerHostStatus);
      });
    },
    now: () => timers.now,
    random: () => 0.5,
    timers,
  });
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const document = new FakeDocument();
  registerPeerHostLiveHandlers<unknown>({
    handle: (channel, handler) => handlers.set(channel, handler),
    owner: () => document,
    manager: () => manager,
  });
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> =>
    structuredClone((await handlers.get(channel)!({}, ...structuredClone(args))) as T);
  const transport: PeerHostTransport = {
    call: (hostId, operation) => invoke("remote:peerCall", hostId, operation),
    statuses: () => invoke("remote:peerHostStatuses"),
    runSubscribe: (hostId, target, afterSequence = 0) =>
      invoke("remote:peerRunSubscribe", hostId, target, afterSequence),
    runUnsubscribe: (subscriptionId) => invoke("remote:peerRunUnsubscribe", subscriptionId),
    onRunFrame: (listener) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    onHostState: (listener) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
  };
  await manager.whenReady();
  await settle();
  const [view] = await registry.list();
  const adapter = new RemoteHostAdapter(view!, transport);
  const session = new RemoteChatSession({ adapter, chatId: "chat-1" });
  const open = async () => {
    session.start();
    await settle();
    await session.idle();
  };
  const transcript = () => {
    const snapshot = session.getSnapshot();
    return { ...snapshot, row: remoteRunTranscript(snapshot.run, snapshot.transcript.messages) };
  };
  /** A second window opening the same chat over the same main process. */
  const openAnother = async () => {
    const other = new RemoteHostAdapter(view!, transport);
    const otherSession = new RemoteChatSession({ adapter: other, chatId: "chat-1" });
    otherSession.start();
    await settle();
    await otherSession.idle();
    const read = () => otherSession.getSnapshot();
    const dispose = () => {
      otherSession.dispose();
      other.dispose();
    };
    return { session: otherSession, read, dispose };
  };
  const close = () => {
    session.dispose();
    adapter.dispose();
    manager.close();
    host.close();
  };
  return { timers, manager, adapter, session, open, openAnother, transcript, delivered, close };
}

test("a run started on the host streams into the open chat and hands off to the persisted reply", async () => {
  const host = new FakeHost("host_b", numbered(4));
  const harness = await setup(host);
  try {
    await harness.open();
    let view = harness.transcript();
    assert.equal(view.status.availability, "online");
    assert.equal(view.stale, false);
    assert.deepEqual(view.transcript.messages.map((message) => message.id), ["m0", "m1", "m2", "m3"]);
    assert.equal(view.row.streamingText, null, "nothing is running yet");
    assert.deepEqual(host.reads, [{ throughMessageId: "m3" }], "opening the chat marks it read on the host");

    // Someone types on the host itself; this Mac only watches.
    host.append({ id: "u4", role: "user", content: "Summarize the release", createdAt: 2_000 });
    await host.start("run-1");
    await settle();
    host.runs.publish("run-1", "chat:reasoning-delta", { delta: "Reading the changelog" });
    host.runs.publish("run-1", "chat:tool", { toolName: "read_file", phase: "call" });
    host.runs.publish("run-1", "chat:approval", {
      approvalId: "ap-1",
      summary: "Run the release script",
      toolCallId: "call-1",
      toolName: "shell",
    });
    await settle();
    await harness.session.idle();
    view = harness.transcript();
    assert.equal(last(view.transcript.messages)?.id, "u4", "the host's user turn is read in when the run starts");
    assert.equal(view.row.streamingReasoning, "Reading the changelog");
    assert.deepEqual(
      view.run.approvals.map((prompt) => [prompt.approvalId, prompt.summary, prompt.canAllow]),
      [["ap-1", "Run the release script", false]],
      "the approval is shown, but this Mac cannot answer it",
    );

    host.runs.publish("run-1", "chat:tool", { toolName: "read_file", phase: "result" });
    host.runs.publish("run-1", "chat:delta", { delta: "Three fixes " });
    host.runs.publish("run-1", "chat:delta", { delta: "shipped." });
    await settle();
    await harness.session.idle();
    view = harness.transcript();
    assert.equal(view.row.streamingText, "Three fixes shipped.");
    assert.equal(view.row.streamComplete, false);

    host.append({ id: "a5", role: "assistant", content: "Three fixes shipped.", createdAt: 3_000 });
    host.runs.publish("run-1", "chat:done", { chat: { messages: [{ id: "a5", role: "assistant" }] } });
    await settle();
    await harness.session.idle();
    view = harness.transcript();
    assert.equal(view.run.status, "done");
    assert.equal(last(view.transcript.messages)?.content, "Three fixes shipped.");
    assert.equal(view.row.streamingText, null, "the persisted reply replaces the streamed row");
    assert.equal(view.row.agentActivity, null);
    assert.deepEqual(last(host.reads), { throughMessageId: "a5" });

    // Nothing that reached the renderer carries the pairing secret or the address.
    const everything = JSON.stringify(harness.delivered);
    assert.equal(everything.includes(CREDENTIAL), false);
    assert.equal(everything.includes("server.example"), false);
  } finally {
    harness.close();
  }
});

test("opening a chat whose run outgrew the host's journal recovers through the gap snapshot", async () => {
  const host = new FakeHost("host_b", numbered(2), 6);
  host.append({ id: "u2", role: "user", content: "Write the migration", createdAt: 2_000 });
  host.runs.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  host.runs.publish("run-1", "chat:approval", {
    approvalId: "ap-1",
    summary: "Edit schema.sql",
    toolCallId: "call-1",
    toolName: "write_file",
  });
  for (let index = 0; index < 20; index += 1) host.runs.publish("run-1", "chat:delta", { delta: `part ${index} ` });
  const harness = await setup(host);
  try {
    await harness.open();
    let view = harness.transcript();
    assert.deepEqual(view.transcript.messages.map((message) => message.id), ["m0", "m1", "u2"]);
    assert.equal(view.run.incomplete, true, "the start of the reply is gone from the host's journal");
    assert.equal(view.row.streamingText, "", "a reply missing its start is not shown mid-sentence");
    assert.notEqual(view.row.agentActivity, null, "the run still reads as active");
    assert.deepEqual(
      view.run.approvals.map((prompt) => prompt.approvalId),
      ["ap-1"],
      "the snapshot reseeds the pending approval whose event was trimmed",
    );

    host.runs.publish("run-1", "chat:delta", { delta: "tail" });
    host.append({ id: "a3", role: "assistant", content: "Migration written.", createdAt: 3_000 });
    host.runs.publish("run-1", "chat:done", { chat: { messages: [{ id: "a3", role: "assistant" }] } });
    await settle();
    await harness.session.idle();
    view = harness.transcript();
    assert.equal(last(view.transcript.messages)?.content, "Migration written.");
    assert.equal(view.row.streamingText, null);
    assert.equal(view.error, null);
  } finally {
    harness.close();
  }
});

test("a window joining a run whose shared buffer overflowed still shows the pending approval until it resolves", async () => {
  const host = new FakeHost("host_b", numbered(2));
  const harness = await setup(host);
  let another: Awaited<ReturnType<typeof harness.openAnother>> | undefined;
  try {
    await harness.open();
    await host.start("run-1");
    await settle();
    host.runs.publish("run-1", "chat:approval", {
      approvalId: "ap-1",
      summary: "Run the release script",
      toolCallId: "call-1",
      toolName: "shell",
    });
    // A long reply streams past the approval, well beyond this Mac's shared buffer.
    for (let index = 0; index < 600; index += 1) host.runs.publish("run-1", "chat:delta", { delta: "x" });
    await settle();
    await harness.session.idle();
    assert.deepEqual(harness.transcript().run.approvals.map((prompt) => prompt.approvalId), ["ap-1"]);

    another = await harness.openAnother();
    let joined = another.read();
    assert.equal(joined.run.incomplete, true, "the reply's start is no longer buffered on this Mac");
    assert.deepEqual(
      joined.run.approvals.map((prompt) => [prompt.approvalId, prompt.canAllow]),
      [["ap-1", false]],
      "the approval the buffer dropped is still shown, read-only",
    );

    host.runs.resolveAttention("ap-1");
    await settle();
    await another.session.idle();
    await harness.session.idle();
    joined = another.read();
    assert.deepEqual(joined.run.approvals, [], "answered on the host, the prompt leaves the joining window");
    assert.deepEqual(harness.transcript().run.approvals, []);
  } finally {
    another?.dispose();
    harness.close();
  }
});

test("a reply the host announces without its message id hands off once the newest window is read", async () => {
  const host = new FakeHost("host_b", numbered(2));
  const harness = await setup(host);
  try {
    await harness.open();
    host.append({ id: "u2", role: "user", content: "Name the release", createdAt: 2_000 });
    await host.start("run-1");
    await settle();
    host.runs.publish("run-1", "chat:delta", { delta: "Call it Juniper." });
    await settle();
    await harness.session.idle();
    assert.equal(harness.transcript().row.streamingText, "Call it Juniper.");

    // The host persists the reply but its done payload omits the chat, so the
    // run stream names a synthetic message id.
    host.append({ id: "a3", role: "assistant", content: "Call it Juniper.", createdAt: 3_000 });
    host.runs.publish("run-1", "chat:done", {});
    await settle();
    await harness.session.idle();
    const view = harness.transcript();
    assert.equal(view.run.status, "done");
    assert.equal(last(view.transcript.messages)?.id, "a3");
    assert.equal(view.row.streamingText, null, "the reply is not shown twice");
    assert.equal(view.row.streamComplete, false);
  } finally {
    harness.close();
  }
});

test("a large chat opens on its newest page and pages back to the start", async () => {
  const host = new FakeHost("host_b", numbered(500));
  const harness = await setup(host);
  try {
    await harness.open();
    let view = harness.transcript();
    assert.equal(view.transcript.messages.length, 50);
    assert.equal(view.transcript.messages[0]?.id, "m450");
    assert.equal(view.transcript.hasOlder, true);
    assert.equal(host.windowReads().length, 1, "opening reads one page, not the whole chat");

    for (let page = 0; page < 9; page += 1) await harness.session.loadOlder();
    view = harness.transcript();
    assert.equal(view.transcript.messages.length, 500);
    assert.deepEqual(
      view.transcript.messages.map((message) => message.id),
      numbered(500).map((message) => message.id),
      "every page lands once, in order",
    );
    assert.equal(view.transcript.hasOlder, false);
    await harness.session.loadOlder();
    assert.equal(host.windowReads().length, 10, "nothing is read past the start");
  } finally {
    harness.close();
  }
});

test("a page read across a reconnect is dropped and the newest page is read again", async () => {
  const host = new FakeHost("host_b", numbered(120));
  const harness = await setup(host);
  try {
    await harness.open();
    const before = harness.transcript();
    const generation = before.status.generation;
    assert.equal(before.transcript.messages[0]?.id, "m70");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.windowGate = () => gate;
    const older = harness.session.loadOlder();
    await settle();
    assert.equal(harness.transcript().loadingOlder, true);

    // The Mac wakes from sleep and the host connection is re-established.
    harness.manager.wake();
    harness.timers.advance(PEER_WAKE_COALESCE_MS);
    await settle();
    host.windowGate = undefined;
    release();
    await older;
    await settle();
    await harness.session.idle();

    const after = harness.transcript();
    assert.ok(after.status.generation > generation);
    assert.equal(after.status.availability, "online");
    assert.equal(after.transcript.messages[0]?.id, "m70", "the superseded page was not merged");
    assert.equal(after.transcript.messages.length, 50);
    assert.equal(after.loadingOlder, false);
    assert.equal(after.error, null);
    assert.ok(host.windowReads().length >= 3, "the newest page was read again under the new connection");
  } finally {
    harness.close();
  }
});
