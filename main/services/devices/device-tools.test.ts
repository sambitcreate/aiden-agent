import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
  deviceToolRequiresApproval,
  isDeviceToolName,
  pickDevice,
  pngDimensions,
  shellQuote,
  type DeviceToolPort,
} from "./device-tools.js";
import { buildSystemPrompt } from "../chat-system-prompt.js";

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
    reveal: (chatId, target) => calls.push(target ? `reveal:${chatId}:${target.hostId}:${target.deviceId}` : `reveal:${chatId}`),
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
  assert.match(deviceToolApprovalSummary("device_open", { deviceId: "UDID-1" }), /Open simulator UDID-1/u);
  assert.match(deviceToolApprovalSummary("device_close", { deviceId: "UDID-1", shutdown: true }), /shut it down/u);
  assert.match(deviceToolApprovalSummary("device_close", {}), /keeps running/u);
});

test("the system prompt prefers device tools but leaves shell simulator tooling open for builds and diagnostics", async () => {
  const withDevices = await buildSystemPrompt("/repo", "main", "full", false, false, undefined, new Set(["device_open", "shell"]));
  const withoutDevices = await buildSystemPrompt("/repo", "main", "full", false, false, undefined, new Set(["shell"]));
  assert.doesNotMatch(withoutDevices, /simctl|device_open/u);
  // Interaction with the device the user sees goes through the device tools first.
  assert.match(withDevices, /Prefer the device tools and agent-device for anything on the device the user is watching/u);
  // Nothing forbids the shell simulator tooling any more.
  assert.doesNotMatch(withDevices, /(do not|don't|never) (call|use|run) (simctl|xcrun|adb)/iu);
  // Each shell escape hatch and each non-interaction purpose is named.
  for (const tool of ["xcrun simctl", "xcodebuild", "adb"]) assert.ok(withDevices.includes(tool), tool);
  for (const purpose of ["builds", "installs", "logs", "port forwarding", "diagnostics"]) {
    assert.ok(withDevices.includes(purpose), purpose);
  }
  // The shell escape hatch never extends to tearing down the watched device, even before device_open.
  assert.match(
    withDevices,
    /Never shut down or erase a simulator or emulator the user is watching, or stop serve-sim or serve-emu, unless the user asks/u,
  );
  // Android Emulators are named alongside iOS Simulators, so agents reach for the same tools.
  assert.match(withDevices, /iOS Simulator and Android Emulator work use the device tools/u);
});

test("device_open's quick start allows simctl for gaps without letting the agent tear down the watched device", () => {
  const text = agentDeviceQuickStart(IPHONE, agentDeviceTargetArgs(IPHONE));
  assert.match(text, /Prefer agent-device for taps, typing, and screenshots on this device/u);
  assert.match(text, /xcrun simctl is fine for builds, installs, logs, and diagnostics/u);
  assert.doesNotMatch(text, /(do not|don't|never) (call|use|run) (simctl|xcrun)/iu);
  assert.match(text, /do not shut down or erase this device or stop serve-sim/u);
});

test("quick start pins every command and quotes unsafe values", () => {
  assert.equal(shellQuote("/data/bin/agent-device"), "/data/bin/agent-device");
  assert.equal(shellQuote("/Library/Application Support/it's"), `'/Library/Application Support/it'"'"'s'`);
  // Reproduce the CI session whose hexadecimal identity contains "adb".
  const target = [...agentDeviceTargetArgs(IPHONE), "--session", "aiden-18ddf9eadb8b3922a2612d23"];
  assert.deepEqual(target.slice(0, 4), ["--platform", "ios", "--udid", "UDID-1"]);
  const text = agentDeviceQuickStart(IPHONE, target, "/Users/me/Library/Application Support/Aiden/agent-device");
  assert.match(text, /watching iPhone 17 Pro \(iOS 27\.0\) in the Simulator tab/u);
  assert.match(text, /'\/Users\/me\/Library\/Application Support\/Aiden\/agent-device' snapshot -i --platform ios --udid UDID-1 --session aiden-18ddf9eadb8b3922a2612d23/u);
  assert.match(text, /XCTest runner/u);
  assert.doesNotMatch(text, /\b(?:adb|android|T3)\b/iu);
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
  assert.throws(() => pickDevice([], {}), /No simulators or emulators were found/u);
});

const EMULATOR: DeviceSummary = {
  hostId: "local",
  id: "emulator-5554",
  name: "Pixel_9_API_35",
  platform: "android",
  version: "Android 15.0",
  booted: true,
  kind: "other",
};
const AVD: DeviceSummary = { ...EMULATOR, id: "Pixel_Fold_API_35", name: "Pixel_Fold_API_35", booted: false };

test("pickDevice needs a platform when both are listed and no id is given", () => {
  assert.throws(() => pickDevice([IPHONE, EMULATOR], {}), /Both iOS and Android devices are available; pass platform or deviceId/u);
  assert.equal(pickDevice([IPHONE, AVD, EMULATOR], { platform: "android" }).id, "emulator-5554");
  assert.equal(pickDevice([IPHONE, EMULATOR], { platform: "ios" }).id, "UDID-1");
  assert.equal(pickDevice([IPHONE, AVD], { deviceId: "Pixel_Fold_API_35" }).id, "Pixel_Fold_API_35");
  assert.throws(() => pickDevice([IPHONE], { platform: "android" }), /No Android devices were found on host local/u);
});

test("Android devices are pinned by serial and get adb guidance, not simctl", () => {
  assert.deepEqual(agentDeviceTargetArgs(EMULATOR), ["--platform", "android", "--serial", "emulator-5554"]);
  const target = [...agentDeviceTargetArgs(EMULATOR), "--config", "/c.json", "--session", "aiden-1"];
  const text = agentDeviceQuickStart(EMULATOR, target);
  assert.match(text, /watching Pixel_9_API_35 \(Android 15\.0\) in the Simulator tab/u);
  assert.match(text, /agent-device snapshot -i --platform android --serial emulator-5554 --config \/c\.json/u);
  assert.match(text, /<path-to-\.apk>/u);
  assert.match(text, /adb is fine for builds, installs, logs, port forwarding/u);
  assert.match(text, /do not shut down or wipe this emulator or stop serve-emu/u);
  assert.doesNotMatch(text, /simctl|XCTest/u);
});

test("device_open on an Android AVD returns the booted serial and Android target args", async () => {
  const { port, calls } = fakePort({ devices: [IPHONE, AVD] });
  // Booting an AVD changes its id to the emulator serial, as the device service reports.
  port.open = async (input) => {
    calls.push(`open:${input.deviceId}`);
    const session: DeviceSession = { chatId: input.chatId, hostId: input.hostId, deviceId: "emulator-5556", openedBy: "agent" };
    const booted = { ...AVD, id: "emulator-5556", booted: true };
    const current = port.state();
    const next = { ...current, devices: [IPHONE, booted], sessions: [...current.sessions, session] };
    port.state = () => next;
    return session;
  };
  const run = tools(port);
  await assert.rejects(run("device_open"), /pass platform or deviceId/u);
  const result = json(await run("device_open", { platform: "android" }));
  assert.deepEqual(result.device, {
    hostId: "local",
    id: "emulator-5556",
    name: "Pixel_Fold_API_35",
    platform: "android",
    version: "Android 15.0",
    booted: true,
  });
  const agent = result.agentDevice as { targetArgs: string[] };
  assert.deepEqual(agent.targetArgs.slice(0, 4), ["--platform", "android", "--serial", "emulator-5556"]);
  assert.match(String(result.quickStart), /--serial emulator-5556/u);
  assert.ok(calls.includes("open:Pixel_Fold_API_35"));
});

test("device_list reports each platform's availability and every device's platform", async () => {
  const { port } = fakePort({
    devices: [IPHONE, EMULATOR],
    hosts: [
      {
        id: "local",
        kind: "local",
        name: "This Mac",
        status: "ready",
        platforms: [
          { platform: "ios", available: true },
          { platform: "android", available: false, reason: "Android SDK not found." },
        ],
      },
    ],
  });
  const listed = json(await tools(port)("device_list"));
  assert.deepEqual(listed.platforms, [
    { platform: "ios", available: true },
    { platform: "android", available: false, reason: "Android SDK not found." },
  ]);
  assert.deepEqual(
    (listed.devices as { id: string; platform: string }[]).map((device) => [device.id, device.platform]),
    [
      ["UDID-1", "ios"],
      ["emulator-5554", "android"],
    ],
  );
});

test("device_open resolves agent access before booting, then reveals that device", async () => {
  const { port, calls } = fakePort();
  const run = tools(port);
  const result = json(await run("device_open", { deviceId: "UDID-1" }));
  assert.deepEqual(calls, ["agentTarget:chat-1:UDID-1", "open:chat-1:UDID-1:agent", "reveal:chat-1:local:UDID-1"]);
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
    await writeFile(
      entryPath,
      "const { AGENT_DEVICE_CONFIG: config = null, AGENT_DEVICE_DAEMON_AUTH_TOKEN: token = null } = process.env;\n" +
        "console.log(JSON.stringify({ args: process.argv.slice(2), config, token }));\n",
    );
    const { shimDir, command } = await ensureAgentDeviceShim({ baseDir, nodePath: process.execPath, entryPath });
    assert.equal(shimDir, path.join(baseDir, "bin"));
    assert.equal((await stat(command)).mode & 0o777, 0o755);

    const refused = spawnSync(command, ["snapshot", "-i"], { encoding: "utf8" });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Call device_open first/u);
    const leaky = { ...process.env, AGENT_DEVICE_CONFIG: "user.json", AGENT_DEVICE_DAEMON_AUTH_TOKEN: "leak" };
    for (const args of [["--help"], ["-h"], ["help"], ["help", "workflows"], ["click", "--help"], ["snapshot", "-h"], ["--version"]]) {
      const help = spawnSync(command, args, { encoding: "utf8", env: leaky });
      assert.equal(help.status, 0, `${args.join(" ")} is informational`);
      assert.deepEqual(JSON.parse(help.stdout), { args, config: null, token: null });
    }
    // Only agent-device's help fast paths pass: a help flag after `--`, to cdp, or among other args can drive a device.
    for (const args of [
      ["version", "snapshot"],
      ["type", "--", "-h"],
      ["fill", "@e1", "--", "--help"],
      ["click", "@e3", "-h"],
      ["cdp", "heap", "-h"],
    ]) {
      const refusedHelp = spawnSync(command, args, { encoding: "utf8" });
      assert.equal(refusedHelp.status, 1, `${args.join(" ")} needs device_open's flags`);
      assert.match(refusedHelp.stderr, /Call device_open first/u);
    }
    const pinned = spawnSync(command, ["click", "@e3", "--config", "c.json", "--session", "aiden-1"], {
      encoding: "utf8",
      env: leaky,
    });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.deepEqual(JSON.parse(pinned.stdout), {
      args: ["click", "@e3", "--config", "c.json", "--session", "aiden-1"],
      config: null,
      token: null,
    });
    assert.match(agentDeviceLauncherSource("/node", "/entry"), /delete env\.AGENT_DEVICE_DAEMON_AUTH_TOKEN/u);

    const config = agentDeviceConfigPath(baseDir, "local");
    await writeAgentDeviceConfig(config, { baseUrl: "http://127.0.0.1:1", token: "t", entryPath });
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    assert.match(agentDeviceSession("chat-1", "local", "UDID-1"), /^aiden-[0-9a-f]{24}$/u);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("device_screenshot saveTo writes only inside the workspace or Downloads, and asks first under ask", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "aiden-device-save-")));
  const workspace = path.join(base, "workspace");
  const downloads = path.join(base, "Downloads");
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(downloads, { recursive: true });
    const { port, calls } = fakePort({ sessions: [{ chatId: "chat-1", hostId: "local", deviceId: "UDID-2", openedBy: "agent" }] });
    const list = createDeviceAgentTools({
      chatId: "chat-1",
      signal: new AbortController().signal,
      supportsImages: true,
      port,
      saveRoots: () => ({ workspace, downloads }),
    });
    const shoot = (args: Record<string, unknown>) =>
      list.find((tool) => tool.name === "device_screenshot")!.execute("call", args as never);

    const saved = json(await shoot({ saveTo: "shots/home.png" }));
    assert.equal(saved.savedTo, path.join(workspace, "shots", "home.png"));
    assert.deepEqual(await readFile(path.join(workspace, "shots", "home.png")), PNG);

    // A folder in Downloads gets a dated default name.
    const dated = json(await shoot({ saveTo: `${downloads}/` }));
    assert.match(path.basename(String(dated.savedTo)), /^iPhone-Air-\d{4}-\d{2}-\d{2}-\d{6}\.png$/u);
    assert.equal(path.dirname(String(dated.savedTo)), downloads);

    const before = calls.length;
    await assert.rejects(shoot({ saveTo: "../escape.png" }), /outside the allowed folders/u);
    await assert.rejects(shoot({ saveTo: "/etc/x.png" }), /outside the allowed folders/u);
    assert.equal(calls.length, before, "a refused path never takes a screenshot");

    // Without saveTo nothing is written and no approval is needed.
    assert.equal(json(await shoot({})).savedTo, undefined);
    assert.equal(deviceToolRequiresApproval("device_screenshot", {}), false);
    assert.equal(deviceToolRequiresApproval("device_screenshot", { saveTo: "a.png" }), true);
    assert.equal(deviceToolRequiresApproval("device_open", {}), true);
    assert.equal(deviceToolRequiresApproval("device_list", { saveTo: "a.png" }), false);
    assert.match(
      deviceToolApprovalSummary("device_screenshot", { saveTo: "shots/a.png" }),
      /Save a screenshot .* to shots\/a\.png/u,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("device_screenshot saveTo is refused when the chat has no save folders", async () => {
  const { port } = fakePort({ sessions: [{ chatId: "chat-1", hostId: "local", deviceId: "UDID-2", openedBy: "agent" }] });
  await assert.rejects(tools(port)("device_screenshot", { saveTo: "/tmp/x.png" }), /cannot be saved to a file/u);
});

test("agents see connected SSH hosts' simulators but never paired Macs or disconnected SSH hosts", async () => {
  const remote: DeviceSummary = { ...IPHONE, hostId: "ssh-mini01", id: "REMOTE-1", name: "Remote iPhone" };
  const offline: DeviceSummary = { ...IPHONE, hostId: "ssh-studio", id: "REMOTE-2" };
  const paired: DeviceSummary = { ...IPHONE, hostId: "peer-1", id: "PEER-1" };
  const { port, calls } = fakePort({
    hosts: [
      { id: "local", kind: "local", name: "This Mac", status: "ready" },
      { id: "peer-1", kind: "peer", name: "Studio Mac", status: "ready" },
      { id: "ssh-mini01", kind: "ssh", name: "Mac mini", status: "ready" },
      { id: "ssh-studio", kind: "ssh", name: "Studio", status: "stopped" },
    ],
    devices: [IPHONE, remote, offline, paired],
  });
  const call = tools(port);
  const listed = json(await call("device_list"));
  assert.deepEqual(
    (listed.devices as Array<{ hostId: string; id: string }>).map((device) => `${device.hostId}/${device.id}`),
    ["local/UDID-1", "ssh-mini01/REMOTE-1"],
  );
  assert.deepEqual(
    (listed.hosts as Array<{ id: string }>).map((host) => host.id),
    ["local", "ssh-mini01"],
  );
  const opened = json(await call("device_open", { hostId: "ssh-mini01", deviceId: "REMOTE-1" }));
  assert.equal((opened.device as { hostId: string }).hostId, "ssh-mini01");
  assert.ok(calls.includes("agentTarget:chat-1:REMOTE-1"));
  await assert.rejects(call("device_open", { hostId: "peer-1", deviceId: "PEER-1" }), /No device PEER-1 on host peer-1/u);
  await assert.rejects(call("device_open", { hostId: "ssh-studio", deviceId: "REMOTE-2" }), /No device REMOTE-2/u);
  // Listing refreshes this Mac only; SSH hosts are connected by the user, never by the tools.
  assert.deepEqual(calls.filter((entry) => entry === "refresh"), ["refresh"]);
});
