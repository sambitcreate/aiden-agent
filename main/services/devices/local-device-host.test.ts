import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DeviceHostUnavailableError, DeviceToolsMissingError } from "./device-host.js";
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
  androidUnavailableReason,
  createLocalDeviceHost,
  findAndroidSdk,
  findAndroidStudioJava,
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
    pathExists: async () => false,
    realPath: async () => null,
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
        // Neither platform can run, so the user learns what each one needs.
        assert.match(error.reason, /^Open Xcode once and accept its license, then try again\. Android SDK not found\./u);
        return true;
      });
      assert.equal(harness.spawns.length, 0);
      assert.deepEqual(await host.platformAvailability("ios"), {
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

test("a missing install never reaches npm unless the caller allows installing", async () => {
  await withHost(
    async (harness) => {
      let asked = 0;
      harness.deps.resolveNpmRunner = async () => {
        asked += 1;
        return null;
      };
      const host = createLocalDeviceHost(harness.deps);
      const phases: string[] = [];
      for (const start of [() => host.ensureReady((phase) => phases.push(phase)), () => host.ensureAgentReady()]) {
        await assert.rejects(start(), (error: unknown) => {
          assert.ok(error instanceof DeviceToolsMissingError);
          assert.equal(error.tool, DEVICE_HUB.name);
          return true;
        });
      }
      assert.equal(asked, 0);
      assert.deepEqual(phases, []);
      assert.equal(harness.spawns.length, 0);
    },
    {},
    { installed: false },
  );
});

test("a missing install asks for npm only when needed and reports installing first", async () => {
  await withHost(
    async (harness) => {
      const host = createLocalDeviceHost(harness.deps);
      const phases: string[] = [];
      await assert.rejects(host.ensureReady((phase) => phases.push(phase), { allowInstall: true }), (error: unknown) => {
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
      await host.ensureReady((phase, detail) => phases.push(detail ? `${phase}:${detail}` : phase), {
        allowInstall: true,
      });
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

test("stopping the agent after a relaunch stops the daemon a previous run left behind", async () => {
  await withHost(async (harness) => {
    const stateDir = path.join(harness.baseDir, "agent-state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "daemon.json"), JSON.stringify({ httpPort: 61_500, token: "old" }));
    const host = createLocalDeviceHost(harness.deps);
    await host.stopAgent();
    const stop = harness.commands.find((entry) => entry.args.includes("daemon"));
    assert.equal(stop?.args[0], deviceToolPaths(harness.baseDir, AGENT_DEVICE).entryPath);
    assert.deepEqual(stop?.args.slice(1), ["daemon", "stop", "--state-dir", stateDir]);
    assert.equal(harness.spawns.length, 0, "stopping never starts the hub");
  });
  await withHost(async (harness) => {
    const host = createLocalDeviceHost(harness.deps);
    await host.stopAgent();
    assert.equal(harness.commands.length, 0, "no daemon file means nothing to stop");
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

/** A filesystem with exactly these files, and `adb` links resolved through `links`. */
function fakeFs(files: string[], links: Record<string, string> = {}) {
  return {
    pathExists: async (file: string) => files.includes(file),
    realPath: async (file: string) => links[file] ?? (files.includes(file) ? file : null),
  };
}

const SDK = "/Users/me/Library/Android/sdk";
const COMPLETE_SDK = [
  `${SDK}/platform-tools/adb`,
  `${SDK}/emulator/emulator`,
  `${SDK}/cmdline-tools/latest/bin/avdmanager`,
];

test("the Android SDK is found from ANDROID_HOME, Android Studio's default, or the adb on PATH", async () => {
  const explicit = await findAndroidSdk({ env: { ANDROID_HOME: "/opt/sdk", HOME: "/Users/me" }, ...fakeFs(COMPLETE_SDK) });
  // An explicit ANDROID_HOME wins even when it is incomplete, so the reason names that folder.
  assert.deepEqual(explicit, { root: "/opt/sdk", adb: false, emulator: false, avdmanager: false, legacyAvdmanager: false });
  assert.match(androidUnavailableReason(explicit) ?? "", /Platform-Tools are missing from \/opt\/sdk/u);

  const studio = await findAndroidSdk({ env: { HOME: "/Users/me", PATH: "/usr/bin" }, ...fakeFs(COMPLETE_SDK) });
  assert.equal(studio.root, SDK);
  assert.equal(androidUnavailableReason(studio), null);

  const brew = await findAndroidSdk({
    env: { HOME: "/Users/me", PATH: "/usr/bin:/opt/homebrew/bin" },
    ...fakeFs(["/opt/android/platform-tools/adb", "/opt/android/emulator/emulator", "/opt/android/tools/bin/avdmanager"], {
      "/opt/homebrew/bin/adb": "/opt/android/platform-tools/adb",
    }),
  });
  assert.equal(brew.root, "/opt/android");
  assert.match(androidUnavailableReason(brew) ?? "", /command-line tools in \/opt\/android are too old/u);

  const none = await findAndroidSdk({ env: { HOME: "/Users/me", PATH: "/usr/bin" }, ...fakeFs([]) });
  assert.equal(none.root, null);
  assert.equal(
    androidUnavailableReason(none),
    "Android SDK not found. Install it with Android Studio, or set ANDROID_HOME to your SDK folder.",
  );
  assert.match(
    androidUnavailableReason({ ...studio, emulator: false }) ?? "",
    /Android Emulator is missing from \/Users\/me\/Library\/Android\/sdk/u,
  );
});

test("the hub gets Android Studio's Java when JAVA_HOME is unset, so avdmanager can list AVDs before a boot", async () => {
  const jbr = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
  await withHost(
    async (harness) => {
      const host = createLocalDeviceHost(harness.deps);
      assert.equal((await host.platformAvailability("android")).available, true);
      await host.ensureReady();
      const [spawned] = harness.spawns;
      assert.equal(spawned?.env.JAVA_HOME, jbr);
      assert.ok(spawned?.env.PATH?.split(":").includes(`${jbr}/bin`), "java resolves from the bundled runtime");
      await host.stop();
    },
    fakeFs([...COMPLETE_SDK, `${jbr}/bin/java`]),
  );
  // A Java the user chose is never replaced.
  assert.equal(
    await findAndroidStudioJava({ env: { JAVA_HOME: "/opt/jdk", HOME: "/Users/me" }, ...fakeFs([`${jbr}/bin/java`]) }),
    null,
  );
  assert.equal(
    await findAndroidStudioJava({ env: { HOME: "/Users/me" }, ...fakeFs(["/Users/me/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java"]) }),
    "/Users/me/Applications/Android Studio.app/Contents/jbr/Contents/Home",
  );
  assert.equal(await findAndroidStudioJava({ env: { HOME: "/Users/me" }, ...fakeFs([]) }), null);
});

test("a Mac with the Android SDK but no Xcode starts the hub with the SDK on its PATH", async () => {
  await withHost(
    async (harness) => {
      const recorded = harness.deps.runCommand;
      harness.deps.runCommand = async (command, args, options) =>
        command === "xcrun"
          ? { stdout: "", stderr: "xcode-select: error: tool 'xcrun' requires Xcode", code: 72 }
          : recorded(command, args, options);
      const host = createLocalDeviceHost(harness.deps);
      assert.deepEqual(await host.platformAvailability("android"), { platform: "android", available: true });
      assert.equal((await host.platformAvailability("ios")).available, false);
      const ready = await host.ensureReady();
      const [spawned] = harness.spawns;
      assert.equal(spawned?.env.ANDROID_HOME, SDK);
      assert.equal(spawned?.env.PATH, `${SDK}/platform-tools:${SDK}/emulator:/usr/bin`);
      // Host commands (adb, emulator) resolve against the same PATH.
      await ready.run("adb", ["devices"]);
      const adb = harness.commands.find((command) => command.command === "adb");
      assert.equal(adb?.env.PATH, `${SDK}/platform-tools:${SDK}/emulator:/usr/bin`);
      await host.stop();
    },
    fakeFs(COMPLETE_SDK),
  );
});
