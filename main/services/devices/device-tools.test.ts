import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DeviceServiceState, DeviceSession, DeviceSummary } from "../../../renderer/shared/devices.js";
import {
  agentDeviceConfigPath,
  agentDeviceLauncherSource,
  agentDeviceSession,
  ensureAgentDeviceShim,
  writeAgentDeviceConfig,
} from "./agent-device-shim.js";
import {
  DEVICE_AGENT_GUIDANCE,
  DEVICE_APPROVAL_TOOL_NAMES,
  DEVICE_TOOL_NAMES,
  agentDeviceQuickStart,
  agentDeviceTargetArgs,
  canUseDeviceTools,
  createDeviceAgentTools,
  deviceToolApprovalSummary,
  isDeviceToolName,
  pickDevice,
  pngDimensions,
  shellQuote,
  type DeviceToolPort,
} from "./device-tools.js";

const IPHONE: DeviceSummary = {
  hostId: "local",
  id: "UDID-1",
  name: "iPhone 17 Pro",
  platform: "ios",
  version: "iOS 27.0",
  booted: false,
  kind: "iphone",
};
const BOOTED: DeviceSummary = { ...IPHONE, id: "UDID-2", name: "iPhone Air", booted: true };

/** A 2×3 PNG header: signature plus IHDR. */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3,
]);

function fakePort(initial: Partial<DeviceServiceState> = {}) {
  let state: DeviceServiceState = {
    hostStatus: "ready",
    hostStatuses: { local: { status: "ready" } },
    hosts: [{ id: "local", kind: "local", name: "This Mac", status: "ready" }],
    consent: { streaming: true, agentAccess: true, peerSharing: false },
    devices: [IPHONE, BOOTED],
    sessions: [],
    toolVersions: { hub: "0.12.0", agent: "0.21.12" },
    ...initial,
  };
  const calls: string[] = [];
  const port: DeviceToolPort = {
    refreshLocal: async () => {
      calls.push("refresh");
      return state;
    },
    state: () => state,
    open: async (input) => {
      calls.push(`open:${input.chatId}:${input.deviceId}:${input.openedBy}`);
      const session: DeviceSession = { chatId: input.chatId, hostId: input.hostId, deviceId: input.deviceId, openedBy: "agent" };
      state = {
        ...state,
        sessions: [...state.sessions, session],
        devices: state.devices.map((device) => (device.id === input.deviceId ? { ...device, booted: true } : device)),
      };
      return session;
    },
    close: async (input) => {
      calls.push(`close:${input.deviceId}:${input.shutdown === true}`);
      state = { ...state, sessions: state.sessions.filter((session) => session.deviceId !== input.deviceId) };
    },
    screenshot: async (input) => {
      calls.push(`screenshot:${input.deviceId}`);
      return PNG;
    },
    agentTarget: async (input) => {
      calls.push(`agentTarget:${input.chatId}:${input.deviceId}`);
      return { command: "/data/devices/bin/agent-device", args: ["--config", "/data/devices/hosts/x.json", "--session", "aiden-abc"] };
    },
    reveal: (chatId) => calls.push(`reveal:${chatId}`),
  };
  return { port, calls };
}

function tools(port: DeviceToolPort, extra: { supportsImages?: boolean; screenshotDir?: () => Promise<string> } = {}) {
  const list = createDeviceAgentTools({
    chatId: "chat-1",
    signal: new AbortController().signal,
    supportsImages: extra.supportsImages ?? true,
    port,
    ...(extra.screenshotDir ? { screenshotDir: extra.screenshotDir } : {}),
  });
  return (name: string, args: Record<string, unknown> = {}) => {
    const tool = list.find((candidate) => candidate.name === name);
    assert.ok(tool, name);
    return tool.execute(`call-${name}`, args as never);
  };
}

const json = (result: { content: readonly { type: string; text?: string }[] }) =>
  JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

test("the gate needs the flag, agent access, an interactive owner, and a tool permission", () => {
  const base = { enabled: true, agentAccess: true, permission: "ask", rendererOwner: true, assistantMode: false, bot: false };
  assert.equal(canUseDeviceTools(base), true);
  assert.equal(canUseDeviceTools({ ...base, permission: "full" }), true);
  for (const change of [
    { enabled: false },
    { agentAccess: false, peerSharing: false },
    { permission: "none" },
    { permission: "read" },
    { rendererOwner: false },
    { assistantMode: true },
    { bot: true },
  ]) {
    assert.equal(canUseDeviceTools({ ...base, ...change }), false, JSON.stringify(change));
  }
});

test("names, approvals, and the always-on guidance stay small", () => {
  assert.deepEqual([...DEVICE_TOOL_NAMES], ["device_list", "device_open", "device_screenshot", "device_close"]);
  assert.deepEqual([...DEVICE_APPROVAL_TOOL_NAMES].sort(), ["device_close", "device_open"]);
  assert.equal(isDeviceToolName("device_open"), true);
  assert.equal(isDeviceToolName("browser_open"), false);
  assert.ok(DEVICE_AGENT_GUIDANCE.split("\n").length <= 5);
  assert.match(DEVICE_AGENT_GUIDANCE, /Do not call simctl, xcrun, or serve-sim/u);
  assert.match(deviceToolApprovalSummary("device_open", { deviceId: "UDID-1" }), /Open simulator UDID-1/u);
  assert.match(deviceToolApprovalSummary("device_close", { deviceId: "UDID-1", shutdown: true }), /shut it down/u);
  assert.match(deviceToolApprovalSummary("device_close", {}), /keeps running/u);
});

test("quick start pins every command and quotes unsafe values", () => {
  assert.equal(shellQuote("/data/bin/agent-device"), "/data/bin/agent-device");
  assert.equal(shellQuote("/Library/Application Support/it's"), `'/Library/Application Support/it'"'"'s'`);
  const target = [...agentDeviceTargetArgs(IPHONE), "--session", "aiden-abc"];
  assert.deepEqual(target.slice(0, 4), ["--platform", "ios", "--udid", "UDID-1"]);
  const text = agentDeviceQuickStart(IPHONE, target, "/Users/me/Library/Application Support/Aiden/agent-device");
  assert.match(text, /watching iPhone 17 Pro \(iOS 27\.0\) in the Simulator tab/u);
  assert.match(text, /'\/Users\/me\/Library\/Application Support\/Aiden\/agent-device' snapshot -i --platform ios --udid UDID-1 --session aiden-abc/u);
  assert.match(text, /XCTest runner/u);
  assert.doesNotMatch(text, /adb|Android|T3/u);
});

test("pngDimensions reads IHDR and rejects anything else", () => {
  assert.deepEqual(pngDimensions(PNG), { width: 2, height: 3 });
  assert.deepEqual(pngDimensions(Buffer.from("not a png at all, clearly")), { width: 0, height: 0 });
  assert.deepEqual(pngDimensions(Buffer.alloc(4)), { width: 0, height: 0 });
});

test("pickDevice honours an explicit id, else prefers a booted simulator", () => {
  assert.equal(pickDevice([IPHONE, BOOTED], {}).id, "UDID-2");
  assert.equal(pickDevice([IPHONE], {}).id, "UDID-1");
  assert.equal(pickDevice([IPHONE, BOOTED], { deviceId: "UDID-1" }).id, "UDID-1");
  assert.throws(() => pickDevice([IPHONE], { deviceId: "nope" }), /No device nope on host local/u);
  assert.throws(() => pickDevice([], {}), /No simulators were found/u);
});

test("device_open resolves agent access before booting, then reveals the tab", async () => {
  const { port, calls } = fakePort();
  const run = tools(port);
  const result = json(await run("device_open", { deviceId: "UDID-1" }));
  assert.deepEqual(calls, ["agentTarget:chat-1:UDID-1", "open:chat-1:UDID-1:agent", "reveal:chat-1"]);
  const agent = result.agentDevice as { command: string; targetArgs: string[] };
  assert.equal(agent.command, "/data/devices/bin/agent-device");
  assert.deepEqual(agent.targetArgs, [
    "--platform", "ios", "--udid", "UDID-1", "--config", "/data/devices/hosts/x.json", "--session", "aiden-abc",
  ]);
  assert.equal((result.device as { booted: boolean }).booted, true);
  assert.match(String(result.quickStart), /Simulator tab/u);

  const listed = json(await run("device_list"));
  assert.deepEqual(listed.open, [{ hostId: "local", deviceId: "UDID-1" }]);
  assert.equal((listed.devices as unknown[]).length, 2);
});

test("screenshot and close target this chat's latest session", async () => {
  const { port, calls } = fakePort({
    sessions: [
      { chatId: "chat-other", hostId: "local", deviceId: "UDID-1", openedBy: "user" },
      { chatId: "chat-1", hostId: "local", deviceId: "UDID-2", openedBy: "user" },
    ],
  });
  const run = tools(port);
  const shot = await run("device_screenshot");
  assert.deepEqual(json(shot), { device: { hostId: "local", deviceId: "UDID-2", name: "iPhone Air" }, width: 2, height: 3 });
  assert.deepEqual(shot.content[1], { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
  await assert.rejects(run("device_screenshot", { deviceId: "UDID-1" }), /not open in this chat/u);
  assert.deepEqual(json(await run("device_close", { shutdown: true })), {
    closed: { hostId: "local", deviceId: "UDID-2" },
    shutdown: true,
  });
  assert.deepEqual(calls, ["screenshot:UDID-2", "close:UDID-2:true"]);
  await assert.rejects(run("device_screenshot"), /No device is open in this chat/u);
});

test("models without vision get a saved screenshot path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-device-tools-"));
  try {
    const { port } = fakePort({ sessions: [{ chatId: "chat-1", hostId: "local", deviceId: "UDID-2", openedBy: "agent" }] });
    const result = await tools(port, { supportsImages: false, screenshotDir: async () => directory })("device_screenshot");
    assert.equal(result.content.length, 1);
    const saved = json(result);
    assert.equal(path.dirname(String(saved.path)), directory);
    assert.deepEqual(await readFile(String(saved.path)), PNG);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tools refuse when streaming or agent access is off, and reject unknown arguments", async () => {
  const off = tools(fakePort({ hostStatus: "needs-consent", consent: { streaming: false, agentAccess: false, peerSharing: false } }).port);
  await assert.rejects(off("device_list"), /Device support is off/u);
  const noAgent = tools(fakePort({ consent: { streaming: true, agentAccess: false, peerSharing: false } }).port);
  await assert.rejects(noAgent("device_open"), /Agent access to simulators is off/u);
  await assert.rejects(tools(fakePort().port)("device_open", { chatId: "other" }));
  await assert.rejects(tools(fakePort().port)("device_open", { deviceId: "../../etc" }));
});

test("a cancelled generation stops before touching the device", async () => {
  const controller = new AbortController();
  const { port, calls } = fakePort();
  const [, open] = createDeviceAgentTools({ chatId: "chat-1", signal: controller.signal, supportsImages: true, port });
  controller.abort(new Error("stopped"));
  await assert.rejects(open!.execute("call", {} as never), /stopped/u);
  assert.deepEqual(calls, []);
});

test("a generation stopped while the simulator boots closes the new session and never reveals it", async () => {
  for (const alreadyOpen of [false, true]) {
    const controller = new AbortController();
    const { port, calls } = fakePort(
      alreadyOpen ? { sessions: [{ chatId: "chat-1", hostId: "local", deviceId: BOOTED.id, openedBy: "user" }] } : {},
    );
    const open = port.open;
    port.open = async (input) => {
      const session = await open(input);
      controller.abort(new Error("stopped"));
      return session;
    };
    const [, deviceOpen] = createDeviceAgentTools({ chatId: "chat-1", signal: controller.signal, supportsImages: true, port });
    await assert.rejects(deviceOpen!.execute("call", {} as never), /stopped/u);
    assert.ok(!calls.some((call) => call.startsWith("reveal:")));
    // A session the user already had stays open; one this call created is closed without shutdown.
    assert.equal(calls.includes(`close:${BOOTED.id}:false`), !alreadyOpen);
  }
});

test("the shim runs the pinned install and refuses commands without device_open's flags", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "aiden-agent-shim-"));
  try {
    const entryPath = path.join(baseDir, "fake-agent-device.mjs");
    await writeFile(entryPath, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const { shimDir, command } = await ensureAgentDeviceShim({ baseDir, nodePath: process.execPath, entryPath });
    assert.equal(shimDir, path.join(baseDir, "bin"));
    assert.equal((await stat(command)).mode & 0o777, 0o755);

    const refused = spawnSync(command, ["snapshot", "-i"], { encoding: "utf8" });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Call device_open first/u);
    const help = spawnSync(command, ["--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    const pinned = spawnSync(command, ["click", "@e3", "--config", "c.json", "--session", "aiden-1"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_DEVICE_DAEMON_AUTH_TOKEN: "leak" },
    });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.deepEqual(JSON.parse(pinned.stdout), ["click", "@e3", "--config", "c.json", "--session", "aiden-1"]);
    assert.match(agentDeviceLauncherSource("/node", "/entry"), /delete env\.AGENT_DEVICE_DAEMON_AUTH_TOKEN/u);

    const config = agentDeviceConfigPath(baseDir, "local");
    await writeAgentDeviceConfig(config, { baseUrl: "http://127.0.0.1:1", token: "t", entryPath });
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    assert.match(agentDeviceSession("chat-1", "local", "UDID-1"), /^aiden-[0-9a-f]{24}$/u);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
