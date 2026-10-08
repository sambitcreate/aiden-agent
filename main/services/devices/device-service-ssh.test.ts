import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DeviceToolVersions, SshDeviceHostConfig } from "../../../renderer/shared/device-ssh-hosts.js";
import type { DeviceServiceState } from "../../../renderer/shared/devices.js";
import { DeviceToolsMissingError, type DeviceHost, type DeviceHostHealth, type DeviceHostReady } from "./device-host.js";
import type { DeviceHubProxy, DeviceHubTarget } from "./device-hub-proxy.js";
import { createDeviceService, type DeviceServiceDeps } from "./device-service.js";
import { AGENT_DEVICE, DEVICE_HUB } from "./device-toolchain.js";
import type { SshDeviceHost } from "./ssh-device-host.js";

const MINI: SshDeviceHostConfig = { id: "ssh-mini01", label: "Mac mini", target: "me@mini.local" };
const STUDIO: SshDeviceHostConfig = { id: "ssh-studio", label: "Studio", target: "studio", port: 2222 };
const REMOTE_PHONE = "AAAAAAAA-0000-4000-8000-000000000001";
const SIMCTL = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      { udid: REMOTE_PHONE, name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "iPhone-17-Pro" },
    ],
  },
});
const TOOLS: DeviceToolVersions = {
  hub: { requiredVersion: DEVICE_HUB.version, installedVersions: [DEVICE_HUB.version], runningVersion: null },
  agent: { requiredVersion: AGENT_DEVICE.version, installedVersions: [AGENT_DEVICE.version], runningVersion: null },
};

interface FakeSshOptions {
  missing?: boolean;
  fails?: string;
  probeFails?: string;
  agentMissing?: boolean;
  port?: number;
}

function fakeSshHost(config: SshDeviceHostConfig, options: FakeSshOptions) {
  const log: string[] = [];
  let ready: DeviceHostReady | null = null;
  let health: ((value: DeviceHostHealth, detail?: string) => void) | null = null;
  const origin = `http://127.0.0.1:${options.port ?? 41001}`;
  const host: SshDeviceHost = {
    id: config.id,
    kind: "ssh",
    config,
    async inspect() {
      log.push("inspect");
      if (options.probeFails) throw new Error(options.probeFails);
      return { nodePath: "/opt/homebrew/bin/node", nodeVersion: "22.12.0", platforms: [{ platform: "ios", available: true }], tools: TOOLS };
    },
    tools: () => TOOLS,
    platformAvailability: async () => ({ platform: "ios", available: true }),
    hubInstalled: async () => !options.missing,
    agentInstalled: async () => !options.agentMissing,
    async ensureReady(onPhase, start) {
      log.push(`ensureReady:${start?.allowInstall === true}`);
      if (options.fails) throw new Error(options.fails);
      if (options.missing) {
        if (!start?.allowInstall) throw new DeviceToolsMissingError("expo-device-hub");
        onPhase?.("installing", "Updating device hub from 0.11.0 to 0.12.0…");
        options.missing = false;
      }
      ready = {
        nodePath: "/opt/homebrew/bin/node",
        hub: { origin },
        helpers: { axSettings: null, serveSimCli: null },
        run: async (command, args) => {
          log.push(`run:${[command, ...args].join(" ")}`);
          return { stdout: args[1] === "list" ? SIMCTL : "", stderr: "", code: 0 };
        },
      };
      return ready;
    },
    async ensureAgentReady(_onPhase, start) {
      log.push(`ensureAgentReady:${start?.allowInstall === true}`);
      if (options.agentMissing && !start?.allowInstall) throw new DeviceToolsMissingError("agent-device");
      const current = ready ?? (await host.ensureReady());
      return { ...current, agentDevice: { baseUrl: "http://127.0.0.1:41002", token: "remote-token", entryPath: "/remote/agent.mjs" } };
    },
    current: () => ready,
    onHealth(listener) {
      health = listener;
      return () => {
        health = null;
      };
    },
    stopAgent: async () => {
      log.push("stopAgent");
    },
    stop: async () => {
      log.push("stop");
      ready = null;
    },
  };
  return { host, log, health: (value: DeviceHostHealth, detail?: string) => health?.(value, detail) };
}

function fakeLocalHost(options: { installed?: boolean } = {}) {
  const calls: string[] = [];
  let ready: DeviceHostReady | null = null;
  let installed = options.installed ?? true;
  const host: DeviceHost = {
    id: "local",
    kind: "local",
    platformAvailability: async () => ({ platform: "ios", available: true }),
    hubInstalled: async () => installed,
    agentInstalled: async () => true,
    async ensureReady(onPhase, start) {
      calls.push(`ensureReady:${start?.allowInstall === true}`);
      if (!installed) {
        if (!start?.allowInstall) throw new DeviceToolsMissingError("expo-device-hub");
        onPhase?.("installing", "expo-device-hub@0.12.0");
        installed = true;
      }
      ready = {
        nodePath: "/electron",
        hub: { origin: "http://127.0.0.1:52000" },
        helpers: { axSettings: null, serveSimCli: null },
        run: async () => ({ stdout: JSON.stringify({ devices: {} }), stderr: "", code: 0 }),
      };
      return ready;
    },
    async ensureAgentReady() {
      throw new Error("not used");
    },
    async installTool(tool) {
      calls.push(`installTool:${tool}`);
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
  return { host, calls };
}

async function installTool(baseDir: string, name: string, version: string, entry: string[]): Promise<void> {
  const directory = path.join(baseDir, "tools", name, version);
  await mkdir(path.join(directory, "node_modules", name, ...entry.slice(0, -1)), { recursive: true });
  await writeFile(path.join(directory, "node_modules", name, ...entry), "");
  await writeFile(path.join(directory, ".install-complete"), `${version}\n`);
}

interface Context {
  baseDir: string;
  service: ReturnType<typeof createDeviceService>;
  local: ReturnType<typeof fakeLocalHost>;
  ssh: Map<string, ReturnType<typeof fakeSshHost>>;
  created: string[];
  hubCalls: string[];
  resolve(hostId: string): Promise<DeviceHubTarget | null>;
  closedHosts: string[];
  maintenance: Array<{ policy: string; specs: string[] }>;
  states: DeviceServiceState[];
}

async function withService(
  run: (context: Context) => Promise<void>,
  options: {
    consent?: object;
    hosts?: SshDeviceHostConfig[];
    toolConsent?: object;
    ssh?: Record<string, FakeSshOptions>;
    localTargets?: string[];
    localInstalled?: boolean;
    prepare?(baseDir: string): Promise<void>;
  } = {},
) {
  const baseDir = await mkdtemp(path.join(tmpdir(), "aiden-devices-ssh-"));
  if (options.consent) await writeFile(path.join(baseDir, "consent.json"), JSON.stringify(options.consent));
  if (options.hosts) {
    await writeFile(
      path.join(baseDir, "ssh-hosts.json"),
      JSON.stringify({ version: 1, hosts: options.hosts, toolConsent: options.toolConsent ?? {} }),
    );
  }
  await options.prepare?.(baseDir);
  const local = fakeLocalHost({ installed: options.localInstalled });
  const ssh = new Map<string, ReturnType<typeof fakeSshHost>>();
  const created: string[] = [];
  const hubCalls: string[] = [];
  const closedHosts: string[] = [];
  const maintenance: Context["maintenance"] = [];
  let resolver: ((hostId: string) => DeviceHubTarget | null | Promise<DeviceHubTarget | null>) | null = null;
  const fetch: DeviceServiceDeps["fetch"] = async (url) => {
    hubCalls.push(url);
    const payload = Buffer.from(JSON.stringify({ ok: true }));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    };
  };
  const service = createDeviceService({
    baseDir,
    host: local.host,
    fetch,
    nodePath: "/fake/electron",
    runMaintenance: async (input) => {
      maintenance.push({ policy: input.policy, specs: input.specs.map((spec) => `${spec.name}@${spec.version}`) });
      return [];
    },
    ssh: {
      create(config) {
        created.push(`${config.id}:${config.target}`);
        const fake = fakeSshHost(config, { ...(options.ssh?.[config.id] ?? {}) });
        ssh.set(config.id, fake);
        return fake.host;
      },
      isLocalTarget: async (config) => (options.localTargets ?? []).includes(config.target),
    },
    startProxy: async (resolveHub) => {
      resolver = resolveHub;
      return {
        origin: "http://127.0.0.1:53000",
        mintGrant: () => ({ origin: "http://127.0.0.1:53000", token: "T".repeat(43), expiresAt: 1 }),
        closeHost: (hostId) => closedHosts.push(hostId),
        close: async () => undefined,
      } satisfies DeviceHubProxy;
    },
  });
  const states: DeviceServiceState[] = [];
  service.onState((state) => states.push(state));
  try {
    await run({
      baseDir,
      service,
      local,
      ssh,
      created,
      hubCalls,
      closedHosts,
      maintenance,
      states,
      resolve: async (hostId) => {
        assert.ok(resolver, "the proxy has started");
        return resolver(hostId);
      },
    });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

const STREAMING = { version: 1, streaming: true, agentAccess: false, peerSharing: false };
const AGENT = { version: 1, streaming: true, agentAccess: true, peerSharing: false };
const sshLog = (context: Context, id: string) => context.ssh.get(id)!.log;
const hostOf = (state: DeviceServiceState, id: string) => state.hosts.find((host) => host.id === id);

test("saved SSH hosts load after This Mac without contacting them", async () => {
  await withService(
    async (context) => {
      const state = await context.service.load();
      assert.deepEqual(
        state.hosts.map((host) => [host.id, host.kind, host.status]),
        [
          ["local", "local", "stopped"],
          [MINI.id, "ssh", "stopped"],
          [STUDIO.id, "ssh", "stopped"],
        ],
      );
      assert.match(hostOf(state, MINI.id)!.detail ?? "", /only when you ask/u);
      assert.deepEqual(state.sshHosts, [MINI, STUDIO]);
      await context.service.refreshLocal();
      assert.deepEqual([...context.ssh.values()].flatMap((fake) => fake.log), [], "no host was contacted");
    },
    { consent: STREAMING, hosts: [MINI, STUDIO] },
  );
});

test("a full refresh connects SSH hosts and lists their simulators; this-Mac targets are skipped", async () => {
  await withService(
    async (context) => {
      const state = await context.service.refresh();
      assert.equal(hostOf(state, MINI.id)?.status, "ready");
      assert.deepEqual(sshLog(context, MINI.id), ["ensureReady:false", "run:xcrun simctl list devices --json"]);
      assert.deepEqual(
        state.devices.filter((device) => device.hostId === MINI.id).map((device) => device.id),
        [REMOTE_PHONE],
      );
      assert.equal(hostOf(state, STUDIO.id)?.status, "unavailable");
      assert.match(hostOf(state, STUDIO.id)?.detail ?? "", /is this Mac/u);
      assert.deepEqual(sshLog(context, STUDIO.id), [], "a local target is never started");
    },
    { consent: STREAMING, hosts: [MINI, STUDIO], localTargets: ["studio"] },
  );
});

test("a host the user never approved asks for Install, and an approved host updates on the next connect", async () => {
  await withService(
    async (context) => {
      let state = await context.service.startHost(MINI.id);
      assert.equal(hostOf(state, MINI.id)?.status, "needs-consent");
      assert.deepEqual(sshLog(context, MINI.id), ["ensureReady:false"]);

      state = await context.service.updateTool({ hostId: MINI.id, tool: "hub" });
      assert.equal(hostOf(state, MINI.id)?.status, "ready");
      assert.ok(context.states.some((entry) => hostOf(entry, MINI.id)?.status === "installing"), "progress is visible");
      const saved = JSON.parse(await readFile(path.join(context.baseDir, "ssh-hosts.json"), "utf8"));
      assert.deepEqual(saved.toolConsent, { [MINI.id]: { hub: true, agent: false } });

      // A new Aiden pins a newer hub: the approved host updates on the next explicit connect.
      await context.service.startHost(MINI.id);
      assert.equal(sshLog(context, MINI.id).filter((entry) => entry === "ensureReady:true").length, 2);
    },
    { consent: STREAMING, hosts: [MINI], ssh: { [MINI.id]: { missing: true } } },
  );
});

test("SSH simulators open through the forwarded hub, and the proxy forgets a host that drops", async () => {
  await withService(
    async (context) => {
      await context.service.refresh();
      const session = await context.service.open({ chatId: "chat-1", hostId: MINI.id, deviceId: REMOTE_PHONE, openedBy: "user" });
      assert.deepEqual(session, { chatId: "chat-1", hostId: MINI.id, deviceId: REMOTE_PHONE, openedBy: "user" });
      // Refresh also reads this Mac's hub for Android emulators; the open itself goes only to the forwarded hub.
      assert.deepEqual(context.hubCalls.filter((url) => url.startsWith("http://127.0.0.1:41001/")), [
        "http://127.0.0.1:41001/api/devices/boot",
        "http://127.0.0.1:41001/vendor/serve-sim/grid/api/start",
      ]);
      await context.service.streamGrant();
      assert.equal(await context.resolve(MINI.id), "http://127.0.0.1:41001");
      assert.equal(await context.resolve("ssh-unknown"), null);

      context.ssh.get(MINI.id)!.health("failed", "Could not connect to Mac mini over SSH.");
      const state = context.service.state();
      assert.equal(hostOf(state, MINI.id)?.status, "error");
      assert.deepEqual(state.sessions, []);
      assert.equal(await context.resolve(MINI.id), null);
      assert.ok(context.closedHosts.includes(MINI.id), "open streams to the host are closed");
    },
    { consent: STREAMING, hosts: [MINI] },
  );
});

test("turning streaming off disconnects SSH hosts and forgets their install approval", async () => {
  await withService(
    async (context) => {
      await context.service.refresh();
      await context.service.revokeConsent("streaming");
      assert.ok(sshLog(context, MINI.id).includes("stop"));
      assert.equal(hostOf(context.service.state(), MINI.id)?.status, "stopped");
      const saved = JSON.parse(await readFile(path.join(context.baseDir, "ssh-hosts.json"), "utf8"));
      assert.deepEqual(saved.toolConsent, {});
      await assert.rejects(context.service.startHost(MINI.id), /Set up simulator streaming first/u);
    },
    { consent: STREAMING, hosts: [MINI], toolConsent: { [MINI.id]: { hub: true, agent: false } } },
  );
});

test("removing a host stops its helpers there; editing its destination replaces the connection", async () => {
  await withService(
    async (context) => {
      await context.service.refresh();
      const previous = context.ssh.get(MINI.id)!;
      const moved = { ...MINI, target: "me@mini-2.local" };
      await context.service.saveSshHost(moved);
      assert.ok(previous.log.includes("stop"), "the old destination's helpers are stopped");
      assert.deepEqual(context.created, [`${MINI.id}:me@mini.local`, `${MINI.id}:me@mini-2.local`]);
      let saved = JSON.parse(await readFile(path.join(context.baseDir, "ssh-hosts.json"), "utf8"));
      assert.deepEqual(saved.hosts, [moved]);
      assert.deepEqual(saved.toolConsent, {}, "a new destination needs its own approval");

      const added = await context.service.saveSshHost(STUDIO);
      assert.deepEqual(added.hosts.map((host) => host.id), ["local", MINI.id, STUDIO.id]);
      await assert.rejects(context.service.saveSshHost({ ...STUDIO, id: "ssh-studi2" }), /already uses this destination/u);

      await context.service.removeSshHost(STUDIO.id);
      assert.ok(sshLog(context, STUDIO.id).includes("stop"));
      saved = JSON.parse(await readFile(path.join(context.baseDir, "ssh-hosts.json"), "utf8"));
      assert.deepEqual(saved.hosts, [moved]);
      assert.deepEqual(context.service.state().sshHosts, [moved]);
    },
    { consent: STREAMING, hosts: [MINI], toolConsent: { [MINI.id]: { hub: true, agent: false } } },
  );
});

test("agents drive a connected SSH host through that host's own agent-device config", async () => {
  await withService(
    async (context) => {
      await assert.rejects(
        context.service.agentTarget({ chatId: "chat-1", hostId: MINI.id, deviceId: REMOTE_PHONE }),
        /Connect Mac mini first/u,
      );
      await context.service.refresh();
      const target = await context.service.agentTarget({ chatId: "chat-1", hostId: MINI.id, deviceId: REMOTE_PHONE });
      assert.ok(sshLog(context, MINI.id).includes("ensureAgentReady:false"), "an agent call never installs on the host");
      const config = target.args[target.args.indexOf("--config") + 1]!;
      assert.equal(path.dirname(config), path.join(context.baseDir, "hosts"));
      assert.deepEqual(JSON.parse(await readFile(config, "utf8")), {
        daemonBaseUrl: "http://127.0.0.1:41002",
        daemonAuthToken: "remote-token",
      });
      assert.equal(target.command, path.join(context.baseDir, "bin", "agent-device"));
    },
    {
      consent: AGENT,
      hosts: [MINI],
      prepare: (baseDir) => installTool(baseDir, AGENT_DEVICE.name, AGENT_DEVICE.version, ["bin", "agent-device.mjs"]),
    },
  );
});

test("a host without agent tools sends the agent to the user instead of installing", async () => {
  await withService(
    async (context) => {
      await context.service.refresh();
      await assert.rejects(
        context.service.agentTarget({ chatId: "chat-1", hostId: MINI.id, deviceId: REMOTE_PHONE }),
        /Agent tools are not installed on Mac mini\. Ask the user to install them in Settings → Simulator/u,
      );
      await context.service.updateTool({ hostId: MINI.id, tool: "agent" });
      assert.ok(sshLog(context, MINI.id).includes("ensureAgentReady:true"));
    },
    {
      consent: AGENT,
      hosts: [MINI],
      ssh: { [MINI.id]: { agentMissing: true } },
      prepare: (baseDir) => installTool(baseDir, AGENT_DEVICE.name, AGENT_DEVICE.version, ["bin", "agent-device.mjs"]),
    },
  );
});

test("Test connection checks a host without starting anything, and reports this Mac or the failure", async () => {
  await withService(
    async (context) => {
      assert.deepEqual(await context.service.testSshHost({ ...STUDIO, target: "localhost" }), { status: "local" });
      const connected = await context.service.testSshHost(MINI);
      assert.equal(connected.status, "connected");
      assert.deepEqual(sshLog(context, MINI.id), ["inspect"]);
      const draft = { id: "ssh-new001", label: "New", target: "new.local" };
      const failed = await context.service.testSshHost(draft);
      assert.deepEqual(failed, { status: "failed", error: "Node.js was not found on the host's non-interactive SSH PATH." });
      assert.deepEqual(context.service.state().sshHosts, [MINI], "testing never saves a host");
    },
    {
      hosts: [MINI],
      localTargets: ["localhost"],
      ssh: { "ssh-new001": { probeFails: "Node.js was not found on the host's non-interactive SSH PATH." } },
    },
  );
});

test("checking versions is read-only and one host's failure never hides another's", async () => {
  await withService(
    async (context) => {
      const state = await context.service.inspectTools();
      assert.match(hostOf(state, MINI.id)?.toolInspectionError ?? "", /Could not check versions: .*refused.*not changed/u);
      assert.equal(hostOf(state, STUDIO.id)?.toolInspectionError, undefined);
      assert.deepEqual(hostOf(state, STUDIO.id)?.tools, TOOLS);
      assert.deepEqual(hostOf(state, "local")?.tools?.hub.installedVersions, []);
      assert.ok([...context.ssh.values()].every((fake) => fake.log.every((entry) => entry === "inspect")));
      assert.deepEqual(context.maintenance, []);
    },
    { hosts: [MINI, STUDIO], ssh: { [MINI.id]: { probeFails: "Connection refused" } } },
  );
});

test("an outdated local hub updates only on an explicit Start, with progress, then reclaims old versions", async () => {
  await withService(
    async (context) => {
      let state = await context.service.load();
      assert.equal(state.hostStatus, "stopped");
      assert.match(state.hostStatuses.local?.detail ?? "", /replaces 0\.11\.0 when you choose Start/u);
      await context.service.refreshLocal();
      assert.deepEqual(context.local.calls, [], "loading and refreshing never install");

      state = await context.service.startHost("local");
      assert.equal(state.hostStatus, "ready");
      assert.deepEqual(context.local.calls, ["ensureReady:true"]);
      assert.ok(
        context.states.some((entry) => entry.hostStatuses.local?.detail === "Updating the device hub from 0.11.0 to 0.12.0…"),
      );
      assert.deepEqual(context.maintenance, [{ policy: "reclaim", specs: [`${DEVICE_HUB.name}@${DEVICE_HUB.version}`] }]);
    },
    {
      consent: STREAMING,
      localInstalled: false,
      prepare: (baseDir) => installTool(baseDir, DEVICE_HUB.name, "0.11.0", ["dist", "server", "cli.mjs"]),
    },
  );
});

test("manual updates need the matching permission, and Prune uses the locked maintenance pass", async () => {
  await withService(
    async (context) => {
      await assert.rejects(context.service.updateTool({ hostId: "local", tool: "agent" }), /Turn on agent access/u);
      await context.service.updateTool({ hostId: "local", tool: "hub" });
      assert.ok(context.local.calls.includes("installTool:hub"));
      await context.service.pruneTools();
      assert.deepEqual(context.maintenance[context.maintenance.length - 1], {
        policy: "prune",
        specs: [`${DEVICE_HUB.name}@${DEVICE_HUB.version}`, `${AGENT_DEVICE.name}@${AGENT_DEVICE.version}`],
      });
    },
    { consent: STREAMING },
  );
});

test("quitting stops every SSH host", async () => {
  await withService(
    async (context) => {
      await context.service.refresh();
      await context.service.stop();
      assert.ok(sshLog(context, MINI.id).includes("stop"));
      assert.ok(sshLog(context, STUDIO.id).includes("stop"));
    },
    { consent: STREAMING, hosts: [MINI, STUDIO] },
  );
});
