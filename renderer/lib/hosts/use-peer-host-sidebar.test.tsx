import assert from "node:assert/strict";
import test from "node:test";
import { DOMImplementation } from "@xmldom/xmldom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  PeerHostFeedMessage,
  PeerHostFeedSnapshot,
  PeerHostStatus,
  PeerHostView,
} from "../../shared/peer-host";
import { usePeerHostSidebar, type PeerHostSidebarData } from "./use-peer-host-sidebar";

// The query cache batches notifications on a timer and React renders on an immediate.
const turn = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Lets IPC replies, query updates and React's scheduled renders all land. */
async function settle(): Promise<void> {
  for (let step = 0; step < 10; step += 1) await turn();
}

function view(id: string, name: string): PeerHostView {
  return { id, name, enabled: true, state: "connected", features: [], capabilities: [] };
}

function connected(hostId: string, generation: number): PeerHostStatus {
  return { hostId, generation, state: { kind: "connected", since: 1 }, feed: "live", stale: false };
}

function blocked(hostId: string, generation: number): PeerHostStatus {
  return { hostId, generation, state: { kind: "blocked", reason: "auth" }, feed: "live", stale: false };
}

function feed(hostId: string, sequence: number, chatIds: string[]): PeerHostFeedSnapshot {
  return {
    hostId,
    epoch: "e1",
    sequence,
    stale: false,
    summaries: chatIds.map((id) => ({ id, title: id })),
    workspaces: [],
    bots: [],
    runs: [],
  };
}

/**
 * Main's side of the bridge: it answers reads from its current state and
 * broadcasts each change only to the listeners installed at that moment.
 */
function fakeMain() {
  const state = {
    views: [view("studio", "Studio")],
    statuses: [connected("studio", 1)],
    feeds: new Map([["studio", feed("studio", 1, ["a"])]]),
  };
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const broadcast = (method: string, payload?: unknown) => {
    for (const listener of listeners.get(method) ?? []) listener(payload);
  };
  const ipc = {
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "remote:peersList") return state.views;
      if (channel === "remote:peerHostStatuses") return state.statuses;
      if (channel === "remote:peerHostFeed") return state.feeds.get(args[0] as string) ?? null;
      throw new Error(`Unexpected channel ${channel}`);
    },
    onNotification: (method: string, handler: (payload: unknown) => void) => {
      const set = listeners.get(method) ?? new Set();
      set.add(handler);
      listeners.set(method, set);
      return () => set.delete(handler);
    },
  };
  return {
    ipc,
    pair(next: PeerHostView, status: PeerHostStatus, rows: PeerHostFeedSnapshot) {
      state.views = [...state.views, next];
      state.statuses = [...state.statuses, status];
      state.feeds.set(next.id, rows);
      broadcast("remote:peers-changed");
    },
    setStatus(status: PeerHostStatus) {
      state.statuses = state.statuses.map((entry) => (entry.hostId === status.hostId ? status : entry));
      broadcast("remote:peer-host-state", status);
    },
    addChat(hostId: string, chatId: string) {
      const current = state.feeds.get(hostId)!;
      const sequence = current.sequence + 1;
      const row = { id: chatId, title: chatId };
      state.feeds.set(hostId, { ...current, sequence, summaries: [...current.summaries, row] });
      const message: PeerHostFeedMessage = {
        hostId,
        epoch: current.epoch,
        sequence,
        change: { type: "chat.upsert", row },
      };
      broadcast("remote:host-feed", message);
    },
  };
}

/** A minimal document for react-dom; the hook renders nothing itself. */
function installDocument(ipc: unknown) {
  const document = new DOMImplementation().createDocument(null, "html", null) as unknown as Document;
  const body = document.createElement("body");
  const container = document.createElement("div");
  body.appendChild(container);
  document.documentElement.appendChild(body);
  const elementPrototype = Object.getPrototypeOf(container) as Record<string, unknown>;
  elementPrototype.addEventListener = () => undefined;
  elementPrototype.removeEventListener = () => undefined;
  Object.defineProperty(elementPrototype, "style", { configurable: true, get: () => ({}) });
  const documentPrototype = Object.getPrototypeOf(document) as Record<string, unknown>;
  documentPrototype.addEventListener = () => undefined;
  documentPrototype.removeEventListener = () => undefined;
  const windowValue = {
    document,
    event: undefined,
    aidenAPI: { ipc },
    HTMLIFrameElement: class HTMLIFrameElement {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  Object.defineProperty(document, "defaultView", { configurable: true, value: windowValue });
  const keys = ["window", "document", "navigator", "Node", "Element", "HTMLElement"] as const;
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const ElementConstructor = Object.getPrototypeOf(document.documentElement).constructor;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowValue },
    document: { configurable: true, value: document },
    navigator: { configurable: true, value: { userAgent: "peer-host-sidebar-test" } },
    Node: { configurable: true, value: ElementConstructor },
    Element: { configurable: true, value: ElementConstructor },
    HTMLElement: { configurable: true, value: ElementConstructor },
  });
  return {
    container,
    restore() {
      for (const key of keys) {
        const descriptor = previous.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

/** Mounts the sidebar's store the way the chat shell does, sharing one query cache. */
async function mountSidebar(container: Element, queryClient: QueryClient) {
  let latest: PeerHostSidebarData = { hosts: [], feeds: new Map() };
  function Harness() {
    latest = usePeerHostSidebar();
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    ),
  );
  await settle();
  return {
    rows: () => ({
      hosts: latest.hosts.map((host) => [host.id, host.availability]),
      chats: [...latest.feeds.values()].map((snapshot) => [
        snapshot.hostId,
        snapshot.summaries.map((row) => row.id),
      ]),
    }),
    unmount: async () => {
      flushSync(() => root.unmount());
      await settle();
    },
  };
}

test("changes made while the sidebar is away (in Settings) show once it returns", async () => {
  const main = fakeMain();
  const dom = installDocument(main.ipc);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const first = await mountSidebar(dom.container, queryClient);
    assert.deepEqual(first.rows(), { hosts: [["studio", "online"]], chats: [["studio", ["a"]]] });
    // While the sidebar is mounted, broadcasts keep it current.
    main.addChat("studio", "b");
    await settle();
    assert.deepEqual(first.rows().chats, [["studio", ["a", "b"]]]);

    // Settings replaces the chat shell, so the sidebar and its listeners go away.
    await first.unmount();
    main.setStatus(blocked("studio", 2));
    main.addChat("studio", "c");
    main.pair(view("laptop", "Laptop"), connected("laptop", 1), feed("laptop", 1, ["x"]));

    const second = await mountSidebar(dom.container, queryClient);
    assert.deepEqual(second.rows(), {
      hosts: [
        ["studio", "blocked"],
        ["laptop", "online"],
      ],
      chats: [
        ["studio", ["a", "b", "c"]],
        ["laptop", ["x"]],
      ],
    });
    // And the returned sidebar is listening again.
    main.setStatus(connected("studio", 3));
    main.addChat("laptop", "y");
    await settle();
    assert.deepEqual(second.rows(), {
      hosts: [
        ["studio", "online"],
        ["laptop", "online"],
      ],
      chats: [
        ["studio", ["a", "b", "c"]],
        ["laptop", ["x", "y"]],
      ],
    });
    await second.unmount();
  } finally {
    queryClient.clear();
    dom.restore();
  }
});

test("with no paired host, the sidebar store never asks for statuses or feeds", async () => {
  const main = fakeMain();
  const channels: string[] = [];
  const ipc = {
    ...main.ipc,
    invoke: async (channel: string, ...args: unknown[]) => {
      channels.push(channel);
      return channel === "remote:peersList" ? [] : main.ipc.invoke(channel, ...args);
    },
  };
  const dom = installDocument(ipc);
  const queryClient = new QueryClient();
  try {
    const sidebar = await mountSidebar(dom.container, queryClient);
    await sidebar.unmount();
    const again = await mountSidebar(dom.container, queryClient);
    assert.deepEqual(again.rows(), { hosts: [], chats: [] });
    assert.deepEqual(new Set(channels), new Set(["remote:peersList"]));
    await again.unmount();
  } finally {
    queryClient.clear();
    dom.restore();
  }
});
