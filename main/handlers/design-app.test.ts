// The designApp:* channels, registered and invoked the way main wires them,
// with the real document-owner check, the real consent broker and a fake
// DesignAppServers.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { DesignAppsSnapshot, DesignAppStatus } from "../../renderer/shared/design-app.js";
import { DesignAppConsent } from "../services/design-canvas/app-server/app-consent.js";
import type { DesignAppChooseInput, DesignAppStartInput } from "../services/design-canvas/app-server/app-server-main.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { createDesignModeCardEnter, registerDesignAppHandlers, type DesignAppHandlerDeps } from "./design-app.js";

type Event = Electron.IpcMainInvokeEvent;
type Handler = (event: Event, ...args: unknown[]) => unknown;

function mainFrame(processId: number, routingId: number, frameToken: string) {
  return { processId, routingId, frameToken, detached: false, parent: null as unknown, isDestroyed: () => false, send: () => undefined };
}

/** A window's web contents and the events its main frame (or a subframe in it) sends. */
function windowContents(id: number) {
  const contents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: mainFrame(7, id, `frame-${id}`),
    isDestroyed: () => false,
  });
  const fromMain = { sender: contents, senderFrame: contents.mainFrame, processId: 7, frameId: id } as unknown as Event;
  const sub = { ...mainFrame(7, 100 + id, `sub-${id}`), parent: contents.mainFrame };
  const fromSubframe = { sender: contents, senderFrame: sub, processId: 7, frameId: 100 + id } as unknown as Event;
  return { contents, fromMain, fromSubframe };
}

function status(overrides: Partial<DesignAppStatus> = {}): DesignAppStatus {
  return { workspaceId: "site", appRoot: ".", source: "started", frameworkLabel: "Vite", phase: "running", since: 1, revision: 1, ...overrides };
}

const CHATS: Record<string, { id: string; workspaceId?: string; botId?: string; owner?: unknown }> = {
  "site-chat": { id: "site-chat", workspaceId: "site" },
  "bot-chat": { id: "bot-chat", workspaceId: "site", botId: "bot-1" },
  "routine-chat": { id: "routine-chat", workspaceId: "site", owner: { kind: "design-project" } },
  "folderless-chat": { id: "folderless-chat", workspaceId: "remote-only" },
};

function harness(options: { enabled?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const calls: Array<{ method: string; input: unknown }> = [];
  const consent = new DesignAppConsent();
  const snapshot: DesignAppsSnapshot = { workspaceId: "site", target: "single", apps: [status()], candidates: [], chosen: [] };
  const deps: DesignAppHandlerDeps<Event> = {
    enabled: () => options.enabled ?? true,
    handle: (channel, handler) => handlers.set(channel, handler),
    owner: (event) => rendererDocumentOwner(event, () => new Error("Active renderer required.")),
    getChat: async (chatId) => CHATS[chatId] ?? null,
    workspace: async (workspaceId) =>
      workspaceId === "site"
        ? { id: "site", folderPath: "/Users/person/site", permission: "ask" }
        : workspaceId === "remote-only"
          ? { id: "remote-only", permission: "ask" }
          : undefined,
    servers: {
      snapshot: async (workspaceId) => {
        calls.push({ method: "snapshot", input: workspaceId });
        return snapshot;
      },
      start: async (input: DesignAppStartInput) => {
        calls.push({ method: "start", input });
        return status();
      },
      stop: async (workspaceId: string, appRoot: string) => {
        calls.push({ method: "stop", input: { workspaceId, appRoot } });
        return status({ phase: "stopped" });
      },
      restart: async (input: DesignAppStartInput & { appRoot: string }) => {
        calls.push({ method: "restart", input });
        return status();
      },
      choose: async (input: DesignAppChooseInput) => {
        calls.push({ method: "choose", input });
        return status();
      },
      logs: async (workspaceId: string, appRoot: string, logOptions: { after?: number; maxBytes: number }) => {
        calls.push({ method: "logs", input: { workspaceId, appRoot, ...logOptions } });
        return { text: "ready", from: 0, next: 5, truncated: false };
      },
    },
    consent,
  };
  registerDesignAppHandlers(deps);
  const invoke = async (channel: string, event: Event, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} is registered`);
    return handler(event, ...args);
  };
  return { handlers, invoke, calls, consent };
}

const PERSON_CHANNELS: Array<[string, unknown[]]> = [
  ["designApp:status:get", ["site-chat"]],
  ["designApp:start", ["site-chat"]],
  ["designApp:stop", ["site-chat", "."]],
  ["designApp:restart", ["site-chat", ".", {}]],
  ["designApp:choose", ["site-chat", "."]],
  ["designApp:logs", ["site-chat", ".", {}]],
];

test("every designApp channel is registered, and every handler refuses while the flag is off", async () => {
  const on = harness();
  assert.deepEqual(
    [...on.handlers.keys()].sort(),
    [...PERSON_CHANNELS.map(([channel]) => channel), "designApp:consentAnswer"].sort(),
  );
  const off = harness({ enabled: false });
  const window = windowContents(1);
  for (const [channel, args] of PERSON_CHANNELS) {
    await assert.rejects(Promise.resolve(off.invoke(channel, window.fromMain, ...args)), /not available/u, channel);
  }
  assert.equal(await off.invoke("designApp:consentAnswer", window.fromMain, "r1", "allow"), false);
  assert.deepEqual(off.calls, []);
});

test("every designApp handler refuses a subframe sender", async () => {
  const { invoke, calls } = harness();
  const window = windowContents(1);
  for (const [channel, args] of PERSON_CHANNELS) {
    await assert.rejects(Promise.resolve(invoke(channel, window.fromSubframe, ...args)), /Active renderer required/u, channel);
  }
  assert.equal(await invoke("designApp:consentAnswer", window.fromSubframe, "r1", "allow"), false);
  assert.deepEqual(calls, []);
});

test("status:get, start, stop, restart, choose and logs refuse a Bot chat, a missing chat and a chat whose workspace has no folder", async () => {
  const { invoke, calls } = harness();
  const window = windowContents(1);
  for (const chatId of ["bot-chat", "routine-chat", "missing-chat", "folderless-chat"]) {
    for (const [channel, args] of PERSON_CHANNELS) {
      await assert.rejects(Promise.resolve(invoke(channel, window.fromMain, chatId, ...args.slice(1))), Error, `${channel} ${chatId}`);
    }
  }
  assert.deepEqual(calls, []);
});

test("start passes by person, the sender's document owner and the workspace permission", async () => {
  const { invoke, calls } = harness();
  const window = windowContents(3);
  await invoke("designApp:start", window.fromMain, "site-chat");
  await invoke("designApp:start", window.fromMain, "site-chat", "apps/web");
  await invoke("designApp:restart", window.fromMain, "site-chat", ".", { install: true });
  await invoke("designApp:choose", window.fromMain, "site-chat", "apps/web", "storybook");
  const [first, second, restart, choose] = calls as Array<{ method: string; input: DesignAppStartInput & { script?: string } }>;
  assert.equal(first!.method, "start");
  assert.equal(first!.input.by, "person");
  assert.equal(first!.input.chatId, "site-chat");
  assert.equal(first!.input.workspaceId, "site");
  assert.equal(first!.input.permission, "ask");
  assert.equal(first!.input.appRoot, undefined);
  assert.equal(first!.input.owner?.id, 3);
  assert.equal(first!.input.owner?.documentId, rendererDocumentOwner(window.fromMain, () => new Error("x")).documentId);
  assert.equal(second!.input.appRoot, "apps/web");
  assert.deepEqual([restart!.method, restart!.input.appRoot, restart!.input.install, restart!.input.by], ["restart", ".", true, "person"]);
  assert.deepEqual([choose!.method, choose!.input.appRoot, choose!.input.script, choose!.input.by], ["choose", "apps/web", "storybook", "person"]);

  await invoke("designApp:stop", window.fromMain, "site-chat", ".");
  assert.deepEqual(calls[calls.length - 1], { method: "stop", input: { workspaceId: "site", appRoot: "." } });
  const logs = await invoke("designApp:logs", window.fromMain, "site-chat", ".", { after: 12 });
  assert.deepEqual(logs, { text: "ready", from: 0, next: 5, truncated: false });
  assert.deepEqual(calls[calls.length - 1], { method: "logs", input: { workspaceId: "site", appRoot: ".", after: 12, maxBytes: 64 * 1024 } });
  await invoke("designApp:status:get", window.fromMain, "site-chat");
  assert.deepEqual(calls[calls.length - 1], { method: "snapshot", input: "site" });
});

test("consentAnswer from another window is refused", async () => {
  const { invoke, consent } = harness();
  const asking = windowContents(1);
  const other = windowContents(2);
  const owner = rendererDocumentOwner(asking.fromMain, () => new Error("x"));
  const sent: Array<{ requestId: string }> = [];
  const pending = consent.request({
    key: "site\u0000.",
    by: "person",
    owner: { ...owner, send: (channel, payload) => channel === "designApp:consent" && sent.push(payload as { requestId: string }) },
    request: {
      kind: "launch",
      chatId: "site-chat",
      workspaceId: "site",
      appRoot: ".",
      frameworkLabel: "Vite",
      reason: "first",
      runCommand: "npm run dev",
      scripts: [],
      launchFiles: [],
      savesChoice: false,
    },
  });
  const requestId = sent[0]!.requestId;
  assert.equal(await invoke("designApp:consentAnswer", other.fromMain, requestId, "allow"), false);
  assert.equal(await invoke("designApp:consentAnswer", asking.fromMain, requestId, "maybe"), false);
  assert.equal(await invoke("designApp:consentAnswer", asking.fromMain, requestId, "allow"), true);
  assert.equal(await pending, "allow");
});

test("malformed arguments are refused", async () => {
  const { invoke, calls } = harness();
  const window = windowContents(1);
  const bad: Array<[string, unknown[]]> = [
    ["designApp:status:get", []],
    ["designApp:status:get", [""]],
    ["designApp:start", ["site-chat", 5]],
    ["designApp:start", ["site-chat", "../x"]],
    ["designApp:start", ["site-chat", "/etc"]],
    ["designApp:stop", ["site-chat"]],
    ["designApp:stop", ["site-chat", "apps/../x"]],
    ["designApp:restart", ["site-chat", ".", { install: "yes" }]],
    ["designApp:restart", ["site-chat", ".", "install"]],
    ["designApp:choose", ["site-chat", ".", 3]],
    ["designApp:choose", ["site-chat", ".", ""]],
    ["designApp:logs", ["site-chat", ".", { after: -1 }]],
    ["designApp:logs", ["site-chat", ".", { after: 1.5 }]],
    ["designApp:logs", ["site-chat", ".", null]],
  ];
  for (const [channel, args] of bad) {
    await assert.rejects(Promise.resolve(invoke(channel, window.fromMain, ...args)), Error, `${channel} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(calls, []);
});

test("Enter on Aiden's design-mode card starts the workspace's app for the answering window, only with the flag on", async () => {
  const window = windowContents(5);
  const owner = rendererDocumentOwner(window.fromMain, () => new Error("x"));
  const entered: unknown[] = [];
  const broadcasts: string[] = [];
  const enter = (enabled: boolean) =>
    createDesignModeCardEnter({
      setDesignMode: async (chatId) => ({ id: chatId, workspaceId: "site" }),
      broadcastEntered: (chatId) => broadcasts.push(chatId),
      designApp: { enabled: () => enabled, entered: (input) => entered.push(input) },
    });
  await enter(true)(owner)("site-chat");
  assert.deepEqual(entered, [{ chatId: "site-chat", workspaceId: "site", owner }]);
  await enter(false)(owner)("site-chat");
  assert.equal(entered.length, 1, "with the flag off nothing starts");
  assert.deepEqual(broadcasts, ["site-chat", "site-chat"], "design mode turns on either way");
});
