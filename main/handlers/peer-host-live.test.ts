import assert from "node:assert/strict";
import test from "node:test";
import type { PeerHostView } from "../../renderer/shared/peer-host.js";
import { AIDEN_REMOTE_RUN_STREAMS_FEATURE } from "../services/aiden-remote-protocol.js";
import {
  PeerHostManager,
  type PeerManagerRegistry,
} from "../services/peer-host-manager.js";
import { PEER_RUN_EVICT_MS } from "../services/peer-run-subscriptions.js";
import type { PeerRequest } from "../services/peer-transport.js";
import { PeerTransportError } from "../services/peer-transport.js";
import { registerPeerHostLiveHandlers, type PeerHostLiveOwner } from "./peer-host-live.js";

class FakeTimers {
  private now = 0;
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

type Request = Omit<PeerRequest, "credential">;

/** A host that holds every stream open and answers unary reads with `answer`. */
class FakeRegistry implements PeerManagerRegistry {
  view: PeerHostView = {
    id: "host_a",
    name: "Studio",
    enabled: true,
    state: "disconnected",
    features: [AIDEN_REMOTE_RUN_STREAMS_FEATURE],
    capabilities: ["runs:observe", "chats:read"],
  };
  readonly streams: { path: string; signal: AbortSignal }[] = [];
  readonly reads: Request[] = [];
  answer: (input: Request) => Promise<unknown> = async () => ({ approval: null });

  list = async (): Promise<PeerHostView[]> => [{ ...this.view }];
  connect = async (): Promise<PeerHostView> => ({ ...this.view });
  request = (_id: string, input: Request): Promise<unknown> => {
    if (!input.path.endsWith("/events")) {
      this.reads.push(input);
      return this.answer(input);
    }
    const signal = input.signal!;
    this.streams.push({ path: input.path, signal });
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new PeerTransportError("unavailable")), {
        once: true,
      });
    });
  };
  setEnabled = async (_id: string, enabled: boolean): Promise<void> => {
    this.view = { ...this.view, enabled };
  };
  remove = async (): Promise<void> => {};
  onChanged = (): (() => void) => () => {};
  attachConnectionState(): void {}
}

/** One renderer main-frame document; `navigate` invalidates it like a reload. */
class FakeDocument implements PeerHostLiveOwner {
  private destroyed = false;
  private readonly listeners = new Set<() => void>();
  constructor(readonly key: string) {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  onInvalidated(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  navigate(): void {
    this.destroyed = true;
    for (const listener of [...this.listeners]) {
      this.listeners.delete(listener);
      listener();
    }
  }
}

/** `null` stands for a sender that is not an application main frame. */
type FakeEvent = { document: FakeDocument | null };

async function setup() {
  const registry = new FakeRegistry();
  const timers = new FakeTimers();
  const sent: { channel: string; payload: unknown }[] = [];
  const manager = new PeerHostManager({
    registry,
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    timers,
    random: () => 0.5,
  });
  const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => unknown>();
  registerPeerHostLiveHandlers<FakeEvent>({
    handle: (channel, handler) => handlers.set(channel, handler),
    owner: (event) => {
      if (!event.document) throw new Error("Device actions require an active application document.");
      return event.document;
    },
    manager: () => manager,
  });
  const invoke = async (channel: string, from: FakeDocument | null, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, channel);
    return handler({ document: from }, ...args);
  };
  await manager.whenReady();
  await settle();
  return { registry, timers, manager, sent, invoke };
}

test("windows share one live run stream and lose their viewers when their document goes away", async () => {
  const { registry, timers, manager, invoke } = await setup();
  try {
    const first = new FakeDocument("1:main");
    const second = new FakeDocument("2:main");
    const a = (await invoke("remote:peerRunSubscribe", first, "host_a", { runId: "run_1" }, 0)) as {
      subscriptionId: string;
      key: string;
    };
    const b = (await invoke("remote:peerRunSubscribe", second, "host_a", { runId: "run_1" }, 0)) as {
      subscriptionId: string;
      key: string;
    };
    await settle();
    assert.equal(a.key, b.key);
    assert.notEqual(a.subscriptionId, b.subscriptionId);
    assert.deepEqual(
      registry.streams.map((stream) => stream.path),
      ["/runs/run_1/events"],
      "two windows share one host stream",
    );

    assert.equal(
      await invoke("remote:peerRunUnsubscribe", second, a.subscriptionId),
      false,
      "a window cannot release another window's viewer",
    );

    // Reloading the first window releases its viewer; the reloaded document
    // (same frame, same key) cannot release it a second time.
    first.navigate();
    const reloaded = new FakeDocument("1:main");
    assert.equal(await invoke("remote:peerRunUnsubscribe", reloaded, a.subscriptionId), false);

    // The second window still holds the stream open past the eviction window.
    timers.advance(PEER_RUN_EVICT_MS + 1);
    await settle();
    assert.equal(registry.streams[0]!.signal.aborted, false);

    assert.equal(await invoke("remote:peerRunUnsubscribe", second, b.subscriptionId), true);
    timers.advance(PEER_RUN_EVICT_MS + 1);
    await settle();
    assert.equal(registry.streams[0]!.signal.aborted, true, "the last viewer leaving evicts the stream");
  } finally {
    manager.close();
  }
});

test("a subscription that lands after its document went away is released", async () => {
  const { registry, timers, manager, invoke } = await setup();
  try {
    const page = new FakeDocument("1:main");
    const pending = invoke("remote:peerRunSubscribe", page, "host_a", { runId: "run_1" }, 0);
    page.navigate();
    await assert.rejects(pending, /application document changed/u);
    await settle();
    assert.equal(registry.streams.length, 1);
    timers.advance(PEER_RUN_EVICT_MS + 1);
    await settle();
    assert.ok(
      registry.streams.every((stream) => stream.signal.aborted),
      "no stream outlives the document that asked for it",
    );
  } finally {
    manager.close();
  }
});

test("only an active application document reaches the device supervisor", async () => {
  const { registry, manager, invoke } = await setup();
  try {
    const gone = new FakeDocument("1:main");
    gone.navigate();
    for (const [channel, args] of [
      ["remote:peerHostStatuses", []],
      ["remote:peerHostFeed", ["host_a"]],
      ["remote:peerCall", ["host_a", { operation: "approval", resourceId: "stream_1" }]],
      ["remote:peerOperation", ["host_a", { operation: "approval", resourceId: "stream_1" }]],
      ["remote:peerRunSubscribe", ["host_a", { runId: "run_1" }, 0]],
      ["remote:peerRunUnsubscribe", ["sub_1"]],
      ["remote:peersSetEnabled", ["host_a", false]],
      ["remote:peersRemove", ["host_a"]],
      ["remote:peerReconnect", ["host_a"]],
    ] as const) {
      await assert.rejects(invoke(channel, gone, ...args), /application document changed/u, channel);
      await assert.rejects(invoke(channel, null, ...args), /active application document/u, channel);
    }
    assert.deepEqual(registry.reads, [], "rejected requests make no host traffic");
    assert.deepEqual(registry.streams, []);
    assert.equal(registry.view.enabled, true);
  } finally {
    manager.close();
  }
});

test("peerCall returns typed outcomes while peerOperation keeps throwing", async () => {
  const { registry, manager, invoke } = await setup();
  try {
    const page = new FakeDocument("1:main");
    const read = { operation: "approval", resourceId: "stream_1" };
    assert.deepEqual(await invoke("remote:peerCall", page, "host_a", read), {
      ok: true,
      value: { approval: null },
    });
    assert.deepEqual(await invoke("remote:peerOperation", page, "host_a", read), { approval: null });

    const invalid = { operation: "approval", resourceId: "../escape" };
    const outcome = (await invoke("remote:peerCall", page, "host_a", invalid)) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, "invalid_request");
    await assert.rejects(invoke("remote:peerOperation", page, "host_a", invalid), {
      message: outcome.error.message,
    });

    // The host answers with a field the contract does not allow.
    registry.answer = async () => ({ approval: null, credential: "private" });
    const leaked = (await invoke("remote:peerCall", page, "host_a", read)) as {
      ok: boolean;
      error: { code: string };
    };
    assert.deepEqual([leaked.ok, leaked.error.code], [false, "invalid_response"]);
    assert.doesNotMatch(JSON.stringify(leaked), /private/u);
  } finally {
    manager.close();
  }
});

test("a request in flight is aborted when its document goes away", async () => {
  const { registry, manager, invoke } = await setup();
  try {
    registry.answer = (input) =>
      new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new PeerTransportError("unavailable")), {
          once: true,
        });
      });
    const page = new FakeDocument("1:main");
    const read = { operation: "approval", resourceId: "stream_1" };
    const call = invoke("remote:peerCall", page, "host_a", read) as Promise<{ ok: boolean }>;
    const operation = invoke("remote:peerOperation", page, "host_a", read);
    await settle();
    assert.equal(registry.reads.length, 2);
    page.navigate();
    assert.ok(registry.reads.every((input) => input.signal?.aborted));
    assert.equal((await call).ok, false);
    await assert.rejects(operation);
  } finally {
    manager.close();
  }
});

test("disabling through IPC stops supervision and drops the host's rows", async () => {
  const { registry, manager, invoke } = await setup();
  try {
    const page = new FakeDocument("1:main");
    const before = (await invoke("remote:peerHostStatuses", page)) as { state: { kind: string } }[];
    assert.deepEqual(
      before.map((status) => status.state.kind),
      ["connected"],
    );
    await assert.rejects(invoke("remote:peersSetEnabled", page, "host_a", "no"), /connection state/u);
    assert.equal(registry.view.enabled, true);

    await invoke("remote:peersSetEnabled", page, "host_a", false);
    const after = (await invoke("remote:peerHostStatuses", page)) as {
      hostId: string;
      state: { kind: string };
    }[];
    assert.deepEqual(
      after.map((status) => [status.hostId, status.state.kind]),
      [["host_a", "disabled"]],
    );
    assert.equal(await invoke("remote:peerHostFeed", page, "host_a"), null);
    await assert.rejects(
      invoke("remote:peerRunSubscribe", page, "host_a", { runId: "run_1" }, 0),
      /disabled or unavailable/u,
    );
  } finally {
    manager.close();
  }
});

test("the first status and feed replies describe the loaded hosts, not an empty list", async () => {
  const registry = new FakeRegistry();
  registry.view = { ...registry.view, enabled: false };
  let load!: () => void;
  const loaded = new Promise<void>((resolve) => {
    load = resolve;
  });
  const list = registry.list;
  registry.list = async () => {
    await loaded;
    return list();
  };
  let manager: PeerHostManager | undefined;
  const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => unknown>();
  registerPeerHostLiveHandlers<FakeEvent>({
    handle: (channel, handler) => handlers.set(channel, handler),
    owner: (event) => event.document!,
    // Built on first use, as in the app.
    manager: () =>
      (manager ??= new PeerHostManager({ registry, broadcast: () => {}, timers: new FakeTimers() })),
  });
  try {
    const window = new FakeDocument("1:main");
    const statuses = handlers.get("remote:peerHostStatuses")!({ document: window });
    const feed = handlers.get("remote:peerHostFeed")!({ document: window }, "host_a");
    load();
    assert.deepEqual(await statuses, [
      { hostId: "host_a", generation: 0, state: { kind: "disabled" }, feed: "off", stale: false },
    ]);
    assert.equal(await feed, null);
    assert.equal(registry.streams.length + registry.reads.length, 0, "a disabled host makes no traffic");
  } finally {
    manager?.close();
  }
});

test("a durable request with no saved admission never reaches the host", async () => {
  const { registry, manager, invoke } = await setup();
  try {
    const page = new FakeDocument("durable:main");
    const before = registry.reads.length;
    const result = await invoke("remote:peerCall", page, "host_a", {
      operation: "send", resourceId: "chat_1", body: { text: "Unconfirmed" }, idempotencyKey: "request_123",
    }, { savedIntent: true }) as { ok: boolean; error?: { code: string } };
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "outcome_unknown");
    assert.equal(registry.reads.length, before);
  } finally { manager.close(); }
});
