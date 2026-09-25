import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DeviceHostUnavailableError } from "./device-host.js";
import {
  AGENT_DEVICE,
  DEVICE_HUB,
  deviceToolPaths,
  type NpmRunner,
  type ToolSpec,
} from "./device-toolchain.js";
import {
  HUB_RESTART_MAX_DELAY_MS,
  NPM_REQUIRED_REASON,
  createLocalDeviceHost,
  findDeviceHostHelpers,
  nextHubRestartDelay,
  xcodeUnavailableReason,
  type HostChildProcess,
  type LocalDeviceHostDeps,
} from "./local-device-host.js";

class FakeChild extends EventEmitter implements HostChildProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: NodeJS.Signals[] = [];
  constructor(readonly pid: number) {
    super();
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killed.push(signal);
    this.exit(null, signal);
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

interface Harness {
  deps: LocalDeviceHostDeps;
  baseDir: string;
  children: FakeChild[];
  spawns: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[];
  commands: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[];
  sleeps: number[];
  kills: { pid: number; signal: string }[];
  advance(ms: number): void;
}

async function preinstall(baseDir: string, spec: ToolSpec) {
  const paths = deviceToolPaths(baseDir, spec);
  await mkdir(path.dirname(paths.entryPath), { recursive: true });
  await writeFile(paths.entryPath, "export {};\n");
  await writeFile(paths.sentinel, `${spec.version}\n`);
}

async function withHost(
  run: (harness: Harness) => Promise<void>,
  overrides: Partial<LocalDeviceHostDeps> = {},
  options: { installed?: boolean } = {},
) {
  const baseDir = await mkdtemp(path.join(tmpdir(), "aiden-devices-host-"));
  let clock = 1_000_000;
  let nextPid = 500;
  let nextPort = 52_000;
  const harness: Harness = {
    baseDir,
    children: [],
    spawns: [],
    commands: [],
    sleeps: [],
    kills: [],
    advance: (ms) => {
      clock += ms;
    },
    deps: undefined as unknown as LocalDeviceHostDeps,
  };
  harness.deps = {
    baseDir,
    platform: "darwin",
    nodePath: "/Applications/Aiden Agent.app/Contents/MacOS/Aiden Agent",
    env: { PATH: "/usr/bin", HOME: "/Users/me" },
    spawn: (command, args, env) => {
      harness.spawns.push({ command, args, env });
      const child = new FakeChild(nextPid++);
      harness.children.push(child);
      return child;
    },
    runCommand: async (command, args, commandOptions) => {
      harness.commands.push({ command, args, env: commandOptions.env });
      if (command === "xcrun") return { stdout: "usage: simctl", stderr: "", code: 0 };
      if (args[1] === "devices") {
        const stateDir = commandOptions.env.AGENT_DEVICE_STATE_DIR!;
        await writeFile(
          path.join(stateDir, "daemon.json"),
          JSON.stringify({ httpPort: 61_000, token: "daemon-token", pid: 900, version: "0.21.12" }),
        );
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    reservePort: async () => nextPort++,
    fetch: async (url) => ({ ok: url.endsWith("/readyz"), status: url.endsWith("/readyz") ? 200 : 404 }),
    sleep: async (ms) => {
      harness.sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    isProcessAlive: () => false,
    kill: (pid, signal) => harness.kills.push({ pid, signal }),
    resolveNpmRunner: async () => null,
    ...overrides,
  };
  if (options.installed !== false) {
    await preinstall(baseDir, DEVICE_HUB);
    await preinstall(baseDir, AGENT_DEVICE);
  }
  try {
    await run(harness);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Bounded by wall time, not turns: restarts do real file I/O that a loaded CI lane can slow down. */
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await settle();
  assert.ok(predicate(), "condition never held");
}

test("the hub starts under Electron-as-Node on a reserved loopback port", async () => {
  await withHost(async (harness) => {
    const host = createLocalDeviceHost(harness.deps);
    const phases: string[] = [];
    const ready = await host.ensureReady((phase) => phases.push(phase));
    assert.deepEqual(phases, ["starting"]);
    assert.equal(ready.hub.origin, "http://127.0.0.1:52000");
    assert.equal(harness.spawns.length, 1);
    const [spawned] = harness.spawns;
    assert.equal(spawned.command, harness.deps.nodePath);
    assert.deepEqual(spawned.args, [
      deviceToolPaths(harness.baseDir, DEVICE_HUB).entryPath,
      "--port",
      "52000",
      "--host",
      "127.0.0.1",
      "--hide-sidebar",
      "--hide-boot-device",
    ]);
    assert.equal(spawned.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(spawned.env.NO_COLOR, "1");
    assert.equal(spawned.env.HOME, "/Users/me");
    const state = JSON.parse(await readFile(path.join(harness.baseDir, "hub.json"), "utf8"));
    assert.deepEqual(state, {
      pid: 500,
      port: 52_000,
      entryPath: deviceToolPaths(harness.baseDir, DEVICE_HUB).entryPath,
    });
    assert.equal(host.current()?.hub.origin, ready.hub.origin);
    assert.equal((await host.ensureReady()).hub.origin, ready.hub.origin);
    assert.equal(harness.spawns.length, 1);
    await host.stop();
  });
});

test("concurrent ensureReady calls share one spawn", async () => {
  await withHost(async (harness) => {
    const host = createLocalDeviceHost(harness.deps);
    const results = await Promise.all([host.ensureReady(), host.ensureReady(), host.ensureReady()]);
    assert.equal(harness.spawns.length, 1);
    assert.equal(new Set(results.map((result) => result.hub.origin)).size, 1);
    await host.stop();
  });
});

test("unavailable Xcode or a non-Mac host leaves no child running", async () => {
  await withHost(
    async (harness) => {
      const host = createLocalDeviceHost(harness.deps);
      await assert.rejects(host.ensureReady(), (error: unknown) => {
        assert.ok(error instanceof DeviceHostUnavailableError);
        assert.equal(error.reason, "Open Xcode once and accept its license, then try again.");
        return true;
      });
      assert.equal(harness.spawns.length, 0);
      assert.deepEqual(await host.platformAvailability(), {
        platform: "ios",
        available: false,
        reason: "Open Xcode once and accept its license, then try again.",
      });
    },
    {
      runCommand: async () => ({
        stdout: "",
        stderr: "You have not agreed to the Xcode license agreements.",
        code: 69,
      }),
    },
  );
  await withHost(
    async (harness) => {
      const host = createLocalDeviceHost(harness.deps);
      await assert.rejects(host.ensureReady(), /iOS Simulators need macOS with Xcode\./u);
      assert.equal(harness.spawns.length, 0);
      assert.equal(harness.commands.length, 0);
    },
    { platform: "linux" },
  );
});

test("Xcode failures map to setup steps the user can take", () => {
  assert.equal(xcodeUnavailableReason({ stdout: "", stderr: "", code: 0 }), null);
  assert.match(xcodeUnavailableReason({ stdout: "", stderr: "spawn xcrun ENOENT", code: 127 })!, /Install Xcode/u);
  assert.match(
    xcodeUnavailableReason({ stdout: "", stderr: "xcrun: error: unable to find utility \"simctl\"", code: 72 })!,
    /Install Xcode/u,
  );
  assert.match(xcodeUnavailableReason({ stdout: "", stderr: "boom", code: 1 })!, /did not respond/u);
});

test("a missing install asks for npm only when needed and reports installing first", async () => {
  await withHost(
    async (harness) => {
      const host = createLocalDeviceHost(harness.deps);
      const phases: string[] = [];
      await assert.rejects(host.ensureReady((phase) => phases.push(phase)), (error: unknown) => {
        assert.ok(error instanceof DeviceHostUnavailableError);
        assert.equal(error.reason, NPM_REQUIRED_REASON);
        return true;
      });
      assert.deepEqual(phases, ["installing"]);
      assert.equal(harness.spawns.length, 0);
    },
    {},
    { installed: false },
  );

  const npmCalls: string[][] = [];
  const runNpm: NpmRunner = async (args) => {
    npmCalls.push(args);
    const prefix = args[args.indexOf("--prefix") + 1];
    const entry = path.join(prefix, "node_modules", DEVICE_HUB.name, ...DEVICE_HUB.entry);
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "export {};\n");
    return { code: 0, stderr: "" };
  };
  await withHost(
    async (harness) => {
      const host = createLocalDeviceHost(harness.deps);
      const phases: string[] = [];
      await host.ensureReady((phase, detail) => phases.push(detail ? `${phase}:${detail}` : phase));
      assert.deepEqual(phases, ["installing:expo-device-hub@0.12.0", "starting"]);
      assert.equal(npmCalls.length, 1);
      assert.equal(npmCalls[0][npmCalls[0].length - 1], "expo-device-hub@0.12.0");
      await host.stop();
    },
    { resolveNpmRunner: async () => runNpm },
    { installed: false },
  );
});

test("a stale hub is reaped only when its pid still runs that hub", async () => {
  for (const [command, shouldKill] of [
    ["ENTRY --port 52000", true],
    ["/usr/bin/some-other-process", false],
  ] as const) {
    await withHost(
      async (harness) => {
        const entryPath = deviceToolPaths(harness.baseDir, DEVICE_HUB).entryPath;
        await writeFile(
          path.join(harness.baseDir, "hub.json"),
          JSON.stringify({ pid: 42, port: 51_000, entryPath }),
        );
        harness.deps.runCommand = async (name, args, options) => {
          harness.commands.push({ command: name, args, env: options.env });
          if (name === "ps") {
            return { stdout: command.replace("ENTRY", entryPath), stderr: "", code: 0 };
          }
          return { stdout: "", stderr: "", code: 0 };
        };
        const host = createLocalDeviceHost(harness.deps);
        await host.ensureReady();
        assert.deepEqual(harness.kills, shouldKill ? [{ pid: 42, signal: "SIGTERM" }] : []);
        const ps = harness.commands.find((entry) => entry.command === "ps");
        assert.deepEqual(ps?.args, ["-o", "command=", "-p", "42"]);
        await host.stop();
      },
      { isProcessAlive: (pid) => pid === 42 },
    );
  }
});

test("hub restarts back off from 1s to a 30s cap and reset after stable uptime", async () => {
  assert.equal(nextHubRestartDelay(0, 10), 1_000);
  assert.equal(nextHubRestartDelay(1_000, 10), 2_000);
  assert.equal(nextHubRestartDelay(16_000, 10), HUB_RESTART_MAX_DELAY_MS);
  assert.equal(nextHubRestartDelay(30_000, 10), 30_000);
  assert.equal(nextHubRestartDelay(30_000, 60_000), 0);

  await withHost(async (harness) => {
    const host = createLocalDeviceHost(harness.deps);
    const health: string[] = [];
    host.onHealth((value) => health.push(value));
    await host.ensureReady();
    const restartSleeps = () => harness.sleeps.filter((ms) => ms >= 1_000);
    for (let crash = 1; crash <= 6; crash += 1) {
      harness.children[harness.children.length - 1]!.exit(1);
      await waitFor(() => harness.spawns.length === crash + 1 && host.current() !== null);
    }
    assert.deepEqual(restartSleeps(), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    harness.advance(60_000);
    harness.children[harness.children.length - 1]!.exit(1);
    await waitFor(() => harness.spawns.length === 8 && host.current() !== null);
    assert.deepEqual(restartSleeps(), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    harness.children[harness.children.length - 1]!.exit(1);
    await waitFor(() => harness.spawns.length === 9 && host.current() !== null);
    assert.deepEqual(restartSleeps().slice(-1), [1_000]);
    assert.equal(health.filter((value) => value === "restarting").length, 8);
    assert.equal(health.filter((value) => value === "ready").length, 8);
    await host.stop();
  });
});

test("stop kills helpers, never shuts simulators down, and does not respawn", async () => {
  await withHost(async (harness) => {
    const host = createLocalDeviceHost(harness.deps);
    await host.ensureAgentReady();
    await host.stop();
    await settle();
    assert.deepEqual(harness.children[0].killed, ["SIGTERM"]);
    assert.equal(harness.spawns.length, 1);
    assert.equal(host.current(), null);
    await assert.rejects(readFile(path.join(harness.baseDir, "hub.json"), "utf8"));
    assert.ok(!harness.commands.some((entry) => entry.args.includes("shutdown")));
    const stop = harness.commands.find((entry) => entry.args.includes("daemon"));
    assert.deepEqual(stop?.args.slice(1), [
      "daemon",
      "stop",
      "--state-dir",
      path.join(harness.baseDir, "agent-state"),
    ]);
  });
});

test("agent-device starts in HTTP mode only when agent access is requested", async () => {
  await withHost(async (harness) => {
    const host = createLocalDeviceHost(harness.deps);
    await host.ensureReady();
    assert.ok(!harness.commands.some((entry) => entry.args.includes("devices")));
    const ready = await host.ensureAgentReady();
    assert.deepEqual(ready.agentDevice, {
      baseUrl: "http://127.0.0.1:61000",
      token: "daemon-token",
      entryPath: deviceToolPaths(harness.baseDir, AGENT_DEVICE).entryPath,
    });
    const launch = harness.commands.find((entry) => entry.args.includes("devices"))!;
    assert.equal(launch.command, harness.deps.nodePath);
    assert.equal(launch.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(launch.env.AGENT_DEVICE_STATE_DIR, path.join(harness.baseDir, "agent-state"));
    assert.equal(launch.env.AGENT_DEVICE_DAEMON_SERVER_MODE, "http");
    assert.equal(launch.env.AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS, "0");
    assert.equal(launch.env.AGENT_DEVICE_NO_UPDATE_NOTIFIER, "1");

    await host.ensureAgentReady();
    assert.equal(harness.commands.filter((entry) => entry.args.includes("devices")).length, 1);

    await host.stopAgent();
    assert.ok(host.current(), "stopping the agent keeps the hub for manual viewing");
    await host.stop();
  });
});

test("a healthy existing agent-device daemon is reused", async () => {
  await withHost(
    async (harness) => {
      const stateDir = path.join(harness.baseDir, "agent-state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "daemon.json"), JSON.stringify({ httpPort: 61_500, token: "kept" }));
      const host = createLocalDeviceHost(harness.deps);
      const ready = await host.ensureAgentReady();
      assert.equal(ready.agentDevice.baseUrl, "http://127.0.0.1:61500");
      assert.ok(!harness.commands.some((entry) => entry.args.includes("devices")));
      await host.stop();
    },
    {
      fetch: async (url) => ({ ok: true, status: url.includes("61500/health") || url.endsWith("/readyz") ? 200 : 404 }),
    },
  );
});

test("serve-sim helpers are found inside the hub install, and a missing one is null", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiden-device-helpers-"));
  try {
    const dist = path.join(dir, "node_modules", "expo-device-hub", "vendor", "serve-sim", "dist");
    await mkdir(path.join(dist, "simax"), { recursive: true });
    await writeFile(path.join(dist, "simax", "serve-sim-ax-settings"), "");
    assert.deepEqual(await findDeviceHostHelpers(dir), {
      axSettings: path.join(dist, "simax", "serve-sim-ax-settings"),
      serveSimCli: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
