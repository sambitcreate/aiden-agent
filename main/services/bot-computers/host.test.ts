import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { BoundedProcessOptions, BoundedProcessResult } from "./bounded-process.js";
import { createBotComputerHost, type BotComputerHostDependencies } from "./host.js";
import { BOT_COMPUTER_GUEST_PASSWORD_SECRET, BotComputerError } from "./types.js";
import { BOT_COMPUTER_BASE_VM, botComputerVmName } from "./vm-names.js";

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

const fake = path.resolve("tests/e2e/lume-fake.mjs");
const restoreImage = Buffer.from("fake macOS restore image for host tests\n".repeat(64));
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfakeHostKeyForAidenBotComputerTests0123456789";

interface FakeConfig {
  log: string;
  stale?: string;
  limit?: number;
  vncHost?: string;
}

interface LoggedCall {
  kind: string;
  op?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  command?: string;
}

function harness(overrides: Partial<BotComputerHostDependencies> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "p8-host-"));
  const root = path.join(dir, "bot-computers");
  const configFile = path.join(dir, "fake-config.json");
  const config: FakeConfig = { log: path.join(dir, "lume-calls.jsonl") };
  const writeConfig = () => writeFileSync(configFile, JSON.stringify(config));
  writeConfig();
  const secrets = new Map<string, string>();
  const sshCalls: { args: readonly string[]; stdin?: string }[] = [];
  const fetches: { url: string; redirect?: RequestRedirect }[] = [];
  const idle: { botId?: string; callback: () => void; ms: number; cancelled: boolean }[] = [];
  let clock = 1_000_000_000;
  const events = { ready: 0, removed: 0 };
  const runProcess = async (command: string, args: readonly string[], options: BoundedProcessOptions): Promise<BoundedProcessResult> => {
    const done = { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false };
    if (command.endsWith("ssh-keygen")) {
      const file = args[args.indexOf("-f") + 1] ?? "";
      writeFileSync(file, "PRIVATE", { mode: 0o600 });
      writeFileSync(`${file}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAidenKeyForBotComputerProvisioningTests012345678 aiden\n");
      return done;
    }
    sshCalls.push({ args, stdin: options.stdin });
    return { ...done, stdout: "guest says hi\n" };
  };
  const host = createBotComputerHost({
    root,
    lume: async () => ({ command: process.execPath, prefixArgs: [fake, "--fake-config", configFile] }),
    support: () => ({ ok: true }),
    botComputerDir: async (botId) => path.join(dir, "bots", botId, "Computer"),
    botName: (botId) => botId.charAt(0).toUpperCase() + botId.slice(1),
    secrets: {
      set: async (name, value) => void secrets.set(name, value),
      deleteFamily: async (prefix) => {
        for (const key of [...secrets.keys()]) if (key === prefix || key.startsWith(`${prefix}:`)) secrets.delete(key);
      },
    },
    env: { LANG: "en_US.UTF-8", AIDEN_E2E_FAKE_LUME_LOG: "/must/not/pass/through", LUME_TELEMETRY_ENABLED: "true" },
    resources: { freeDiskBytes: async () => 1e13, availableMemoryBytes: async () => 64 * 1024 ** 3 },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      fetches.push({ url: String(url), redirect: init?.redirect });
      return new Response(new Uint8Array(restoreImage));
    }) as typeof fetch,
    image: {
      version: "26.6.2",
      build: "25G83",
      url: "https://updates.cdn-apple.com/test/UniversalMac_26.6.2_25G83_Restore.ipsw",
      bytes: restoreImage.length,
      sha256: createHash("sha256").update(restoreImage).digest("hex"),
    },
    now: () => clock,
    schedule: (callback, ms) => {
      const entry = { callback, ms, cancelled: false };
      idle.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    pollIntervalMs: 20,
    startTimeoutMs: 20_000,
    runProcess,
    vncExposed: async () => false,
    onSetupReady: () => void (events.ready += 1),
    onRemoved: () => void (events.removed += 1),
    ...overrides,
  });
  const calls = (): LoggedCall[] =>
    existsSync(config.log)
      ? readFileSync(config.log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as LoggedCall)
      : [];
  const fakeState = (): { vms: Record<string, { status: string; pid?: number }> } => {
    try {
      return JSON.parse(readFileSync(path.join(root, "vms", ".fake-state.json"), "utf8")) as { vms: Record<string, { status: string; pid?: number }> };
    } catch {
      return { vms: {} };
    }
  };
  const vmRunning = (vmName: string) => {
    const pid = fakeState().vms[vmName]?.pid;
    if (!pid || fakeState().vms[vmName]?.status !== "running") return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return {
    dir,
    root,
    host,
    config,
    writeConfig,
    secrets,
    sshCalls,
    fetches,
    idle,
    events,
    calls,
    vmRunning,
    advance: (ms: number) => {
      clock += ms;
    },
    async cleanup() {
      await host.shutdown(5_000).catch(() => undefined);
      for (const vm of Object.values(fakeState().vms)) {
        if (vm.pid) {
          try {
            process.kill(vm.pid, "SIGTERM");
          } catch {
            // Already gone.
          }
        }
      }
    },
  };
}

type Harness = ReturnType<typeof harness>;

async function withHost(run: (context: Harness) => Promise<void>, overrides: Partial<BotComputerHostDependencies> = {}) {
  const context = harness(overrides);
  try {
    await run(context);
  } finally {
    await context.cleanup();
  }
  // Whatever happened, every Lume call named Aiden's storage with telemetry off.
  for (const call of context.calls().filter((entry) => entry.kind === "cli")) {
    const args = call.args ?? [];
    assert.equal(call.env?.LUME_TELEMETRY_ENABLED, "false", `${call.op} ran with telemetry off`);
    assert.equal(call.env?.LUME_UPDATE_CHECK, "false");
    assert.equal(call.env?.HOME, path.join(context.root, "home"));
    const storage = path.join(context.root, "vms");
    if (call.op === "clone") {
      assert.equal(args[args.indexOf("--source-storage") + 1], storage);
      assert.equal(args[args.indexOf("--dest-storage") + 1], storage);
    } else {
      assert.equal(args[args.indexOf("--storage") + 1], storage, `${call.op} names Aiden's storage`);
    }
    assert.ok(!["serve", "pull", "update"].includes(call.op ?? ""));
  }
}

async function setUp(context: Harness): Promise<void> {
  await context.host.setUp();
  assert.equal((await context.host.status()).setup.kind, "ready");
}

test("Set up downloads the pinned image, builds and provisions the base, then deletes the image", async () => {
  await withHost(async (context) => {
    const before = await context.host.status();
    assert.equal(before.setup.kind, "not_set_up");
    assert.equal(context.calls().length, 0, "status alone never runs Lume");
    assert.equal(context.fetches.length, 0, "nothing downloads before Set up");

    await setUp(context);
    const status = await context.host.status();
    assert.deepEqual(status.setup, { kind: "ready", baseVersion: "26.6.2", baseBuild: "25G83", updateAvailable: false });
    assert.deepEqual(context.fetches, [{ url: "https://updates.cdn-apple.com/test/UniversalMac_26.6.2_25G83_Restore.ipsw", redirect: "error" }]);
    const ops = context.calls().filter((call) => call.kind === "cli").map((call) => call.op);
    assert.ok(ops.indexOf("create") < ops.indexOf("run"));
    assert.equal(last(ops), "stop", "the base is shut down at the end");
    const create = context.calls().find((call) => call.op === "create");
    assert.equal(create?.args?.[create.args.indexOf("--unattended") + 1], "tahoe");
    const lumeSsh = context.calls().filter((call) => call.kind === "ssh").map((call) => call.command ?? "");
    assert.equal(lumeSsh.length, 2);
    assert.match(lumeSsh[0] ?? "", /authorized_keys/u);
    assert.equal(context.sshCalls.length, 5, "the rest runs over Aiden's own ssh");
    const stored = context.secrets.get(BOT_COMPUTER_GUEST_PASSWORD_SECRET);
    assert.match(stored ?? "", /^[A-Za-z0-9]{32}$/u);
    assert.ok(context.sshCalls.every((call) => !call.args.some((arg) => arg.includes(stored ?? "<none>"))));
    assert.equal(readFileSync(path.join(context.root, "known_hosts"), "utf8"), `aiden-bot-computer ${HOST_KEY}\n`);
    assert.equal(existsSync(path.join(context.root, "restore-images", "UniversalMac_25G83_Restore.ipsw")), false);
    assert.equal(context.vmRunning(BOT_COMPUTER_BASE_VM), false);
    assert.equal(context.events.ready, 1);
  });
});

test("Set up with too little disk says so before downloading", async () => {
  await withHost(
    async (context) => {
      await assert.rejects(context.host.setUp(), (error: unknown) => error instanceof BotComputerError && error.code === "low_disk");
      assert.equal(context.fetches.length, 0);
      const status = await context.host.status();
      assert.equal(status.setup.kind, "failed");
      assert.equal(context.calls().length, 0);
    },
    { resources: { freeDiskBytes: async () => 1_000, availableMemoryBytes: async () => 64 * 1024 ** 3 } },
  );
});

test("the free space Settings states before Set up is the space Set up checks for", async () => {
  let free = 0;
  await withHost(
    async (context) => {
      const { requirements } = await context.host.status();
      assert.equal(requirements.downloadBytes, restoreImage.length);
      free = requirements.setupFreeBytes - 1;
      await assert.rejects(context.host.setUp(), (error: unknown) => error instanceof BotComputerError && error.code === "low_disk");
      assert.equal(context.fetches.length, 0);
      free = requirements.setupFreeBytes;
      await setUp(context);
    },
    { resources: { freeDiskBytes: async () => free, availableMemoryBytes: async () => 64 * 1024 ** 3 } },
  );
});

test("give, run, stop and delete a Bot's computer; delete is idempotent", async () => {
  await withHost(async (context) => {
    await setUp(context);
    const given = await context.host.give("ada");
    assert.equal(given.vmName, botComputerVmName("ada"));
    assert.equal(given.state, "stopped");
    assert.equal(existsSync(path.join(context.dir, "bots", "ada", "Computer")), true);
    assert.equal((await context.host.give("ada")).vmName, given.vmName, "giving twice keeps the same computer");

    const progress: string[] = [];
    const connection = await context.host.ensureRunning("ada", { reason: "tool", onProgress: (text) => progress.push(text) });
    assert.deepEqual(progress, ["Starting Ada's computer…"]);
    assert.equal(connection.vnc.host, "127.0.0.1");
    assert.match(connection.vnc.password, /^[A-Za-z0-9]{32}$/u);
    assert.equal(connection.ssh.user, "lume");
    assert.equal((await context.host.computer("ada"))?.state, "running");
    assert.equal(context.vmRunning(given.vmName), true);
    const run = context.calls().find((call) => call.op === "run" && call.args?.includes(given.vmName));
    assert.equal(run?.args?.[run.args.indexOf("--shared-dir") + 1], `${path.join(context.dir, "bots", "ada", "Computer")}:rw`);
    assert.equal((await context.host.ensureRunning("ada", { reason: "tool" })).vnc.port, connection.vnc.port, "a running computer is reused");

    const result = await context.host.runGuestCommand("ada", "sw_vers", { timeoutMs: 5_000, maxOutputBytes: 1024 });
    assert.equal(result.stdout, "guest says hi\n");
    assert.equal(last([...(last(context.sshCalls)?.args ?? [])])?.includes("sw_vers"), true);

    await context.host.stop("ada", { reason: "person" });
    assert.equal((await context.host.computer("ada"))?.state, "stopped");
    assert.equal(context.vmRunning(given.vmName), false);

    await context.host.ensureRunning("ada", { reason: "viewer" });
    await context.host.deleteForBot("ada");
    assert.equal(await context.host.computer("ada"), undefined);
    assert.equal(context.vmRunning(given.vmName), false);
    await context.host.deleteForBot("ada");
    await context.host.deleteForBot("never-had-one");
    await assert.rejects(context.host.ensureRunning("ada", { reason: "tool" }), (error: unknown) => error instanceof BotComputerError && error.code === "no_computer");
  });
});

test("at the cap the least recently used idle computer stops; with none idle, the start waits", async () => {
  await withHost(async (context) => {
    await setUp(context);
    for (const botId of ["ada", "ben", "cyd"]) await context.host.give(botId);
    await context.host.ensureRunning("ada", { reason: "tool" });
    context.advance(30_000);
    await context.host.ensureRunning("ben", { reason: "tool" });
    context.advance(5 * 60_000);
    context.host.touch("ben");
    context.advance(2 * 60_000);

    // Ada is the least recently used and idle: she gives up her slot.
    await context.host.ensureRunning("cyd", { reason: "tool" });
    assert.equal((await context.host.computer("ada"))?.state, "stopped");
    assert.equal((await context.host.computer("ben"))?.state, "running");

    // Ben and Cyd were both used within the last minute: nobody is idle.
    context.host.touch("ben");
    context.host.touch("cyd");
    const progress: string[] = [];
    const waiting = context.host.ensureRunning("ada", { reason: "routine", onProgress: (text) => progress.push(text) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await context.host.computer("ada"))?.state, "waiting_for_slot");
    assert.deepEqual(progress, ["Waiting for another Bot's computer"]);
    await context.host.stop("cyd", { reason: "person" });
    await waiting;
    assert.equal((await context.host.computer("ada"))?.state, "running");
    assert.deepEqual(progress, ["Waiting for another Bot's computer", "Starting Ada's computer…"]);

    await context.host.updateSettings({ maxRunning: 1 });
    await assert.rejects(context.host.updateSettings({ maxRunning: 3 as 1 }), /two/u);
  });
});

test("idle stop fires after the idle time, but not while the person has control", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.give("ada");
    await context.host.ensureRunning("ada", { reason: "tool" });
    const timer = last(context.idle.filter((entry) => !entry.cancelled));
    assert.equal(timer?.ms, 10 * 60_000);

    context.host.control.takeOver("ada", "viewer");
    timer?.callback();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await context.host.computer("ada"))?.state, "running");
    assert.equal((await context.host.computer("ada"))?.controller, "person");

    context.host.control.giveBack("ada");
    const rearmed = last(context.idle.filter((entry) => !entry.cancelled));
    assert.notEqual(rearmed, timer);
    rearmed?.callback();
    for (let attempt = 0; attempt < 100 && (await context.host.computer("ada"))?.state !== "stopped"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await context.host.computer("ada"))?.state, "stopped");
  });
});

test("pausing a Bot stops its computer, including one still waiting for a slot", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.updateSettings({ maxRunning: 1 });
    await context.host.give("ada");
    await context.host.give("ben");
    await context.host.ensureRunning("ada", { reason: "tool" });
    const waiting = context.host.ensureRunning("ben", { reason: "tool" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await context.host.stop("ben", { reason: "pause" });
    await assert.rejects(waiting, (error: unknown) => error instanceof BotComputerError && error.code === "cancelled");
    await context.host.stop("ada", { reason: "pause" });
    assert.equal(context.vmRunning(botComputerVmName("ada")), false);
    assert.equal((await context.host.computer("ben"))?.state, "stopped");
  });
});

test("reconcile stops VMs an earlier launch left running and reports stale ones for Reset", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.give("ada");
    await context.host.give("ben");
    await context.host.ensureRunning("ada", { reason: "tool" });

    // A relaunch: a new host over the same storage finds Ada's VM running.
    const relaunched = createBotComputerHost({
      root: context.root,
      lume: async () => ({ command: process.execPath, prefixArgs: [fake, "--fake-config", path.join(context.dir, "fake-config.json")] }),
      support: () => ({ ok: true }),
      botComputerDir: async (botId) => path.join(context.dir, "bots", botId, "Computer"),
      secrets: { set: async () => undefined, deleteFamily: async () => undefined },
      resources: { freeDiskBytes: async () => 1e13, availableMemoryBytes: async () => 64 * 1024 ** 3 },
      vncExposed: async () => false,
      pollIntervalMs: 20,
    });
    context.config.stale = botComputerVmName("ben");
    context.writeConfig();
    await relaunched.reconcile();
    assert.equal(context.vmRunning(botComputerVmName("ada")), false);
    assert.equal((await relaunched.computer("ben"))?.state, "stale");
    await assert.rejects(relaunched.ensureRunning("ben", { reason: "tool" }), (error: unknown) => error instanceof BotComputerError && error.code === "stale");

    context.config.stale = undefined;
    context.writeConfig();
    assert.equal((await relaunched.reset("ben")).state, "stopped");
    await relaunched.shutdown(5_000);
  });
});

test("Lume's VM-limit failure becomes a clear message, and the slot is released", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.give("ada");
    await context.host.give("ben");
    await context.host.ensureRunning("ada", { reason: "tool" });
    // Another app holds the second macOS VM slot.
    context.config.limit = 1;
    context.writeConfig();
    await assert.rejects(
      context.host.ensureRunning("ben", { reason: "tool" }),
      (error: unknown) => error instanceof BotComputerError && error.code === "vm_limit" && /two virtual machines/u.test(error.message),
    );
    assert.equal((await context.host.computer("ben"))?.state, "stopped");
  });
});

test("a VNC endpoint off loopback, or one reachable from the network, is refused and the VM stopped", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.give("ada");
    context.config.vncHost = "192.168.1.20";
    context.writeConfig();
    await assert.rejects(
      context.host.ensureRunning("ada", { reason: "tool" }),
      (error: unknown) => error instanceof BotComputerError && error.code === "vnc_not_loopback",
    );
    assert.equal(context.vmRunning(botComputerVmName("ada")), false);
    assert.equal((await context.host.computer("ada"))?.state, "stopped");
  });
  let exposed = false;
  await withHost(
    async (context) => {
      await setUp(context);
      await context.host.give("ada");
      // Reported as 127.0.0.1, but the port answers on another interface.
      exposed = true;
      await assert.rejects(
        context.host.ensureRunning("ada", { reason: "tool" }),
        (error: unknown) => error instanceof BotComputerError && error.code === "vnc_not_loopback",
      );
      assert.equal(context.vmRunning(botComputerVmName("ada")), false);
    },
    { vncExposed: async () => exposed },
  );
});

test("Remove everything deletes every VM, the keys, the guest password and the state", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.give("ada");
    await context.host.ensureRunning("ada", { reason: "tool" });
    context.secrets.set("aiden-internal:other", "kept");
    await context.host.removeEverything();
    assert.equal(context.vmRunning(botComputerVmName("ada")), false);
    assert.equal(existsSync(path.join(context.root, "vms")), false);
    assert.equal(existsSync(path.join(context.root, "id_ed25519")), false);
    assert.equal(existsSync(path.join(context.root, "known_hosts")), false);
    assert.equal(context.secrets.has(BOT_COMPUTER_GUEST_PASSWORD_SECRET), false);
    assert.equal(context.secrets.get("aiden-internal:other"), "kept");
    const status = await context.host.status();
    assert.equal(status.setup.kind, "not_set_up");
    assert.deepEqual(status.computers, []);
    assert.equal(context.events.removed, 1);
    // Reconcile on a removed setup touches nothing.
    const before = context.calls().length;
    await context.host.reconcile();
    assert.equal(context.calls().length, before);
  });
});

test("an unsupported Mac reports why and never runs Lume", async () => {
  await withHost(
    async (context) => {
      assert.deepEqual((await context.host.status()).setup, { kind: "unsupported", reason: "host_os" });
      await assert.rejects(context.host.setUp(), (error: unknown) => error instanceof BotComputerError && error.code === "unsupported");
      await context.host.reconcile();
      assert.equal(context.calls().length, 0);
    },
    { support: () => ({ ok: false, reason: "host_os" }) },
  );
});

test("deleting a Bot on a Mac that never set up computers leaves no trace and runs no Lume", async () => {
  await withHost(async (context) => {
    await context.host.deleteForBot("ada");
    assert.equal(existsSync(context.root), false, "no Bot-computer folder appears in userData");
    assert.equal(context.calls().length, 0);
  });
});
