import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { registerPeerHostLiveHandlers, type PeerHostLiveOwner } from "../handlers/peer-host-live.js";
import { AidenRemoteHostFeedService, type AidenRemoteHostFeedState } from "./aiden-remote-host-feed.js";
import { AidenRemoteHostRunService, type AidenRemoteHostRunControls } from "./aiden-remote-host-runs.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { AidenIdempotencyLedger } from "./aiden-remote-operation-contract.js";
import type { AidenRemoteCapability } from "./aiden-remote-protocol.js";
import {
  projectAidenRemoteChat,
  projectAidenRemoteChatMessagesWindow,
  type AidenRemoteChatSummaryProjection,
} from "./aiden-remote-chats.js";
import { HostRunRegistry } from "./host-run-registry.js";
import { PeerHostRegistry, type PeerClient, type StoredPeerHost } from "./peer-host-registry.js";
import { PEER_HOST_STATE_CHANNEL, PEER_RUN_FRAME_CHANNEL, PeerHostManager } from "./peer-host-manager.js";
import { PeerEventFrames, PeerTransportError, parsePeerErrorEnvelope, type PeerRequest, type PeerStreamEnd } from "./peer-transport.js";
import type { PeerHostStatus, PeerRunFrameMessage } from "../../renderer/shared/peer-host.js";
import type { Chat, ChatMessage } from "../../renderer/lib/types.js";
import { RemoteHostAdapter, type PeerHostTransport } from "../../renderer/lib/hosts/remote-host-adapter.js";
import { RemoteChatSession } from "../../renderer/lib/hosts/remote-chat-session.js";
import { remoteRunTranscript } from "../../renderer/lib/hosts/remote-stream-translator.js";

/**
 * Test host for the remote chat suites: the renderer's adapter and session
 * over main's real live IPC handlers and host supervisor, against a host
 * built from the real run journal, run streams and controls, feed, transcript
 * projection and idempotency ledger. Only the network, Electron's IPC and the
 * generation itself are stand-ins.
 */

export const CAPABILITIES = ["chat:read", "chat:write", "host:events", "runs:observe", "runs:control"];
export const FEATURES = [
  "host-events-v1",
  "run-streams-v1",
  "run-control-v1",
  "chat-messages-window-v1",
  "chat-read-state-v1",
];
export const CREDENTIAL = "c".repeat(43);
const ENDPOINT = "https://server.example/api/aiden/v1";

/** What a suite's extra route returns for a request it does not answer. */
export const UNHANDLED: unique symbol = Symbol("unhandled");
export type FakeHostRoute = (input: PeerRequest, deviceId: string) => Promise<unknown>;

export class FakeTimers {
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
export async function settle(): Promise<void> {
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
    // The error envelope crosses the wire and is read back by the real parser.
    const envelope = { error: { code: error.code, retryable: error.retryable, details: error.details } };
    return new PeerTransportError("request_failed", error.status, parsePeerErrorEnvelope(JSON.stringify(envelope)));
  }
  return new PeerTransportError("unavailable");
}

export function numbered(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message ${index}`,
    createdAt: 1_000 + index,
  }));
}

/** Host effects of the run controls, recorded once each time they apply. */
export interface FakeHostEffects {
  cancels: string[];
  approvals: string[];
  answers: string[];
  inputs: string[];
}

/**
 * Host-authority controls that behave like the production ones: the first
 * settlement wins and later ones report false. A cancel ends the run the way a
 * stopped generation does.
 */
export function hostControls(runs: HostRunRegistry, effects: FakeHostEffects): AidenRemoteHostRunControls {
  return {
    cancel(runId) {
      const summary = runs.summary(runId);
      if (!summary || summary.state === "done" || summary.state === "failed" || summary.state === "cancelled") return false;
      effects.cancels.push(runId);
      runs.publish(runId, "chat:done", { cancelled: true });
      return true;
    },
    approve({ approvalId, decision }) {
      if (!runs.pendingPrompt(approvalId)) return false;
      effects.approvals.push(`${approvalId}:${decision}`);
      runs.resolveAttention(approvalId, { kind: "approval", decision });
      return true;
    },
    answer({ promptId, response }) {
      if (!runs.pendingPrompt(promptId)) return "rejected";
      effects.answers.push(`${promptId}:${JSON.stringify(response)}`);
      runs.resolveAttention(promptId, { kind: "question", outcome: "answered" });
      return "answered";
    },
    async admitInput({ streamId, mode, text }) {
      const summary = runs.summary(streamId);
      if (!summary || summary.state === "done" || summary.state === "failed" || summary.state === "cancelled")
        return { admitted: false, reason: "run_not_active", committed: false };
      effects.inputs.push(`${streamId}:${mode}:${text}`);
      return { admitted: true, queue: mode === "steer" ? "steer" : "follow-up", committed: true, messageId: `input-${effects.inputs.length}` };
    },
  };
}

type Device = { id: string; capabilities: ReadonlySet<AidenRemoteCapability> };

/**
 * A paired host built from the real host-side services. Its chat is served
 * through the real messages-window projection, read markers are recorded,
 * turns are keyed through the real idempotency ledger, and run controls go
 * through the real host run service.
 */
export class FakeHost {
  readonly calls: string[] = [];
  readonly reads: unknown[] = [];
  readonly runs: HostRunRegistry;
  readonly service: AidenRemoteHostRunService;
  readonly feed: AidenRemoteHostFeedService;
  readonly effects: FakeHostEffects = { cancels: [], approvals: [], answers: [], inputs: [] };
  /** The text of every turn the host started, once per turn. */
  readonly turns: string[] = [];
  chat: Chat;
  /** Holds a messages-window answer until the returned promise settles. */
  windowGate: (() => Promise<void> | undefined) | undefined;
  /** Holds a turn's answer, after the turn started, until the returned promise settles. */
  turnGate: (() => Promise<void> | undefined) | undefined;
  /** Turn answers to lose after the host applied them, as a dropped connection would. */
  dropAcks = 0;
  /** The host is unreachable: every request fails before it arrives. */
  down = false;
  /** The grants and features this host gives paired devices. */
  capabilities: string[] = CAPABILITIES;
  features: string[] = FEATURES;
  /** Answers a suite adds; asked first, and `UNHANDLED` falls through to the chat and run routes. */
  routes: FakeHostRoute | undefined;
  private readonly ledger: AidenIdempotencyLedger;
  private readonly devices = new Map<string, Device>();

  constructor(readonly id: string, messages: ChatMessage[], maxEventsPerRun?: number) {
    const now = () => 5_000;
    this.chat = { id: "chat-1", title: "Release notes", createdAt: 1, updatedAt: 2, workspaceId: "ws", messages };
    this.runs = new HostRunRegistry({ now, epoch: `runs_${id}`, maxEventsPerRun });
    this.service = new AidenRemoteHostRunService({
      registry: this.runs,
      controls: hostControls(this.runs, this.effects),
      now,
      heartbeatMs: 3_600_000,
    });
    this.ledger = new AidenIdempotencyLedger(undefined, { ttlMs: 600_000, now });
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

  /** The connection one paired desktop (`deviceId`) holds to this host. */
  client(deviceId = "desktop"): PeerClient {
    let device = this.devices.get(deviceId);
    if (!device) {
      device = { id: deviceId, capabilities: new Set<AidenRemoteCapability>(this.capabilities as AidenRemoteCapability[]) };
      this.devices.set(deviceId, device);
    }
    const caller = device;
    return {
      json: async (input) => {
        if (this.down) throw new PeerTransportError("unavailable");
        this.calls.push(`${input.method ?? "GET"} ${input.path}`);
        if (input.path === "/server")
          return { protocolVersion: 1, instanceId: this.id, capabilities: this.capabilities, features: this.features };
        if (input.path === "/device/capabilities") return { capabilities: this.capabilities };
        try {
          return await this.answer(input, caller);
        } catch (error) {
          throw peerError(error);
        }
      },
      events: (input, onFrame) =>
        this.down ? Promise.reject(new PeerTransportError("unavailable")) : this.events(input, onFrame, caller),
    };
  }

  /** Persists a turn the way the host does before announcing `done`. */
  append(...messages: ChatMessage[]): void {
    this.chat = { ...this.chat, messages: [...this.chat.messages, ...messages], updatedAt: this.chat.updatedAt + 1 };
  }

  /** A run started on the host itself (its own window, not a paired device). */
  async start(runId: string): Promise<void> {
    this.runs.begin({ runId, chatId: "chat-1", origin: "renderer" });
    this.feed.noteRun(this.runs.summary(runId)!, false);
    await this.feed.refresh();
  }

  /** Runs `action` once per device, route, resource and key, replaying its answer for a repeated key. */
  idempotent<T>(scope: { deviceId: string; route: string; resourceId: string; key: string }, body: unknown, action: () => Promise<T>): Promise<T> {
    return this.ledger.execute(scope, body, action);
  }

  windowReads(): string[] {
    return this.calls.filter((call) => call.startsWith("GET /chats/chat-1/messages"));
  }

  turnRequests(): string[] {
    return this.calls.filter((call) => call === "POST /chats/chat-1/turns");
  }

  close(): void {
    this.feed.close();
    for (const id of this.devices.keys()) this.service.revokeDevice(id);
  }

  private async answer(input: PeerRequest, device: Device): Promise<unknown> {
    const url = new URL(input.path, "https://host.invalid");
    const method = input.method ?? "GET";
    const key = input.idempotencyKey ?? "";
    const access = async <T>(_chatId: string, action: () => Promise<T>) => action();
    if (this.routes) {
      const answered = await this.routes(input, device.id);
      if (answered !== UNHANDLED) return answered;
    }
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
    if (url.pathname === "/chats/chat-1" && method === "GET") {
      return JSON.parse(JSON.stringify(projectAidenRemoteChat(this.chat)));
    }
    if (url.pathname === "/chats/chat-1/read" && method === "POST") {
      this.reads.push(input.body);
      return undefined; // 204
    }
    if (url.pathname === "/chats/chat-1/turns" && method === "POST") {
      const text = String((input.body as { text?: unknown } | undefined)?.text ?? "");
      const receipt = await this.ledger.execute(
        { deviceId: device.id, route: "POST /chats/{id}/turns", resourceId: "chat-1", key },
        { text },
        async () => {
          const turn = this.turns.push(text);
          const message: ChatMessage = { id: `sent-${turn}`, role: "user", content: text, createdAt: 3_000 + turn };
          this.append(message);
          const runId = `run-turn-${turn}`;
          this.runs.begin({ runId, chatId: "chat-1", origin: "remote" });
          this.feed.noteRun(this.runs.summary(runId)!, false);
          return {
            turnId: `turn_${turn}`,
            streamId: `stream_${turn}`,
            status: "accepted" as const,
            message: projectAidenRemoteChat({ ...this.chat, messages: [message] }).messages[0]!,
          };
        },
      );
      await this.turnGate?.();
      if (this.dropAcks > 0) {
        this.dropAcks -= 1;
        throw new PeerTransportError("unavailable");
      }
      return JSON.parse(JSON.stringify(receipt));
    }
    const run = /^\/runs\/([^/]+)\/(cancel|inputs)$/u.exec(url.pathname);
    if (run && method === "POST") {
      const runId = decodeURIComponent(run[1]!);
      const result = run[2] === "cancel"
        ? await this.service.cancel(device.id, runId, key, access)
        : await this.service.submitInput(device.id, runId, input.body, key, access);
      return JSON.parse(JSON.stringify(result));
    }
    const prompt = /^\/runs\/([^/]+)\/(approvals|questions)\/([^/]+)\/respond$/u.exec(url.pathname);
    if (prompt && method === "POST") {
      const runId = decodeURIComponent(prompt[1]!);
      const promptId = decodeURIComponent(prompt[3]!);
      const result = prompt[2] === "approvals"
        ? await this.service.respondApproval(device.id, runId, promptId, input.body, key, access)
        : await this.service.respondQuestion(device.id, runId, promptId, input.body, key, access);
      return JSON.parse(JSON.stringify(result));
    }
    throw new AidenRemoteServiceError("run_gone", "Not found.", 404);
  }

  private events(input: PeerRequest, onFrame: (frame: string) => void, device: Device): Promise<PeerStreamEnd> {
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
      this.route(input, wire as unknown as ServerResponse, device).then(
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

  private async route(input: PeerRequest, wire: ServerResponse, device: Device): Promise<void> {
    if (input.path === "/host/events") {
      await this.feed.open(device, input.lastEventId, wire);
      return;
    }
    const run = /^\/runs\/([^/]+)\/events$/u.exec(input.path);
    if (run) {
      this.service.openRunEvents(device, decodeURIComponent(run[1]!), Number(input.lastEventId ?? 0), wire);
      return;
    }
    const chat = /^\/chats\/([^/]+)\/runs\/current\/events$/u.exec(input.path);
    if (chat) {
      const runId = this.service.currentRunId(decodeURIComponent(chat[1]!));
      this.service.openRunEvents(device, runId, 0, wire);
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

/**
 * One paired desktop (`deviceId`) with its own main process, opening the
 * host's chat. Two calls with different device IDs are two Macs controlling
 * the same host.
 */
export async function setup(host: FakeHost, deviceId = "desktop") {
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
      capabilities: host.capabilities,
      features: host.features,
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
    client: () => host.client(deviceId),
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
  await adapter.ready();
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
