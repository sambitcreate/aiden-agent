import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceServiceState } from "../../../renderer/shared/devices.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { registerDeviceHandlersWith, type DeviceIpcEvent } from "./device-ipc.js";
import type { DeviceService } from "./device-service.js";

const CHANNELS = [
  "devices:get-state",
  "devices:consent",
  "devices:refresh",
  "devices:refresh-peers",
  "devices:open",
  "devices:close",
  "devices:stream-grant",
  "devices:action",
  "devices:settings",
  "devices:screenshot",
];

const STATE: DeviceServiceState = {
  hostStatus: "needs-consent",
  hostStatuses: { local: { status: "needs-consent" } },
  hosts: [{ id: "local", kind: "local", name: "This Mac", status: "needs-consent" }],
  consent: { streaming: false, agentAccess: false, peerSharing: false },
  devices: [],
  sessions: [],
  toolVersions: { hub: "0.12.0", agent: "0.21.12" },
};

function harness(options: { enabled: boolean; ownerError?: boolean }) {
  const handlers = new Map<string, (event: DeviceIpcEvent, ...args: unknown[]) => unknown>();
  const calls: unknown[][] = [];
  const sent: unknown[][] = [];
  let stateListener: ((state: DeviceServiceState) => void) | null = null;
  let revealListener: ((chatId: string) => void) | null = null;
  let serviceBuilt = 0;
  const invalidators: Array<() => void> = [];
  const owner: RendererDocumentOwner = {
    id: 1,
    documentId: "doc",
    isDestroyed: () => false,
    send: (channel, payload) => sent.push([channel, payload]),
    onInvalidated: (listener) => {
      invalidators.push(listener);
      return () => undefined;
    },
  };
  const record =
    (name: string, result: unknown = STATE) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const service = {
    load: record("load"),
    grantConsent: record("grantConsent"),
    revokeConsent: record("revokeConsent"),
    refresh: record("refresh"),
    refreshLocal: record("refreshLocal"),
    open: record("open", { chatId: "chat" }),
    close: record("close", undefined),
    action: record("action", { appearance: "dark" }),
    settings: record("settings", {}),
    screenshot: record("screenshot", Buffer.from([0x89, 0x50])),
    streamGrant: record("streamGrant", { origin: "http://127.0.0.1:1", token: "t", expiresAt: 1 }),
    onState: (listener: (state: DeviceServiceState) => void) => {
      stateListener = listener;
      return () => undefined;
    },
    onReveal: (listener: (chatId: string) => void) => {
      revealListener = listener;
      return () => undefined;
    },
  } as unknown as DeviceService;
  registerDeviceHandlersWith({
    handle: (channel, listener) => handlers.set(channel, listener),
    enabled: () => options.enabled,
    owner: () => {
      if (options.ownerError) throw new Error("Simulator access requires the active application document.");
      return owner;
    },
    service: () => {
      serviceBuilt += 1;
      return service;
    },
  });
  const invoke = (channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)!({ sender: {}, senderFrame: {} }, ...args));
  return {
    handlers,
    invoke,
    calls,
    sent,
    serviceBuilt: () => serviceBuilt,
    emit: (state: DeviceServiceState) => stateListener?.(state),
    reveal: (chatId: string) => revealListener?.(chatId),
    invalidate: () => invalidators.forEach((listener) => listener()),
  };
}

test("every devices channel is registered and refused while the flag is off", async () => {
  const ipc = harness({ enabled: false });
  assert.deepEqual([...ipc.handlers.keys()].sort(), [...CHANNELS].sort());
  for (const channel of CHANNELS) {
    await assert.rejects(ipc.invoke(channel, "streaming", true), /not enabled/u, channel);
  }
  assert.equal(ipc.serviceBuilt(), 0, "the service is never built while disabled");
});

test("calls from a stale document are refused before the service runs", async () => {
  const ipc = harness({ enabled: true, ownerError: true });
  for (const channel of CHANNELS) {
    await assert.rejects(ipc.invoke(channel), /active application document/u, channel);
  }
  assert.deepEqual(ipc.calls, []);
});

test("inputs are validated and user opens are always attributed to the user", async () => {
  const ipc = harness({ enabled: true });
  await assert.rejects(ipc.invoke("devices:consent", "everything", true), /Unknown simulator consent/u);
  await assert.rejects(ipc.invoke("devices:consent", "streaming", "yes"), /Invalid simulator consent/u);
  await assert.rejects(ipc.invoke("devices:open", null), /Invalid simulator request/u);
  await assert.rejects(ipc.invoke("devices:open", { chatId: "c", deviceId: "../etc" }), /valid simulator/u);
  await assert.rejects(ipc.invoke("devices:open", { chatId: "", deviceId: "ABC" }), /valid chat/u);
  await assert.rejects(
    ipc.invoke("devices:close", { chatId: "c", hostId: "local", deviceId: "ABC", shutdown: "yes" }),
    /Invalid simulator request/u,
  );
  assert.deepEqual(ipc.calls, []);

  await ipc.invoke("devices:consent", "streaming", true);
  await ipc.invoke("devices:consent", "agentAccess", false);
  await ipc.invoke("devices:open", { chatId: "chat-1", deviceId: "ABC-123", openedBy: "agent" });
  await ipc.invoke("devices:close", { chatId: "chat-1", hostId: "local", deviceId: "ABC-123" });
  assert.deepEqual(ipc.calls, [
    ["grantConsent", "streaming"],
    ["revokeConsent", "agentAccess"],
    ["open", { chatId: "chat-1", hostId: "local", deviceId: "ABC-123", openedBy: "user" }],
    ["close", { chatId: "chat-1", hostId: "local", deviceId: "ABC-123", shutdown: false }],
  ]);
});

test("state changes reach subscribed documents until they are invalidated", async () => {
  const ipc = harness({ enabled: true });
  await ipc.invoke("devices:get-state");
  await ipc.invoke("devices:refresh");
  ipc.emit({ ...STATE, hostStatus: "starting" });
  assert.equal(ipc.sent.length, 1, "a document subscribes once");
  assert.equal(ipc.sent[0]![0], "devices:state");
  ipc.reveal("chat-1");
  assert.deepEqual(ipc.sent[1], ["devices:reveal", { chatId: "chat-1" }]);
  ipc.invalidate();
  ipc.emit({ ...STATE, hostStatus: "ready" });
  ipc.reveal("chat-1");
  assert.equal(ipc.sent.length, 2);
});

test("actions are parsed fail-closed and screenshots return plain bytes", async () => {
  const ipc = harness({ enabled: true });
  await assert.rejects(
    ipc.invoke("devices:action", { hostId: "local", deviceId: "ABC", type: "exec", command: "id" }),
    /Unsupported simulator action/u,
  );
  await assert.rejects(
    ipc.invoke("devices:action", { hostId: "local", deviceId: "ABC", type: "openUrl", url: "file:///etc" }),
    /Unsupported simulator action/u,
  );
  await assert.rejects(ipc.invoke("devices:settings", { hostId: "local", deviceId: "a/b" }), /valid simulator/u);
  await assert.rejects(ipc.invoke("devices:screenshot", { deviceId: "ABC" }), /valid device host/u);
  assert.deepEqual(ipc.calls, []);

  const action = { hostId: "local", deviceId: "ABC", type: "setAppearance", value: "dark", extra: 1 };
  assert.deepEqual(await ipc.invoke("devices:action", action), { appearance: "dark" });
  await ipc.invoke("devices:settings", { hostId: "local", deviceId: "ABC" });
  const png = await ipc.invoke("devices:screenshot", { hostId: "local", deviceId: "ABC" });
  assert.ok(png instanceof Uint8Array && !Buffer.isBuffer(png));
  assert.deepEqual([...(png as Uint8Array)], [0x89, 0x50]);
  assert.deepEqual(ipc.calls, [
    ["action", { hostId: "local", deviceId: "ABC", type: "setAppearance", value: "dark" }],
    ["settings", { hostId: "local", deviceId: "ABC" }],
    ["screenshot", { hostId: "local", deviceId: "ABC" }],
  ]);
});
