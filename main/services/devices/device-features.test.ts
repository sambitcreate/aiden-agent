import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceFeatureTarget } from "../../../renderer/shared/device-features.js";
import type { DeviceServiceState, DeviceSummary } from "../../../renderer/shared/devices.js";
import type { DeviceCommandOptions, DeviceHostReady } from "./device-host.js";
import { createDeviceFeatures, type DeviceFeaturePort } from "./device-features.js";
import { createDeviceRecorder, type RecorderChild } from "./device-recording.js";

const UDID = "5C1E4B7A-0000-4000-8000-000000000001";
const TARGET: DeviceFeatureTarget = { platform: "ios", hostId: "local", deviceId: UDID };

class Child implements RecorderChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  private listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  constructor(private readonly finalize: () => void) {}
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    this.finalize();
    queueMicrotask(() => {
      this.exitCode = 0;
      for (const listener of this.listeners.splice(0)) listener(0, null);
    });
    return true;
  }
  once(_event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
    this.listeners.push(listener);
    return this;
  }
}

function harness(options: { booted?: boolean; hostText?: string; hostFormats?: string[] } = {}) {
  const device: DeviceSummary = {
    hostId: "local",
    id: UDID,
    name: "iPhone 17 Pro",
    platform: "ios",
    version: "iOS 27.0",
    booted: options.booted ?? true,
    kind: "iphone",
  };
  let state: DeviceServiceState = {
    hostStatus: "ready",
    hostStatuses: { local: { status: "ready" } },
    hosts: [{ id: "local", kind: "local", name: "This Mac", status: "ready" }],
    consent: { streaming: true, agentAccess: false, peerSharing: false },
    devices: [device],
    sessions: [],
    toolVersions: { hub: "0.12.0", agent: "0.21.12" },
  };
  const stateListeners = new Set<(state: DeviceServiceState) => void>();
  const commands: Array<{ args: readonly string[]; options?: DeviceCommandOptions }> = [];
  const events: string[] = [];
  const run: DeviceHostReady["run"] = async (_command, args, commandOptions) => {
    commands.push({ args, ...(commandOptions ? { options: commandOptions } : {}) });
    events.push(`run:${args[1]}`);
    return { stdout: args[1] === "pbpaste" ? "from device" : "", stderr: "", code: 0 };
  };
  const ready = { nodePath: "/node", hub: { origin: "http://127.0.0.1:1" }, helpers: { axSettings: null, serveSimCli: null }, run };
  const setState = (next: Partial<DeviceServiceState>) => {
    state = { ...state, ...next };
    for (const listener of stateListeners) listener(state);
  };
  const service: DeviceFeaturePort = {
    async localTarget(input) {
      if (input.hostId !== "local") throw new Error("This works only with simulators on this Mac.");
      const found = state.devices.find((candidate) => candidate.id === input.deviceId);
      if (!found) throw new Error("That simulator is no longer available.");
      if (input.booted && !found.booted) throw new Error("Open the simulator first.");
      return { ready, device: found };
    },
    async refreshLocal() {
      events.push("refresh");
      return state;
    },
    state: () => state,
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    async screenshot() {
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    },
    async shutdownLocal() {
      throw new Error("iOS erase shuts down with simctl itself");
    },
  };
  const files = new Map<string, Uint8Array | string>();
  const children: Child[] = [];
  let ids = 0;
  const recorder = createDeviceRecorder({
    spawn: (_command, args) => {
      const file = args[args.length - 1]!;
      const child = new Child(() => files.set(file, "mp4"));
      children.push(child);
      return child;
    },
    tempDir: async () => "/private/recordings",
    fileSize: async (file) => (files.has(file) ? 3 : null),
    removeFile: async (file) => {
      files.delete(file);
    },
    newId: () => `recording-${String(++ids).padStart(4, "0")}`,
    now: () => Date.UTC(2026, 9, 8, 12),
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
  });
  const host = { text: options.hostText ?? "hello", formats: options.hostFormats ?? ["text/plain"], written: [] as string[] };
  const features = createDeviceFeatures({
    service,
    recorder,
    clipboard: {
      readText: () => host.text,
      availableFormats: () => host.formats,
      writeText: (text) => host.written.push(text),
    },
    moveFile: async (from, to) => {
      const bytes = files.get(from);
      if (bytes === undefined) throw new Error("missing temp file");
      files.delete(from);
      files.set(to, bytes);
    },
    removeFile: async (file) => {
      files.delete(file);
    },
    writeFile: async (file, bytes) => {
      files.set(file, bytes);
    },
    now: () => new Date(2026, 9, 8, 9, 30, 0),
    fetch: async () => {
      throw new Error("iOS features never call the hub");
    },
    sleep: async () => undefined,
  });
  return { features, commands, events, files, children, host, setState, device };
}

const settle = async () => {
  for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
};

test("erase stops the simulator's recordings, shuts it down, erases it, and refreshes the listing", async () => {
  const h = harness();
  const recording = await h.features.startRecording("chat-1", TARGET);
  const result = await h.features.erase(TARGET);
  assert.deepEqual(result, { wasBooted: true, deviceId: UDID });
  assert.deepEqual(h.children[0]!.signals, ["SIGINT"]);
  assert.equal(h.features.recordings().find((info) => info.id === recording.id), undefined);
  assert.deepEqual(h.events, ["run:shutdown", "run:erase", "refresh"]);
});

test("a simulator labelled Android is refused before its recording ends or any command runs", async () => {
  const h = harness();
  const recording = await h.features.startRecording("chat-1", TARGET);
  const mislabelled = { ...TARGET, platform: "android" as const };
  await assert.rejects(h.features.erase(mislabelled), /no longer available/u);
  await assert.rejects(h.features.pasteFromHost(mislabelled), /no longer available/u);
  await assert.rejects(h.features.copyToHost(mislabelled), /no longer available/u);
  await assert.rejects(h.features.startRecording("chat-2", mislabelled), /no longer available/u);
  assert.equal(h.features.recordings().find((info) => info.id === recording.id)?.status, "recording");
  assert.deepEqual(h.children[0]!.signals, []);
  assert.deepEqual(h.events, []);
});

test("erase is refused for a simulator the listing does not have, and only for this Mac", async () => {
  const h = harness();
  await assert.rejects(h.features.erase({ ...TARGET, deviceId: "5C1E4B7A-0000-4000-8000-0000000000FF" }), /no longer available/u);
  await assert.rejects(h.features.erase({ ...TARGET, hostId: "peer-mac" }), /simulators on this Mac/u);
  assert.deepEqual(h.events, []);
});

test("paste sends host clipboard text over stdin and refuses non-text clipboards", async () => {
  const h = harness({ hostText: "héllo" });
  assert.deepEqual(await h.features.pasteFromHost(TARGET), { bytes: 6 });
  assert.deepEqual(h.commands[0]!.args, ["simctl", "pbcopy", UDID]);
  assert.equal(h.commands[0]!.options?.stdin, "héllo");

  const image = harness({ hostText: "", hostFormats: ["image/png"] });
  await assert.rejects(image.features.pasteFromHost(TARGET), /Only text can be pasted/u);
  const empty = harness({ hostText: "", hostFormats: [] });
  await assert.rejects(empty.features.pasteFromHost(TARGET), /has no text/u);
  assert.equal(image.commands.length + empty.commands.length, 0);

  const off = harness({ booted: false });
  await assert.rejects(off.features.pasteFromHost(TARGET), /Open the simulator first/u);
});

test("copy puts the simulator's text on the host clipboard", async () => {
  const h = harness();
  assert.deepEqual(await h.features.copyToHost(TARGET), { bytes: 11 });
  assert.deepEqual(h.host.written, ["from device"]);
});

test("a stopped recording is moved where the user chooses, with a dated default name", async () => {
  const h = harness();
  const recording = await h.features.startRecording("chat-1", TARGET);
  await assert.rejects(h.features.saveRecording(recording.id, async () => "/x.mp4"), /Stop the recording/u);
  assert.equal((await h.features.stopRecording(recording.id)).status, "ready");
  const offered: string[] = [];
  const saved = await h.features.saveRecording(recording.id, async (name) => {
    offered.push(name);
    return "/Users/me/Downloads/demo.mp4";
  });
  assert.deepEqual(saved, { status: "saved", path: "/Users/me/Downloads/demo.mp4" });
  assert.match(offered[0]!, /^iPhone-17-Pro-2026-10-08-\d{6}\.mp4$/u);
  assert.equal(h.files.get("/Users/me/Downloads/demo.mp4"), "mp4");
  assert.equal(h.files.has("/private/recordings/recording-0001.mp4"), false);
  assert.equal(h.features.isSavedPath("/Users/me/Downloads/demo.mp4"), true);
  assert.equal(h.features.isSavedPath("/etc/passwd"), false);
});

test("cancelling the save dialog deletes the recording", async () => {
  const h = harness();
  const recording = await h.features.startRecording("chat-1", TARGET);
  await h.features.stopRecording(recording.id);
  assert.deepEqual(await h.features.saveRecording(recording.id, async () => null), { status: "cancelled" });
  assert.equal(h.files.size, 0);
  assert.deepEqual(h.features.recordings(), []);
});

test("a simulator that shuts down, a deleted chat, and app quit each end recordings", async () => {
  const h = harness();
  await h.features.startRecording("chat-1", TARGET);
  h.setState({ devices: [{ ...h.device, booted: false }] });
  await settle();
  assert.deepEqual(h.children[0]!.signals, ["SIGINT"]);
  assert.deepEqual(h.features.recordings(), []);
  assert.equal(h.files.size, 0);

  h.setState({ devices: [h.device] });
  await h.features.startRecording("chat-2", TARGET);
  await h.features.discardForChat("chat-1");
  assert.equal(h.features.recordings().length, 1, "another chat's recording survives");
  await h.features.discardForChat("chat-2");
  assert.deepEqual(h.features.recordings(), []);

  await h.features.startRecording("chat-3", TARGET);
  await h.features.stop();
  assert.deepEqual(h.features.recordings(), []);
  assert.equal(h.files.size, 0);
});

test("screenshots save to the chosen file and can then be revealed", async () => {
  const h = harness();
  const offered: string[] = [];
  const saved = await h.features.saveScreenshot({ hostId: "local", deviceId: UDID }, async (name) => {
    offered.push(name);
    return "/Users/me/Downloads/shot.png";
  });
  assert.deepEqual(offered, ["iPhone-17-Pro-2026-10-08-093000.png"]);
  assert.deepEqual(saved, { status: "saved", path: "/Users/me/Downloads/shot.png" });
  assert.deepEqual([...(h.files.get("/Users/me/Downloads/shot.png") as Uint8Array)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(h.features.isSavedPath("/Users/me/Downloads/shot.png"), true);
  assert.deepEqual(await h.features.saveScreenshot({ hostId: "local", deviceId: UDID }, async () => null), {
    status: "cancelled",
  });
});

test("a framed 3D screenshot saves the renderer's image under a distinct name and can be revealed", async () => {
  const h = harness();
  const offered: string[] = [];
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const saved = await h.features.saveFramedScreenshot({ hostId: "local", deviceId: UDID }, png, async (name) => {
    offered.push(name);
    return "/Users/me/Downloads/framed.png";
  });
  assert.deepEqual(offered, ["iPhone-17-Pro-framed-2026-10-08-093000.png"]);
  assert.deepEqual(saved, { status: "saved", path: "/Users/me/Downloads/framed.png" });
  assert.deepEqual([...(h.files.get("/Users/me/Downloads/framed.png") as Uint8Array)], [...png]);
  assert.equal(h.features.isSavedPath("/Users/me/Downloads/framed.png"), true);
  assert.deepEqual(await h.features.saveFramedScreenshot({ hostId: "local", deviceId: UDID }, png, async () => null), {
    status: "cancelled",
  });
});
