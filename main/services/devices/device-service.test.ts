import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DeviceServiceState } from "../../../renderer/shared/devices.js";
import { DeviceHostUnavailableError, type DeviceHost, type DeviceHostReady } from "./device-host.js";
import type { DeviceHubProxy } from "./device-hub-proxy.js";
import { createDeviceService, parseSimctlDevices, type DeviceServiceDeps } from "./device-service.js";

const IPHONE = "5C1E4B7A-0000-4000-8000-000000000001";
const IPHONE_OLD = "5C1E4B7A-0000-4000-8000-000000000002";
const IPAD = "5C1E4B7A-0000-4000-8000-000000000003";

const SIMCTL_FIXTURE = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      {
        udid: IPHONE_OLD,
        name: "iPhone 17",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      },
      {
        udid: IPHONE,
        name: "iPhone 17 Pro",
        state: "Booted",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-27-1": [
      {
        udid: IPAD,
        name: "iPad Pro 13-inch (M5)",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5",
      },
      {
        udid: "UNAVAILABLE",
        name: "iPhone 16",
        state: "Shutdown",
        isAvailable: false,
        availabilityError: "runtime profile not found",
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-12-0": [
      { udid: "WATCH", name: "Apple Watch Ultra 3", state: "Shutdown", isAvailable: true },
    ],
    "com.apple.CoreSimulator.SimRuntime.xrOS-3-0": [
      { udid: "VISION", name: "Apple Vision Pro", state: "Shutdown", isAvailable: true },
    ],
  },
});

interface FakeHostOptions {
  installed?: boolean;
  unavailable?: string;
  listCode?: number;
  agentInstalled?: boolean;
  agentFails?: string;
}

function fakeHost(options: FakeHostOptions = {}) {
  const calls: string[] = [];
  const commands: string[][] = [];
  let ready: DeviceHostReady | null = null;
  const makeReady = (): DeviceHostReady => ({
    nodePath: "/Applications/Aiden Agent.app/Contents/MacOS/Aiden Agent",
    hub: { origin: "http://127.0.0.1:52000" },
    helpers: { axSettings: null, serveSimCli: null },
    run: async (command, args) => {
      commands.push([command, ...args]);
      if (args[1] === "list") return { stdout: SIMCTL_FIXTURE, stderr: "", code: options.listCode ?? 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  const host: DeviceHost = {
    id: "local",
    kind: "local",
    platformAvailability: async () => ({ platform: "ios", available: true }),
    hubInstalled: async () => options.installed ?? true,
    ensureReady: async (onPhase) => {
      calls.push("ensureReady");
      if (options.unavailable) throw new DeviceHostUnavailableError(options.unavailable);
      if (!(options.installed ?? true)) onPhase?.("installing", "expo-device-hub@0.12.0");
      onPhase?.("starting");
      ready = makeReady();
      return ready;
    },
    agentInstalled: async () => options.agentInstalled ?? true,
    ensureAgentReady: async (onPhase) => {
      calls.push("ensureAgentReady");
      if (options.agentFails) throw new Error(options.agentFails);
      onPhase?.("starting");
      ready ??= makeReady();
      return {
        ...ready,
        agentDevice: { baseUrl: "http://127.0.0.1:54000", token: "daemon-token", entryPath: "/pinned/agent-device/bin.js" },
      };
    },
    current: () => ready,
    onHealth: () => () => undefined,
    stopAgent: async () => {
      calls.push("stopAgent");
    },
    stop: async () => {
      calls.push("stop");
      ready = null;
    },
  };
  return { host, calls, commands };
}

interface HubCall {
  url: string;
  body: unknown;
}

function fakeFetch(options: { refuse?: string; screenshotType?: string } = {}) {
  const calls: HubCall[] = [];
  const fetch: DeviceServiceDeps["fetch"] = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const screenshot = url.endsWith("/screenshot");
    const payload = screenshot
      ? Buffer.from([0x89, 0x50, 0x4e, 0x47])
      : Buffer.from(
          JSON.stringify(
            options.refuse && url.endsWith(options.refuse) ? { ok: false, error: "boot failed" } : { ok: true },
          ),
        );
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name === "content-type" ? (screenshot ? (options.screenshotType ?? "image/png") : "application/json") : null,
      },
      arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    };
  };
  return { fetch, calls };
}

async function withService(
  run: (context: {
    baseDir: string;
    service: ReturnType<typeof createDeviceService>;
    host: ReturnType<typeof fakeHost>;
    hub: ReturnType<typeof fakeFetch>;
    states: DeviceServiceState[];
    proxyStarts: number[];
  }) => Promise<void>,
  options: FakeHostOptions & { consent?: object; refuse?: string; screenshotType?: string } = {},
) {
  const baseDir = await mkdtemp(path.join(tmpdir(), "aiden-devices-service-"));
  if (options.consent) await writeFile(path.join(baseDir, "consent.json"), JSON.stringify(options.consent));
  const host = fakeHost(options);
  const hub = fakeFetch(options);
  const proxyStarts: number[] = [];
  const service = createDeviceService({
    baseDir,
    host: host.host,
    fetch: hub.fetch,
    startProxy: async (resolveHub) => {
      proxyStarts.push(1);
      assert.equal(resolveHub("local"), "http://127.0.0.1:52000");
      assert.equal(resolveHub("remote"), null);
      return {
        origin: "http://127.0.0.1:53000",
        mintGrant: () => ({ origin: "http://127.0.0.1:53000", token: "T".repeat(43), expiresAt: 1 }),
        close: async () => undefined,
      } satisfies DeviceHubProxy;
    },
  });
  const states: DeviceServiceState[] = [];
  service.onState((state) => states.push(state));
  try {
    await run({ baseDir, service, host, hub, states, proxyStarts });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

test("simctl JSON yields available iOS simulators, booted first, with iPads classified", () => {
  const devices = parseSimctlDevices(SIMCTL_FIXTURE);
  assert.deepEqual(
    devices.map((device) => [device.id, device.version, device.kind, device.booted]),
    [
      [IPHONE, "iOS 27.0", "iphone", true],
      [IPAD, "iOS 27.1", "ipad", false],
      [IPHONE_OLD, "iOS 27.0", "iphone", false],
    ],
  );
  assert.ok(devices.every((device) => device.platform === "ios" && device.hostId === "local"));
  assert.deepEqual(parseSimctlDevices("not json"), []);
  assert.deepEqual(parseSimctlDevices("{}"), []);
});

test("loading never starts or installs anything", async () => {
  await withService(async ({ service, host }) => {
    const state = await service.load();
    assert.equal(state.hostStatus, "needs-consent");
    assert.deepEqual(state.consent, { streaming: false, agentAccess: false });
    assert.deepEqual(state.toolVersions, { hub: "0.12.0", agent: "0.21.12" });
    assert.equal((await service.refresh()).hostStatus, "needs-consent");
    assert.deepEqual(host.calls, []);
  });
  await withService(
    async ({ service, host }) => {
      assert.equal((await service.load()).hostStatus, "stopped");
      assert.deepEqual(host.calls, []);
    },
    { consent: { streaming: true } },
  );
});

test("streaming consent persists, installs, starts, and lists simulators", async () => {
  await withService(
    async ({ baseDir, service, states }) => {
      const state = await service.grantConsent("streaming");
      assert.equal(state.hostStatus, "ready");
      assert.equal(state.devices.length, 3);
      assert.deepEqual(JSON.parse(await readFile(path.join(baseDir, "consent.json"), "utf8")), {
        version: 1,
        streaming: true,
        agentAccess: false,
      });
      const statuses = states.map((entry) => entry.hostStatus);
      assert.deepEqual([...new Set(statuses)], ["needs-consent", "installing", "starting", "ready"]);
      assert.equal(states.find((entry) => entry.hostStatus === "installing")?.hostStatuses.local.detail, "expo-device-hub@0.12.0");
    },
    { installed: false },
  );
});

test("a refresh starts an installed hub but never reinstalls a missing one", async () => {
  await withService(
    async ({ service, host }) => {
      const state = await service.refresh();
      assert.equal(state.hostStatus, "needs-consent");
      assert.match(state.hostStatuses.local.detail ?? "", /installed again/u);
      assert.deepEqual(host.calls, []);
    },
    { consent: { streaming: true }, installed: false },
  );
  await withService(
    async ({ service, host }) => {
      const state = await service.refresh();
      assert.equal(state.hostStatus, "ready");
      assert.deepEqual(host.calls, ["ensureReady"]);
      assert.deepEqual(host.commands, [["xcrun", "simctl", "list", "devices", "--json"]]);
    },
    { consent: { streaming: true } },
  );
});

test("an unavailable host reports the user-readable reason", async () => {
  await withService(
    async ({ service }) => {
      const state = await service.grantConsent("streaming");
      assert.equal(state.hostStatus, "unavailable");
      assert.equal(state.unavailableReason, "Open Xcode once and accept its license, then try again.");
    },
    { unavailable: "Open Xcode once and accept its license, then try again." },
  );
});

test("open boots when needed, attaches the stream helper, and is idempotent per chat", async () => {
  await withService(
    async ({ service, hub }) => {
      await assert.rejects(
        service.open({ chatId: "chat-1", deviceId: IPHONE_OLD, openedBy: "user" }),
        /Set up simulator streaming first/u,
      );
      await service.refresh();
      const session = await service.open({ chatId: "chat-1", deviceId: IPHONE_OLD, openedBy: "user" });
      assert.deepEqual(session, { chatId: "chat-1", hostId: "local", deviceId: IPHONE_OLD, openedBy: "user" });
      assert.deepEqual(hub.calls, [
        { url: "http://127.0.0.1:52000/api/devices/boot", body: { platform: "ios", id: IPHONE_OLD, name: "iPhone 17" } },
        { url: "http://127.0.0.1:52000/vendor/serve-sim/grid/api/start", body: { udid: IPHONE_OLD } },
      ]);
      await service.open({ chatId: "chat-1", deviceId: IPHONE_OLD, openedBy: "agent" });
      assert.equal(hub.calls.filter((call) => call.url.endsWith("/boot")).length, 1);
      await service.open({ chatId: "chat-2", deviceId: IPHONE, openedBy: "agent" });
      assert.equal(hub.calls.filter((call) => call.url.endsWith("/boot")).length, 1, "a booted device is not booted again");
      assert.deepEqual(service.sessionsForChat("chat-1").map((entry) => entry.deviceId), [IPHONE_OLD]);
      assert.deepEqual(service.sessionsForChat("chat-2").map((entry) => [entry.deviceId, entry.openedBy]), [[IPHONE, "agent"]]);
      assert.equal(service.state().sessions.length, 2);
      await assert.rejects(
        service.open({ chatId: "chat-1", deviceId: "MISSING", openedBy: "user" }),
        /no longer available/u,
      );
      await assert.rejects(
        service.open({ chatId: "chat-1", hostId: "ssh-1", deviceId: IPHONE, openedBy: "user" }),
        /Unknown device host/u,
      );
    },
    { consent: { streaming: true } },
  );
});

test("a refused boot surfaces the hub error and opens no session", async () => {
  await withService(
    async ({ service }) => {
      await service.refresh();
      await assert.rejects(
        service.open({ chatId: "chat-1", deviceId: IPHONE_OLD, openedBy: "user" }),
        /refused \/api\/devices\/boot: boot failed/u,
      );
      assert.deepEqual(service.state().sessions, []);
    },
    { consent: { streaming: true }, refuse: "/boot" },
  );
});

test("closing a session never shuts the simulator down unless asked", async () => {
  await withService(
    async ({ service, host }) => {
      await service.refresh();
      await service.open({ chatId: "chat-1", deviceId: IPHONE, openedBy: "user" });
      await service.close({ chatId: "chat-1", hostId: "local", deviceId: IPHONE });
      assert.deepEqual(service.sessionsForChat("chat-1"), []);
      assert.ok(!host.commands.some((command) => command.includes("shutdown")));
      await service.close({ chatId: "chat-1", hostId: "local", deviceId: IPHONE, shutdown: true });
      assert.deepEqual(host.commands[host.commands.length - 1], ["xcrun", "simctl", "shutdown", IPHONE]);
      assert.equal(service.state().devices.find((device) => device.id === IPHONE)?.booted, false);
    },
    { consent: { streaming: true } },
  );
});

test("removing a chat drops only its sessions and leaves simulators running", async () => {
  await withService(
    async ({ service, host }) => {
      await service.refresh();
      await service.open({ chatId: "chat-1", deviceId: IPHONE, openedBy: "user" });
      await service.open({ chatId: "chat-2", deviceId: IPHONE, openedBy: "user" });
      service.closeChat("chat-1");
      assert.deepEqual(service.sessionsForChat("chat-1"), []);
      assert.equal(service.sessionsForChat("chat-2").length, 1);
      assert.ok(!host.commands.some((command) => command.includes("shutdown")));
    },
    { consent: { streaming: true } },
  );
});

test("actions run one simctl argv on a known booted simulator and return fresh settings", async () => {
  await withService(
    async ({ service, host }) => {
      await assert.rejects(
        service.action({ hostId: "local", deviceId: IPHONE, type: "setAppearance", value: "dark" }),
        /Set up simulator streaming first/u,
      );
      await service.refresh();
      const settings = await service.action({
        hostId: "local",
        deviceId: IPHONE,
        type: "setAppearance",
        value: "dark",
      });
      assert.deepEqual(settings, {});
      assert.ok(
        host.commands.some(
          (command) => command.join(" ") === `xcrun simctl ui ${IPHONE} appearance dark`,
        ),
      );
      await assert.rejects(
        service.action({ hostId: "local", deviceId: IPHONE_OLD, type: "clearLocation" }),
        /Open the simulator/u,
      );
      await assert.rejects(
        service.settings({ hostId: "local", deviceId: "UNKNOWN" }),
        /no longer available/u,
      );
    },
    { consent: { streaming: true } },
  );
});

test("revoking agent access stops only the agent; revoking streaming stops the host", async () => {
  await withService(
    async ({ baseDir, service, host }) => {
      await assert.rejects(service.grantConsent("agentAccess"), /before allowing agent access/u);
      await service.grantConsent("streaming");
      assert.equal((await service.grantConsent("agentAccess")).consent.agentAccess, true);
      await service.open({ chatId: "chat-1", deviceId: IPHONE, openedBy: "user" });

      const afterAgent = await service.revokeConsent("agentAccess");
      assert.deepEqual(host.calls, ["ensureReady", "ensureAgentReady", "stopAgent"]);
      assert.equal(service.agentShimDir(), null);
      assert.equal(afterAgent.hostStatus, "ready");
      assert.equal(afterAgent.sessions.length, 1);

      const afterStreaming = await service.revokeConsent("streaming");
      assert.deepEqual(host.calls, ["ensureReady", "ensureAgentReady", "stopAgent", "stop"]);
      assert.equal(afterStreaming.hostStatus, "needs-consent");
      assert.deepEqual(afterStreaming.sessions, []);
      assert.deepEqual(afterStreaming.devices, []);
      assert.deepEqual(JSON.parse(await readFile(path.join(baseDir, "consent.json"), "utf8")), {
        version: 1,
        streaming: false,
        agentAccess: false,
      });
    },
  );
  await withService(
    async ({ service }) => {
      assert.deepEqual((await service.load()).consent, { streaming: false, agentAccess: false });
    },
    { consent: { streaming: false, agentAccess: true } },
  );
});

test("granting agent access installs agent-device and writes the pinned shim", async () => {
  await withService(async ({ baseDir, service, host }) => {
    await service.grantConsent("streaming");
    await service.grantConsent("agentAccess");
    const shimDir = service.agentShimDir();
    assert.equal(shimDir, path.join(baseDir, "bin"));
    const shim = await readFile(path.join(shimDir!, "agent-device"), "utf8");
    assert.match(shim, /^#!\/bin\/sh\nELECTRON_RUN_AS_NODE=1 exec '\/Applications\/Aiden Agent\.app/u);
    const launcher = await readFile(path.join(shimDir!, "agent-device-launcher.mjs"), "utf8");
    assert.match(launcher, /"\/pinned\/agent-device\/bin\.js"/u);

    const target = await service.agentTarget({ chatId: "chat-1", hostId: "local", deviceId: IPHONE });
    assert.equal(target.command, path.join(shimDir!, "agent-device"));
    assert.equal(target.args[0], "--config");
    assert.match(target.args[3] ?? "", /^aiden-[0-9a-f]{24}$/u);
    const other = await service.agentTarget({ chatId: "chat-2", hostId: "local", deviceId: IPHONE });
    assert.notEqual(other.args[3], target.args[3]);
    assert.equal(other.args[1], target.args[1]);
    assert.deepEqual(JSON.parse(await readFile(target.args[1]!, "utf8")), {
      daemonBaseUrl: "http://127.0.0.1:54000",
      daemonAuthToken: "daemon-token",
    });
    assert.deepEqual(host.calls, ["ensureReady", "ensureAgentReady", "ensureAgentReady", "ensureAgentReady"]);
  });
});

test("a failed agent install leaves access off, and tools never install", async () => {
  await withService(
    async ({ service }) => {
      await service.grantConsent("streaming");
      await assert.rejects(service.grantConsent("agentAccess"), /npm registry unreachable/u);
      assert.equal(service.state().consent.agentAccess, false);
      assert.equal(service.agentShimDir(), null);
      await assert.rejects(
        service.agentTarget({ chatId: "chat-1", hostId: "local", deviceId: IPHONE }),
        /Agent access to simulators is off/u,
      );
    },
    { agentFails: "npm registry unreachable" },
  );
  await withService(
    async ({ service, host }) => {
      await assert.rejects(
        service.agentTarget({ chatId: "chat-1", hostId: "local", deviceId: IPHONE }),
        /agent-device is not installed/u,
      );
      assert.equal(host.calls.includes("ensureAgentReady"), false);
    },
    { agentInstalled: false, consent: { streaming: true, agentAccess: true } },
  );
});

test("reveal reaches every listener until it unsubscribes", async () => {
  await withService(async ({ service }) => {
    const seen: string[] = [];
    const off = service.onReveal((chatId) => seen.push(chatId));
    service.reveal("chat-1");
    off();
    service.reveal("chat-2");
    assert.deepEqual(seen, ["chat-1"]);
  });
});

test("screenshots require PNG, and stream grants start one proxy lazily", async () => {
  await withService(
    async ({ service, proxyStarts }) => {
      await assert.rejects(service.streamGrant(), /Set up simulator streaming first/u);
      assert.deepEqual(proxyStarts, []);
      await service.refresh();
      const png = await service.screenshot({ hostId: "local", deviceId: IPHONE });
      assert.deepEqual([...png], [0x89, 0x50, 0x4e, 0x47]);
      assert.equal((await service.streamGrant()).origin, "http://127.0.0.1:53000");
      await service.streamGrant();
      assert.equal(proxyStarts.length, 1);
    },
    { consent: { streaming: true } },
  );
  await withService(
    async ({ service }) => {
      await service.refresh();
      await assert.rejects(service.screenshot({ hostId: "local", deviceId: IPHONE }), /screenshot failed/u);
    },
    { consent: { streaming: true }, screenshotType: "text/html" },
  );
});

test("a failing simulator listing reports an error instead of throwing", async () => {
  await withService(
    async ({ service }) => {
      const state = await service.refresh();
      assert.equal(state.hostStatus, "error");
      assert.match(state.hostStatuses.local.detail ?? "", /Could not list simulators/u);
    },
    { consent: { streaming: true }, listCode: 1 },
  );
});
