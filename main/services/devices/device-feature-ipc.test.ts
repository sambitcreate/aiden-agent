import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceRecordingInfo } from "../../../renderer/shared/device-features.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { registerDeviceFeatureHandlersWith } from "./device-feature-ipc.js";
import type { DeviceFeatures } from "./device-features.js";
import type { DeviceIpcEvent } from "./device-ipc.js";

const CHANNELS = [
  "devices:erase",
  "devices:clipboard-paste",
  "devices:clipboard-copy",
  "devices:recordings-list",
  "devices:recording-start",
  "devices:recording-stop",
  "devices:recording-save",
  "devices:recording-discard",
  "devices:screenshot-save",
  "devices:reveal-saved",
];
const UDID = "5C1E4B7A-0000-4000-8000-000000000001";
const TARGET = { platform: "ios", hostId: "local", deviceId: UDID };
const RECORDING: DeviceRecordingInfo = {
  id: "recording-0001",
  chatId: "chat-1",
  platform: "ios",
  hostId: "local",
  deviceId: UDID,
  status: "recording",
  startedAt: 1,
  endsBy: 600_001,
};

function harness(options: { enabled?: boolean; ownerError?: boolean; dialog?: string | null } = {}) {
  const handlers = new Map<string, (event: DeviceIpcEvent, ...args: unknown[]) => unknown>();
  const calls: unknown[][] = [];
  const sent: unknown[][] = [];
  const revealed: string[] = [];
  const dialogs: unknown[] = [];
  let destroyed = false;
  let recordingsListener: ((list: DeviceRecordingInfo[]) => void) | null = null;
  const invalidators: Array<() => void> = [];
  const owner: RendererDocumentOwner = {
    id: 1,
    documentId: "doc",
    isDestroyed: () => destroyed,
    send: (channel, payload) => sent.push([channel, payload]),
    onInvalidated: (listener) => {
      invalidators.push(listener);
      return () => undefined;
    },
  };
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const features = {
    erase: record("erase", { wasBooted: true }),
    pasteFromHost: record("pasteFromHost", { bytes: 5 }),
    copyToHost: record("copyToHost", { bytes: 3 }),
    recordings: () => [RECORDING],
    startRecording: record("startRecording", RECORDING),
    stopRecording: record("stopRecording", { ...RECORDING, status: "ready" }),
    async saveRecording(id: string, choose: (name: string) => Promise<string | null>) {
      const path = await choose("iPhone-2026.mp4");
      calls.push(["saveRecording", id, path]);
      return path ? { status: "saved", path } : { status: "cancelled" };
    },
    discardRecording: record("discardRecording", undefined),
    async saveScreenshot(target: unknown, choose: (name: string) => Promise<string | null>) {
      const path = await choose("iPhone-2026.png");
      calls.push(["saveScreenshot", target, path]);
      return path ? { status: "saved", path } : { status: "cancelled" };
    },
    isSavedPath: (file: string) => file === "/Users/me/Downloads/shot.png",
    onRecordings(listener: (list: DeviceRecordingInfo[]) => void) {
      recordingsListener = listener;
      return () => undefined;
    },
  } as unknown as DeviceFeatures;
  registerDeviceFeatureHandlersWith({
    handle: (channel, listener) => handlers.set(channel, listener),
    enabled: () => options.enabled ?? true,
    owner: () => {
      if (options.ownerError) throw new Error("Simulator access requires the active application document.");
      return owner;
    },
    features: () => features,
    chooseSavePath: async (_event, request) => {
      dialogs.push(request);
      return options.dialog === undefined ? "/Users/me/Downloads/chosen" : options.dialog;
    },
    revealInFinder: (file) => revealed.push(file),
  });
  const invoke = (channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)!({ sender: {}, senderFrame: {} }, ...args));
  return {
    handlers,
    invoke,
    calls,
    sent,
    revealed,
    dialogs,
    destroy: () => {
      destroyed = true;
    },
    publish: (list: DeviceRecordingInfo[]) => recordingsListener?.(list),
    invalidate: () => invalidators.forEach((listener) => listener()),
  };
}

test("every feature channel is registered and refused while the flag is off or the document is stale", async () => {
  const off = harness({ enabled: false });
  assert.deepEqual([...off.handlers.keys()].sort(), [...CHANNELS].sort());
  for (const channel of CHANNELS) await assert.rejects(off.invoke(channel, TARGET), /not enabled/u, channel);
  const stale = harness({ ownerError: true });
  for (const channel of CHANNELS) await assert.rejects(stale.invoke(channel, TARGET), /active application document/u);
  assert.deepEqual([...off.calls, ...stale.calls], []);
});

test("targets are parsed fail-closed before any feature runs", async () => {
  const ipc = harness();
  for (const channel of ["devices:erase", "devices:clipboard-paste", "devices:clipboard-copy"]) {
    await assert.rejects(ipc.invoke(channel, { hostId: "local", deviceId: UDID }), /valid simulator/u, channel);
    await assert.rejects(ipc.invoke(channel, { ...TARGET, deviceId: "$(id)" }), /valid simulator/u, channel);
  }
  await assert.rejects(ipc.invoke("devices:recording-start", TARGET), /valid chat/u);
  await assert.rejects(ipc.invoke("devices:recording-stop", { id: "../x" }), /valid recording/u);
  await assert.rejects(ipc.invoke("devices:screenshot-save", { hostId: "local", deviceId: "a/b" }), /valid simulator/u);
  assert.deepEqual(ipc.calls, []);

  assert.deepEqual(await ipc.invoke("devices:erase", { ...TARGET, command: "rm -rf /" }), { wasBooted: true });
  await ipc.invoke("devices:clipboard-paste", TARGET);
  await ipc.invoke("devices:clipboard-copy", TARGET);
  await ipc.invoke("devices:recording-start", { chatId: "chat-1", ...TARGET });
  await ipc.invoke("devices:recording-stop", { id: "recording-0001" });
  await ipc.invoke("devices:recording-discard", { id: "recording-0001" });
  assert.deepEqual(ipc.calls, [
    ["erase", TARGET],
    ["pasteFromHost", TARGET],
    ["copyToHost", TARGET],
    ["startRecording", "chat-1", TARGET],
    ["stopRecording", "recording-0001"],
    ["discardRecording", "recording-0001"],
  ]);
});

test("saves go through the user's dialog, and a document that went away gets no file", async () => {
  const ipc = harness();
  assert.deepEqual(await ipc.invoke("devices:screenshot-save", { hostId: "local", deviceId: UDID }), {
    status: "saved",
    path: "/Users/me/Downloads/chosen",
  });
  assert.deepEqual(ipc.dialogs, [{ defaultName: "iPhone-2026.png", kind: "png" }]);
  await ipc.invoke("devices:recording-save", { id: "recording-0001" });
  assert.deepEqual(ipc.dialogs[1], { defaultName: "iPhone-2026.mp4", kind: "mp4" });

  ipc.destroy();
  assert.deepEqual(await ipc.invoke("devices:recording-save", { id: "recording-0001" }), { status: "cancelled" });

  const cancelled = harness({ dialog: null });
  assert.deepEqual(await cancelled.invoke("devices:screenshot-save", { hostId: "local", deviceId: UDID }), {
    status: "cancelled",
  });
});

test("only files saved from the Simulator tab can be revealed", async () => {
  const ipc = harness();
  await ipc.invoke("devices:reveal-saved", { path: "/Users/me/Downloads/shot.png" });
  await assert.rejects(ipc.invoke("devices:reveal-saved", { path: "/etc/passwd" }), /Only files saved/u);
  await assert.rejects(ipc.invoke("devices:reveal-saved", null), /Invalid simulator request/u);
  assert.deepEqual(ipc.revealed, ["/Users/me/Downloads/shot.png"]);
});

test("recording changes reach subscribed documents until they are invalidated", async () => {
  const ipc = harness();
  assert.deepEqual(await ipc.invoke("devices:recordings-list"), [RECORDING]);
  ipc.publish([{ ...RECORDING, status: "stopping" }]);
  assert.deepEqual(ipc.sent, [["devices:recordings", [{ ...RECORDING, status: "stopping" }]]]);
  ipc.invalidate();
  ipc.publish([]);
  assert.equal(ipc.sent.length, 1);
});
