import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyticsSettled, captureAnalyticsEvents } from "../analytics/test-support.js";

import type { BoundedProcessOptions, BoundedProcessResult } from "./bounded-process.js";
import { createGuestCuaDriverHostFactory } from "./guest-driver.js";
import { createBotComputerHost, type BotComputerHostDependencies } from "./host.js";
import { BOT_COMPUTER_LINUX_VNC_SOCKET } from "./provision.js";
import {
  BOT_COMPUTER_GUEST_PASSWORD_SECRET,
  BOT_COMPUTER_LINUX_MIGRATION_BOT_NOTE,
  BotComputerError,
  BotComputerTakenOverError,
} from "./types.js";
import {
  BOT_COMPUTER_BASE_VM,
  BOT_COMPUTER_SHARED_VM,
  BOT_COMPUTER_STAGING_BASE_VM,
  botComputerVmName,
  botComputerWorkspaceDirName,
} from "./vm-names.js";

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

/** Whether a process still runs. An exited fake VM nobody reaped (a zombie) has stopped. */
function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // /proc/<pid>/stat: "pid (comm) state …"
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") !== true;
  } catch {
    return true;
  }
}

const fake = path.resolve("tests/e2e/lume-fake.mjs");
const restoreImage = Buffer.from("fake macOS restore image for host tests\n".repeat(64));
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfakeHostKeyForAidenBotComputerTests0123456789";

interface FakeConfig {
  log: string;
  stale?: string;
  limit?: number;
  lowDisk?: string;
  vncHost?: string;
  stopDelayMs?: number;
  stopFails?: string;
  stopFailsBooting?: string;
  cloneDelayMs?: number;
  runLaunchDelayMs?: number;
  runIgnoresTerm?: boolean;
  runReturnDelayMs?: number;
  runFailsLate?: string;
  bootDelayMs?: number;
  hostKey?: string;
}

interface FakeVm {
  status: string;
  pid?: number;
  ip?: string;
  hostKey?: string;
}

interface LoggedCall {
  /** When the fake started handling the call (ms since the epoch). */
  at?: number;
  kind: string;
  pid?: number;
  /** The VM a `vnc` or `spawned` entry plays. */
  name?: string;
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
  const sshCalls: { args: readonly string[]; stdin?: string; stdinFile?: string }[] = [];
  const vncTunnels: { host: string; remoteSocket: string; port: number; closed: boolean }[] = [];
  const fetches: { url: string; redirect?: RequestRedirect }[] = [];
  const idle: { botId?: string; callback: () => void; ms: number; cancelled: boolean }[] = [];
  let clock = 1_000_000_000;
  const events = { ready: 0, removed: 0 };
  /** A guest command that should fail, for example one step of provisioning, or answer with its own output. */
  const ssh: {
    fails?: (args: readonly string[]) => boolean;
    stdout?: (args: readonly string[]) => string | undefined;
    onCall?: (args: readonly string[]) => Promise<void> | void;
  } = {};
  const runProcess = async (command: string, args: readonly string[], options: BoundedProcessOptions): Promise<BoundedProcessResult> => {
    const done = { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false };
    if (command.endsWith("ssh-keygen")) {
      const file = args[args.indexOf("-f") + 1] ?? "";
      writeFileSync(file, "PRIVATE", { mode: 0o600 });
      writeFileSync(`${file}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAidenKeyForBotComputerProvisioningTests012345678 aiden\n");
      return done;
    }
    if (command.endsWith("ssh-keyscan")) {
      const targetIp = args[args.length - 1] ?? "";
      const guest = Object.values(fakeState().vms).find((vm) => vm.ip === targetIp);
      return { ...done, stdout: `${targetIp} ${guest?.hostKey ?? HOST_KEY}\n` };
    }
    sshCalls.push({ args, stdin: options.stdin, stdinFile: options.stdinFile });
    await ssh.onCall?.(args);
    // As ssh with StrictHostKeyChecking=yes: the guest's own host key must be pinned under the alias.
    const address = args[args.indexOf("--") + 1];
    const guest = Object.values(fakeState().vms).find((vm) => vm.ip === address);
    const knownHosts = path.join(root, "known_hosts");
    const pinned = existsSync(knownHosts) ? readFileSync(knownHosts, "utf8").split("\n") : [];
    if (guest?.hostKey && !pinned.includes(`aiden-bot-computer ${guest.hostKey}`)) {
      return { ...done, exitCode: 255, stderr: "Host key verification failed.\n" };
    }
    if (ssh.fails?.(args)) return { ...done, exitCode: 1, stderr: "the guest step failed\n" };
    return { ...done, stdout: ssh.stdout?.(args) ?? "guest says hi\n" };
  };
  // Restore images by URL; anything else gets the default pin's bytes.
  const served = new Map<string, Buffer>();
  /** `missing` makes every later Lume call fail to start, as when the helper has gone. */
  const lumeHelper = { missing: false };
  const deps: BotComputerHostDependencies = {
    root,
    lume: async () => ({
      get command() {
        return lumeHelper.missing ? path.join(dir, "missing-lume") : process.execPath;
      },
      prefixArgs: [fake, "--fake-config", configFile],
    }),
    support: () => ({ ok: true }),
    botComputerDir: async (botId) => path.join(dir, "bots", botId, "Computer"),
    botName: (botId) => botId.charAt(0).toUpperCase() + botId.slice(1),
    secrets: {
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => void secrets.set(name, value),
      deleteFamily: async (prefix) => {
        for (const key of [...secrets.keys()]) if (key === prefix || key.startsWith(`${prefix}:`)) secrets.delete(key);
      },
    },
    env: { LANG: "en_US.UTF-8", AIDEN_E2E_FAKE_LUME_LOG: "/must/not/pass/through", LUME_TELEMETRY_ENABLED: "true" },
    resources: { freeDiskBytes: async () => 1e13, availableMemoryBytes: async () => 64 * 1024 ** 3 },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      fetches.push({ url: String(url), redirect: init?.redirect });
      return new Response(new Uint8Array(served.get(String(url)) ?? restoreImage));
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
    openVncTunnel: async (target, remoteSocket) => {
      const server = createServer((socket) => socket.end());
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const record = { host: target.host, remoteSocket, port, closed: false };
      vncTunnels.push(record);
      return {
        host: "127.0.0.1" as const,
        port,
        close: async () => {
          if (record.closed) return;
          record.closed = true;
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    },
    onSetupReady: () => void (events.ready += 1),
    onRemoved: () => void (events.removed += 1),
    ...overrides,
  };
  const host = createBotComputerHost(deps);
  // A later launch over the same storage, for example an Aiden release that pins a newer image.
  const relaunched: ReturnType<typeof createBotComputerHost>[] = [];
  const relaunch = (changes: Partial<BotComputerHostDependencies>) => {
    const next = createBotComputerHost({ ...deps, ...changes });
    relaunched.push(next);
    return next;
  };
  const calls = (): LoggedCall[] =>
    existsSync(config.log)
      ? readFileSync(config.log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as LoggedCall)
      : [];
  function fakeState(): { vms: Record<string, FakeVm> } {
    try {
      return JSON.parse(readFileSync(path.join(root, "vms", ".fake-state.json"), "utf8")) as { vms: Record<string, FakeVm> };
    } catch {
      return { vms: {} };
    }
  }
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
    lumeHelper,
    secrets,
    sshCalls,
    vncTunnels,
    ssh,
    fetches,
    idle,
    events,
    calls,
    vmRunning,
    relaunch,
    serve: (url: string, bytes: Buffer) => void served.set(url, bytes),
    /** The process playing a VM, while the fake Lume lists it. */
    vmPid: (vmName: string) => fakeState().vms[vmName]?.pid,
    /** The VMs the fake Lume holds in Aiden's storage. */
    vmNames: () => Object.keys(fakeState().vms).sort(),
    advance: (ms: number) => {
      clock += ms;
    },
    async cleanup() {
      await host.shutdown(5_000).catch(() => undefined);
      for (const other of relaunched) await other.shutdown(5_000).catch(() => undefined);
      // Every fake VM this test started, including one left running after its storage went.
      const pids = new Set([
        ...Object.values(fakeState().vms).map((vm) => vm.pid),
        ...calls()
          .filter((call) => call.kind === "vnc" || call.kind === "spawned")
          .map((call) => call.pid),
      ]);
      for (const pid of pids) {
        if (!pid) continue;
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already gone.
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
    if (call.op === "run") {
      assert.ok(args.includes("--no-audio-device"), "every VM start leaves out the host audio device");
      assert.ok(args.includes("--no-clipboard-device"), "every VM start leaves out the host clipboard device");
      assert.equal(args.includes("--clipboard"), false, "no VM start enables host clipboard sync");
    }
    assert.ok(!["serve", "pull", "update"].includes(call.op ?? ""));
  }
}

async function setUp(context: Harness, mode: "dedicated" | "shared" = "dedicated"): Promise<void> {
  await context.host.setUp();
  assert.equal((await context.host.status()).setup.kind, "ready");
  if (mode === "dedicated") {
    await context.host.updateSettings({ defaultComputerMode: "dedicated" });
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Set up downloads the pinned image, builds and provisions the base, then deletes the image", async () => {
  await withHost(async (context) => {
    const before = await context.host.status();
    assert.equal(before.setup.kind, "not_set_up");
    assert.equal(await context.host.baseReady(), false, "no Bot can use a computer before Set up");
    assert.equal(context.calls().length, 0, "status alone never runs Lume");
    assert.equal(context.fetches.length, 0, "nothing downloads before Set up");

    await setUp(context);
    assert.equal(await context.host.baseReady(), true);
    const status = await context.host.status();
    assert.deepEqual(status.setup, { kind: "ready", baseVersion: "26.6.2", baseBuild: "25G83", updateAvailable: false });
    assert.deepEqual(context.fetches, [{ url: "https://updates.cdn-apple.com/test/UniversalMac_26.6.2_25G83_Restore.ipsw", redirect: "manual" }]);
    const ops = context.calls().filter((call) => call.kind === "cli").map((call) => call.op);
    assert.ok(ops.indexOf("create") < ops.indexOf("run"));
    assert.equal(last(ops), "stop", "the base is shut down at the end");
    const create = context.calls().find((call) => call.op === "create");
    assert.equal(create?.args?.[create.args.indexOf("--os") + 1], "linux");
    assert.equal(context.calls().filter((call) => call.kind === "ssh").length, 0, "Linux provisioning never uses password lume ssh");
    assert.ok(context.sshCalls.length >= 6, "provisioning runs over Aiden's own ssh");
    const stored = context.secrets.get(BOT_COMPUTER_GUEST_PASSWORD_SECRET);
    assert.match(stored ?? "", /^[A-Za-z0-9]{32}$/u);
    assert.ok(context.sshCalls.every((call) => !call.args.some((arg) => arg.includes(stored ?? "<none>"))));
    assert.equal(readFileSync(path.join(context.root, "known_hosts"), "utf8"), `aiden-bot-computer ${HOST_KEY}\n`);
    assert.equal(existsSync(path.join(context.root, "restore-images", "debian-25G83.raw")), false);
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

test("Set up with too little free memory says so before downloading, and again before it boots the base", async () => {
  const plenty = 64 * 1024 ** 3;
  const short = 1 * 1024 ** 3;
  let memory = short;
  // What the Mac has free once the download has run, which takes a while.
  let memoryAfterDownload = plenty;
  let downloads = 0;
  await withHost(
    async (context) => {
      await assert.rejects(
        context.host.setUp(),
        (error: unknown) => error instanceof BotComputerError && error.code === "low_memory" && /free memory/u.test(error.message),
      );
      assert.equal(downloads, 0, "nothing downloads");
      assert.equal(context.calls().length, 0, "no Lume runs");
      assert.equal((await context.host.status()).setup.kind, "failed");

      memory = plenty;
      memoryAfterDownload = short;
      await assert.rejects(context.host.setUp(), (error: unknown) => error instanceof BotComputerError && error.code === "low_memory");
      assert.equal(downloads, 1);
      assert.equal(context.calls().some((call) => call.op === "create"), false, "no VM is made without the memory to boot it");

      memory = plenty;
      memoryAfterDownload = plenty;
      await context.host.setUp();
      assert.equal((await context.host.status()).setup.kind, "ready");
      assert.equal(downloads, 1, "the verified download is reused");
    },
    {
      resources: { freeDiskBytes: async () => 1e13, availableMemoryBytes: async () => memory },
      fetchImpl: (async () => {
        downloads += 1;
        memory = memoryAfterDownload;
        return new Response(new Uint8Array(restoreImage));
      }) as typeof fetch,
    },
  );
});

test("cancelling Set up keeps the partial download, and the next Set up resumes it with Range", async () => {
  const half = Math.floor(restoreImage.length / 2);
  const ranges: (string | null)[] = [];
  await withHost(
    async (context) => {
      const partial = path.join(context.root, "restore-images", "debian-25G83.raw.part");
      const first = context.host.setUp();
      for (let attempt = 0; attempt < 200 && !(existsSync(partial) && statSync(partial).size === half); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(statSync(partial).size, half, "half the image arrived before Cancel");
      context.host.cancelSetUp();
      await first;
      assert.deepEqual((await context.host.status()).setup, {
        kind: "failed",
        message: "Set up was cancelled. Choose Set up to continue where it stopped.",
        resumable: true,
      });
      assert.equal(context.calls().length, 0, "no VM work starts after Cancel");

      await setUp(context);
      assert.deepEqual(ranges, [null, `bytes=${half}-`]);
    },
    {
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        const range = new Headers(init?.headers).get("range");
        ranges.push(range);
        if (range) {
          const from = Number(/^bytes=(\d+)-$/u.exec(range)?.[1]);
          return new Response(new Uint8Array(restoreImage.subarray(from)), {
            status: 206,
            headers: { "content-range": `bytes ${from}-${restoreImage.length - 1}/${restoreImage.length}` },
          });
        }
        // The first answer sends half the image, then nothing until it is cancelled.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(restoreImage.subarray(0, half)));
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
          },
        });
        return new Response(body);
      }) as typeof fetch,
    },
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

    context.host.activity.set("ada", "Ada is using the computer: Open Safari");
    assert.equal((await context.host.computer("ada"))?.activity, "Ada is using the computer: Open Safari");
    await context.host.stop("ada", { reason: "person" });
    assert.equal((await context.host.computer("ada"))?.state, "stopped");
    assert.equal((await context.host.computer("ada"))?.activity, undefined, "what the Bot was doing ends with the run");
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

test("a Bot whose Computer folder path holds a colon is refused a computer before anything is made", async () => {
  const colonDir = mkdtempSync(path.join(tmpdir(), "p8-colon-"));
  await withHost(
    async (context) => {
      await setUp(context);
      await assert.rejects(context.host.give("ada"), (error: unknown) => error instanceof BotComputerError && error.code === "invalid" && /colon/u.test(error.message));
      assert.equal(context.calls().some((call) => call.op === "clone"), false);
      assert.equal(await context.host.computer("ada"), undefined);
    },
    { botComputerDir: async (botId) => path.join(colonDir, `bot:${botId}`, "Computer") },
  );
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
    await assert.rejects(context.host.updateSettings({ maxRunning: 5 as 1 }), /At most 4/u);
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

test("a computer that stops while the person holds it goes back to the Bot, unless a sign-in card holds it", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.give("ada");
    await context.host.ensureRunning("ada", { reason: "viewer" });
    context.host.control.takeOver("ada", "viewer");
    // The Bot's next call waits for Give back.
    let resumed = false;
    void context.host.control.waitForBot("ada", undefined).then(() => {
      resumed = true;
    });

    await context.host.stop("ada", { reason: "pause" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await context.host.computer("ada"))?.controller, "bot", "nobody can use a computer that is off");
    assert.equal(resumed, true, "the waiting call goes on instead of waiting for a Give back the tab can't offer");

    // Started again, it idles out as usual.
    await context.host.ensureRunning("ada", { reason: "viewer" });
    context.advance(2 * 60_000);
    last(context.idle.filter((entry) => !entry.cancelled))?.callback();
    await waitFor(async () => (await context.host.computer("ada"))?.state === "stopped", "the idle stop");

    // A sign-in hold lasts until its card settles or is withdrawn, even across a stop.
    await context.host.ensureRunning("ada", { reason: "viewer" });
    context.host.control.takeOver("ada", "sign_in");
    await context.host.stop("ada", { reason: "person" });
    assert.equal((await context.host.computer("ada"))?.controller, "person");
    assert.equal(context.host.control.takenOverBy("ada"), "sign_in");
  });
});

test("a stop Lume fails to carry out leaves the computer running, as Lume reports it", async () => {
  await withHost(async (context) => {
    await setUp(context);
    const { vmName } = await context.host.give("ada");
    const connection = await context.host.ensureRunning("ada", { reason: "tool" });
    context.config.stopFails = vmName;
    context.writeConfig();
    await assert.rejects(context.host.stop("ada", { reason: "person" }), (error: unknown) => error instanceof BotComputerError && error.code === "lume_failed");
    assert.equal(context.vmRunning(vmName), true);
    assert.equal((await context.host.computer("ada"))?.state, "running", "still running, still taking its place");
    assert.equal(context.host.runningConnection("ada")?.vnc.port, connection.vnc.port);
    assert.equal((await context.host.ensureRunning("ada", { reason: "tool" })).vnc.password, connection.vnc.password, "no second start");

    context.config.stopFails = undefined;
    context.writeConfig();
    await context.host.stop("ada", { reason: "person" });
    assert.equal(context.vmRunning(vmName), false);
    assert.equal((await context.host.computer("ada"))?.state, "stopped");
    assert.equal(context.host.runningConnection("ada"), undefined);
  });
});

const failsWith = (code: BotComputerError["code"]) => (error: unknown) => error instanceof BotComputerError && error.code === code;

test("a start cancelled or failing after Lume launched the VM turns it off; one Lume can't turn off keeps its place, and one Lume never ran for holds none", async () => {
  await withHost(async (context) => {
    await setUp(context);
    const { vmName } = await context.host.give("ada");
    const launches = () => context.calls().filter((call) => call.kind === "vnc" && call.name === vmName).length;

    // `lume run --detach` has launched the VM but not returned when the only caller gives up, and Pause follows.
    context.config.runReturnDelayMs = 1_000;
    context.writeConfig();
    const caller = new AbortController();
    const cancelled = context.host.ensureRunning("ada", { reason: "tool", signal: caller.signal });
    await waitFor(() => launches() === 1, "the detached VM");
    caller.abort();
    await assert.rejects(cancelled, failsWith("cancelled"));
    await context.host.stop("ada", { reason: "pause" });
    assert.equal(context.vmRunning(vmName), false, "the VM the cancelled start launched is off once Pause returns");
    assert.equal((await context.host.computer("ada"))?.state, "stopped");

    // `run` exits non-zero after it launched the VM.
    context.config.runReturnDelayMs = undefined;
    context.config.runFailsLate = vmName;
    context.writeConfig();
    await assert.rejects(context.host.ensureRunning("ada", { reason: "tool" }), failsWith("start_failed"));
    assert.equal(launches(), 2);
    assert.equal(context.vmRunning(vmName), false);
    assert.equal((await context.host.computer("ada"))?.state, "stopped");

    // When even the forced stop fails, the computer reads running, with no connection to use, and keeps its place.
    context.config.stopFails = vmName;
    context.writeConfig();
    await assert.rejects(context.host.ensureRunning("ada", { reason: "tool" }), failsWith("start_failed"));
    assert.equal(context.vmRunning(vmName), true);
    assert.equal((await context.host.computer("ada"))?.state, "running");
    assert.equal(context.host.runningConnection("ada"), undefined);
    // Whoever's start meets it, the message says whose computer Aiden couldn't stop.
    const couldNotStopAdas = (error: unknown) => failsWith("lume_failed")(error) && /couldn't stop Ada's computer/u.test((error as Error).message);
    await assert.rejects(context.host.stop("ada", { reason: "pause" }), couldNotStopAdas);
    assert.equal((await context.host.computer("ada"))?.state, "running", "a Pause that couldn't turn it off doesn't call it stopped");
    await assert.rejects(context.host.ensureRunning("ada", { reason: "tool" }), couldNotStopAdas, "Ada's next start turns it off first");
    await context.host.updateSettings({ maxRunning: 1 });
    await context.host.give("ben");
    await assert.rejects(context.host.ensureRunning("ben", { reason: "tool" }), couldNotStopAdas, "Ben's start needs the place Ada's VM still holds");
    assert.equal(context.vmRunning(botComputerVmName("ben")), false);

    // Once Lume can stop it, Ada's next start turns it off first and starts afresh.
    context.config.stopFails = undefined;
    context.config.runFailsLate = undefined;
    context.writeConfig();
    const connection = await context.host.ensureRunning("ada", { reason: "tool" });
    assert.equal(launches(), 4);
    assert.equal(context.vmRunning(vmName), true);
    assert.equal(context.host.runningConnection("ada")?.vnc.password, connection.vnc.password);

    // A Lume that can't be started at all launched nothing: Ben's start fails and holds no place.
    await context.host.stop("ada", { reason: "pause" });
    context.lumeHelper.missing = true;
    await assert.rejects(context.host.ensureRunning("ben", { reason: "tool" }), failsWith("lume_failed"));
    assert.equal((await context.host.computer("ben"))?.state, "stopped", "Ben's computer gives up the place it never used");
    context.lumeHelper.missing = false;
    await context.host.ensureRunning("ada", { reason: "tool" });
    assert.equal(context.vmRunning(vmName), true, "the one place is free for Ada");
  });
});

test("a start cancelled while the VM Lume launched is still coming up turns it off once it is up, before Pause returns", async () => {
  await withHost(async (context) => {
    await setUp(context);
    const { vmName } = await context.host.give("ada");
    const logged = (kind: string) => context.calls().filter((call) => call.kind === kind && call.name === vmName);
    // As with Lume's detach branch, the VM comes up a while after `run` launched its process.
    context.config.bootDelayMs = 1_000;

    // Cancelled once the VM's process exists, while `run` is still returning.
    context.config.runReturnDelayMs = 300;
    context.writeConfig();
    let caller = new AbortController();
    let cancelled = context.host.ensureRunning("ada", { reason: "tool", signal: caller.signal });
    await waitFor(() => logged("spawned").length === 1, "the VM's process");
    caller.abort();
    await assert.rejects(cancelled, failsWith("cancelled"));
    assert.equal((await context.host.computer("ada"))?.state, "starting", "it keeps its place while its VM may come up");
    await context.host.stop("ada", { reason: "pause" });
    await waitFor(() => logged("vnc").length === 1, "the VM to come up");
    assert.equal(context.vmRunning(vmName), false, "the VM that came up after the cancel is off once Pause returns");
    assert.equal((await context.host.computer("ada"))?.state, "stopped");

    // Cancelled after `run` returned, while Aiden asks Lume whether the VM is up yet.
    context.config.runReturnDelayMs = undefined;
    context.writeConfig();
    caller = new AbortController();
    cancelled = context.host.ensureRunning("ada", { reason: "tool", signal: caller.signal });
    await waitFor(() => logged("spawned").length === 2, "the VM's process");
    const spawnedAt = last(logged("spawned"))?.at ?? 0;
    await waitFor(() => context.calls().some((call) => call.op === "get" && (call.at ?? 0) >= spawnedAt), "the first check");
    caller.abort();
    await assert.rejects(cancelled, failsWith("cancelled"));
    await context.host.stop("ada", { reason: "pause" });
    await waitFor(() => logged("vnc").length === 2, "the VM to come up");
    assert.equal(context.vmRunning(vmName), false);
    assert.equal((await context.host.computer("ada"))?.state, "stopped");

    // Cancelled while `run` is still returning, and Lume's forced stop of the VM that is still
    // coming up fails without saying why, while Lume says it isn't running.
    context.config.stopFailsBooting = vmName;
    context.config.runReturnDelayMs = 300;
    context.writeConfig();
    caller = new AbortController();
    cancelled = context.host.ensureRunning("ada", { reason: "tool", signal: caller.signal });
    await waitFor(() => logged("spawned").length === 3, "the VM's process");
    caller.abort();
    await assert.rejects(cancelled, failsWith("cancelled"));
    await context.host.stop("ada", { reason: "pause" });
    await waitFor(() => logged("vnc").length === 3, "the VM to come up");
    assert.equal(context.vmRunning(vmName), false, "a stop that failed while the VM was coming up doesn't end the watch");
    assert.equal((await context.host.computer("ada"))?.state, "stopped");
    context.config.stopFailsBooting = undefined;
    context.config.runReturnDelayMs = undefined;
    context.writeConfig();

    // Started again, it comes up as usual.
    await context.host.ensureRunning("ada", { reason: "tool" });
    assert.equal(context.vmRunning(vmName), true);
  });
});

test("a Bot call that waited for Give back starts nothing while Reset, Delete or Remove everything replaces the computer", async () => {
  await withHost(async (context) => {
    await setUp(context);
    const { vmName } = await context.host.give("ada");
    await context.host.ensureRunning("ada", { reason: "tool" });
    // The person holds the computer, and the Bot's next call waits for it, as the computer tool does.
    const botCall = () => {
      context.host.control.takeOver("ada", "viewer");
      return context.host.control.waitForBot("ada", undefined).then(() => context.host.ensureRunning("ada", { reason: "tool" }));
    };
    const cli = () => context.calls().filter((call) => call.kind === "cli");

    // Reset stops the computer, which gives it back to the Bot, then copies the base afresh.
    const afterReset = botCall();
    const reset = await context.host.reset("ada");
    assert.equal(reset.outdated, false);
    const connection = await afterReset;
    const ops = cli().map((call) => call.op);
    assert.ok(ops.lastIndexOf("clone") < ops.lastIndexOf("run"), "the Bot's call starts the fresh copy, after it was made");
    assert.equal(context.vmRunning(vmName), true);
    assert.equal(context.host.runningConnection("ada")?.vnc.password, connection.vnc.password);

    // Deleting the Bot's computer, then Remove everything: the waiting call finds no computer,
    // and nothing starts while the VM or its files go.
    const removals: Array<[string, () => Promise<unknown>]> = [
      ["delete", () => context.host.deleteForBot("ada")],
      ["remove everything", () => context.host.removeEverything()],
    ];
    for (const [what, remove] of removals) {
      if (!(await context.host.computer("ada"))) {
        await context.host.give("ada");
        await context.host.ensureRunning("ada", { reason: "tool" });
      }
      const waiting = botCall();
      const before = cli().length;
      await remove();
      await assert.rejects(waiting, (error: unknown) => error instanceof BotComputerError && error.code === "no_computer", what);
      assert.deepEqual(
        cli()
          .slice(before)
          .filter((call) => call.op === "run"),
        [],
        `no computer starts during ${what}`,
      );
      assert.equal(context.vmRunning(vmName), false, what);
    }
  });
});

test("Give, Reset, Delete and Remove everything of a computer take turns in the order they were asked for", async () => {
  await withHost(async (context) => {
    await setUp(context);
    const vmName = botComputerVmName("ada");
    const clones = () => context.calls().filter((call) => call.op === "clone").length;
    const copyTakes = (ms: number | undefined) => {
      context.config.cloneDelayMs = ms;
      context.writeConfig();
    };
    await context.host.give("ada");

    // Delete while Reset copies the base: Reset finishes, then Delete removes the fresh copy.
    copyTakes(300);
    let copies = clones();
    const resetting = context.host.reset("ada");
    await waitFor(() => clones() > copies, "Reset's copy");
    await context.host.deleteForBot("ada");
    assert.equal((await resetting).vmName, vmName);
    assert.equal(await context.host.computer("ada"), undefined, "the deleted computer stays deleted");
    assert.deepEqual(context.vmNames(), [BOT_COMPUTER_BASE_VM]);

    // Delete while Give copies the base: the computer Give made is the one deleted.
    copies = clones();
    const giving = context.host.give("ada");
    await waitFor(() => clones() > copies, "Give's copy");
    await context.host.deleteForBot("ada");
    assert.equal((await giving).vmName, vmName);
    assert.equal(await context.host.computer("ada"), undefined);
    assert.deepEqual(context.vmNames(), [BOT_COMPUTER_BASE_VM]);

    // Remove everything while Reset copies: Reset finishes first, and a Give asked for afterwards finds nothing set up.
    copyTakes(undefined);
    await context.host.give("ada");
    copyTakes(300);
    copies = clones();
    const lateReset = context.host.reset("ada");
    await waitFor(() => clones() > copies, "Reset's copy");
    const removing = context.host.removeEverything();
    const givenAfter = context.host.give("ben");
    await removing;
    assert.equal((await lateReset).vmName, vmName);
    await assert.rejects(givenAfter, failsWith("not_set_up"));
    assert.deepEqual((await context.host.status()).computers, []);
    assert.equal(existsSync(path.join(context.root, "vms")), false, "no VM is left or made again");
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

test("quitting stops every running computer inside its budget, and nothing starts afterwards", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.updateSettings({ maxRunning: 1 });
    await context.host.give("ada");
    await context.host.give("ben");
    await context.host.ensureRunning("ada", { reason: "tool" });
    // Quit settles the waiting start, so its outcome is kept from the start.
    const waiting = context.host.ensureRunning("ben", { reason: "routine" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await context.host.computer("ben"))?.state, "waiting_for_slot");

    // A stop that takes longer than the budget can't hold quit.
    context.config.stopDelayMs = 1_500;
    context.writeConfig();
    const started = Date.now();
    await context.host.shutdown(300);
    assert.ok(Date.now() - started < 1_200, `shutdown returned at its deadline (${Date.now() - started} ms)`);
    assert.ok((await waiting) instanceof BotComputerError, "the waiting start gives up");
    await assert.rejects(context.host.ensureRunning("ada", { reason: "tool" }), (error: unknown) => error instanceof BotComputerError && error.code === "busy");

    // The forced stop still lands, so no VM outlives Aiden.
    for (let attempt = 0; attempt < 150 && context.vmRunning(botComputerVmName("ada")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(context.vmRunning(botComputerVmName("ada")), false);
    const stop = context.calls().find((call) => call.op === "stop" && call.args?.includes(botComputerVmName("ada")));
    assert.ok(stop?.args?.includes("--force"), "quit powers the computer off rather than waiting on the guest");
    assert.equal(context.vmRunning(botComputerVmName("ben")), false, "the waiting computer never started");
    context.config.stopDelayMs = undefined;
    context.writeConfig();
  });
});

test("quitting while Lume's run is still starting up leaves no computer running after Aiden has gone", { timeout: 60_000 }, async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.give("ada");
    const vmName = botComputerVmName("ada");
    // A later launch of Aiden, over the same storage, quits while it starts Ada's computer.
    await context.host.shutdown(5_000);
    // Lume's run takes longer to start up, before it launches anything, than quit waits,
    // and it handles TERM, so only SIGKILL ends it inside the budget.
    const launchDelayMs = 1_500;
    context.config.runLaunchDelayMs = launchDelayMs;
    context.config.runIgnoresTerm = true;
    context.writeConfig();
    const budgetMs = 300;
    const runs = () => context.calls().filter((call) => call.kind === "cli" && call.op === "run");
    const before = runs().length;
    const aiden = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("main/services/bot-computers/test-support/quit-mid-launch.ts"),
        context.root,
        fake,
        path.join(context.dir, "fake-config.json"),
        path.join(context.dir, "bots"),
        "ada",
        String(budgetMs),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      const quit = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        let stdout = "";
        aiden.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        aiden.on("error", reject);
        aiden.on("close", (code) => resolve({ code, stdout }));
      });
      assert.equal(quit.code, 0);
      assert.equal(quit.stdout, "quit\n", "Aiden quit once its budget was over");
      const run = last(runs());
      assert.ok(runs().length > before && run?.pid, "Lume's run had begun when Aiden quit");
      // Ended with Aiden, not when its start-up would have finished (allowing a moment for the reap).
      const reaped = Date.now() + 500;
      while (processRunning(run.pid) && Date.now() < reaped) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(processRunning(run.pid), false, "Lume's run ended when Aiden quit");

      // Aiden has gone. Wait until Lume's run would have launched the computer and it would be up.
      const runAt = run.at ?? Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, runAt + launchDelayMs + 1_000 - Date.now())));
      assert.equal(context.vmRunning(vmName), false, "no computer comes up after Aiden has quit");
      const launched = context.calls().filter((call) => call.kind === "spawned" && call.name === vmName && (call.at ?? 0) >= runAt);
      assert.deepEqual(
        launched.filter((call) => call.pid !== undefined && processRunning(call.pid)),
        [],
        "nothing the quitting launch started is still running",
      );
    } finally {
      // A failure above leaves neither the helper nor a `run` that ignores TERM behind.
      if (aiden.exitCode === null && aiden.signalCode === null) aiden.kill("SIGKILL");
      for (const call of runs().slice(before)) {
        if (call.pid && processRunning(call.pid)) process.kill(call.pid, "SIGKILL");
      }
      context.config.runLaunchDelayMs = undefined;
      context.config.runIgnoresTerm = undefined;
      context.writeConfig();
    }
  });
});

test("quitting while Lume's run is launching a computer that is still coming up turns it off before Aiden has gone", async () => {
  await withHost(async (context) => {
    await setUp(context);
    const { vmName } = await context.host.give("ada");
    const logged = (kind: string) => context.calls().filter((call) => call.kind === kind && call.name === vmName);
    // Lume's run has launched the VM, which comes up well inside quit's budget, and would only
    // return after it.
    const bootDelayMs = 400;
    const budgetMs = 4_000;
    context.config.bootDelayMs = bootDelayMs;
    context.config.runReturnDelayMs = 6_000;
    context.writeConfig();
    try {
      const starting = context.host.ensureRunning("ada", { reason: "tool" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitFor(() => logged("spawned").length === 1, "the VM's process");
      const spawned = logged("spawned")[0]!;
      const run = last(context.calls().filter((call) => call.kind === "cli" && call.op === "run"));
      assert.ok(run?.pid);

      const quitAt = Date.now();
      await context.host.shutdown(budgetMs);
      assert.ok(Date.now() - quitAt < budgetMs - 500, `quit returned once the computer was off (${Date.now() - quitAt} ms)`);
      assert.ok((await starting) instanceof BotComputerError, "the start gives up");
      const reaped = Date.now() + 500;
      while (processRunning(run.pid) && Date.now() < reaped) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(processRunning(run.pid), false, "Lume's run ended when Aiden quit");
      assert.equal(context.vmRunning(vmName), false, "the computer is off when quit returns");

      // Nothing comes up once Aiden has gone.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, (spawned.at ?? Date.now()) + bootDelayMs + 1_000 - Date.now())));
      assert.equal(context.vmRunning(vmName), false);
      assert.equal(spawned.pid !== undefined && processRunning(spawned.pid), false, "the VM's process has ended");
    } finally {
      context.config.bootDelayMs = undefined;
      context.config.runReturnDelayMs = undefined;
      context.writeConfig();
    }
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
      secrets: { get: async () => null, set: async () => undefined, deleteFamily: async () => undefined },
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

test("a base left half-installed by a crash is deleted at the next launch, and Settings says Set up was interrupted", async () => {
  await withHost(async (context) => {
    // An earlier launch quit while Lume was creating the Linux base.
    mkdirSync(path.join(context.root, "vms", BOT_COMPUTER_BASE_VM), { recursive: true });
    writeFileSync(
      path.join(context.root, "vms", ".fake-state.json"),
      JSON.stringify({ vms: { [BOT_COMPUTER_BASE_VM]: { os: "linux", status: "stopped", ip: "192.168.64.10", mac: "a6:4f:2c:9e:13:10" } } }),
    );
    context.config.stale = BOT_COMPUTER_BASE_VM;
    context.writeConfig();
    await context.host.reconcile();
    assert.deepEqual(context.vmNames(), []);
    assert.deepEqual((await context.host.status()).setup, {
      kind: "failed",
      message: "Set up was interrupted. Choose Set up to try again.",
      resumable: true,
    });
    context.config.stale = undefined;
    context.writeConfig();
    await setUp(context);
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
      (error: unknown) => error instanceof BotComputerError && error.code === "vm_limit" && /available slot/u.test(error.message),
    );
    assert.equal((await context.host.computer("ben"))?.state, "stopped");
  });
});

test("Lume's low-disk refusal during start or base create becomes a clear message and releases the slot", async () => {
  await withHost(async (context) => {
    // Base create refused by Lume for insufficient host free space.
    context.config.lowDisk = BOT_COMPUTER_BASE_VM;
    context.writeConfig();
    await assert.rejects(
      context.host.setUp(),
      (error: unknown) => error instanceof BotComputerError && error.code === "low_disk" && /free disk space/u.test(error.message),
    );
    assert.equal((await context.host.status()).setup.kind, "failed");

    // Once space is free, Set up succeeds; then Lume refuses a Bot start for low disk.
    context.config.lowDisk = undefined;
    context.writeConfig();
    await setUp(context);
    const { vmName } = await context.host.give("ada");
    context.config.lowDisk = vmName;
    context.writeConfig();
    const from = context.calls().length;
    await assert.rejects(
      context.host.ensureRunning("ada", { reason: "tool" }),
      (error: unknown) => error instanceof BotComputerError && error.code === "low_disk" && /Ada's computer.*free disk space/u.test(error.message),
    );
    assert.equal((await context.host.computer("ada"))?.state, "stopped");
    const stops = context.calls().slice(from).filter((call) => call.op === "stop").length;
    assert.equal(stops, 1, "a low-disk refusal in Lume's log stops watching at once");
  });
});

test("a start Lume refused, or whose launch Lume's log says failed, is turned off once without waiting for a VM that can't come up", async () => {
  await withHost(async (context) => {
    await setUp(context);
    const { vmName } = await context.host.give("ada");
    const stopsSince = (from: number) => context.calls().slice(from).filter((call) => call.op === "stop").length;

    // Lume refuses to run a computer it says is still being made, so it launched nothing.
    context.config.stale = vmName;
    context.writeConfig();
    let from = context.calls().length;
    await assert.rejects(context.host.ensureRunning("ada", { reason: "tool" }), failsWith("stale"));
    assert.equal(stopsSince(from), 1, "one forced stop, in case anything was left on, and no watching");
    assert.equal((await context.host.computer("ada"))?.state, "stopped");
    context.config.stale = undefined;

    // Another app holds the second place, so Lume's background launch fails and its log says so
    // while `run` is still returning. The start's only caller has cancelled by then, and Pause follows.
    await context.host.give("ben");
    await context.host.ensureRunning("ben", { reason: "tool" });
    context.config.limit = 1;
    context.config.runReturnDelayMs = 500;
    context.writeConfig();
    from = context.calls().length;
    const caller = new AbortController();
    const cancelled = context.host.ensureRunning("ada", { reason: "tool", signal: caller.signal });
    await waitFor(() => context.calls().slice(from).some((call) => call.op === "run"), "Lume's run");
    caller.abort();
    await assert.rejects(cancelled, failsWith("cancelled"));
    await context.host.stop("ada", { reason: "pause" });
    assert.equal(stopsSince(from), 1, "the log's error ends the watch at once");
    assert.equal((await context.host.computer("ada"))?.state, "stopped");
    assert.equal((await context.host.computer("ben"))?.state, "running");
  });
});

const newerImage = Buffer.from("a newer fake macOS restore image for host tests\n".repeat(80));

/** The pin a later Aiden release ships, served by the harness's fetch. */
function newerPin(context: Harness) {
  const pin = {
    version: "26.7",
    build: "25H5",
    url: "https://updates.cdn-apple.com/test/UniversalMac_26.7_25H5_Restore.ipsw",
    bytes: newerImage.length,
    sha256: createHash("sha256").update(newerImage).digest("hex"),
  };
  context.serve(pin.url, newerImage);
  return pin;
}

test("Update base builds the newer pinned base beside the old one; Bot computers keep theirs until Reset", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.give("ada");
    await context.host.shutdown(5_000);

    // The next Aiden release pins a newer macOS.
    const pin = newerPin(context);
    const host = context.relaunch({ image: pin });
    assert.deepEqual((await host.status()).setup, { kind: "ready", baseVersion: "26.6.2", baseBuild: "25G83", updateAvailable: true });
    assert.equal((await host.computer("ada"))?.outdated, false);

    await host.updateBase();
    assert.deepEqual((await host.status()).setup, { kind: "ready", baseVersion: "26.7", baseBuild: "25H5", updateAvailable: false });
    assert.equal(last(context.fetches)?.url, pin.url);
    const installs = context.calls().filter((call) => call.op === "create");
    assert.equal(installs.length, 2);
    assert.equal(installs[1]?.args?.[1], BOT_COMPUTER_STAGING_BASE_VM, "the new base is built under the staging name");
    assert.deepEqual(context.vmNames(), [BOT_COMPUTER_BASE_VM, botComputerVmName("ada")].sort(), "the new base is swapped in, nothing left beside it");
    assert.equal(existsSync(path.join(context.root, "restore-images", "debian-25H5.raw")), false);
    assert.equal(context.events.ready, 2);

    const ada = await host.computer("ada");
    assert.equal(ada?.outdated, true);
    assert.equal(ada?.baseBuild, "25G83");
    // Ada's computer still starts on its old base; Reset moves it to the new one.
    await host.ensureRunning("ada", { reason: "tool" });
    const reset = await host.reset("ada");
    assert.equal(reset.outdated, false);
    assert.equal(reset.baseBuild, "25H5");

    const fetched = context.fetches.length;
    await host.updateBase();
    assert.equal(context.fetches.length, fetched, "an up-to-date base downloads nothing");
  });
});

test("building a base needs a running place: an idle computer gives up its own, a busy Mac is refused, and Try again keeps the working base", async () => {
  await withHost(async (context) => {
    await setUp(context);
    for (const botId of ["ada", "ben", "cyd"]) await context.host.give(botId);
    await context.host.shutdown(5_000);
    const host = context.relaunch({ image: newerPin(context) });
    // macOS runs at most two macOS VMs; the fake refuses a third start or unattended install.
    context.config.limit = 2;
    context.writeConfig();
    await host.ensureRunning("ada", { reason: "tool" });
    context.advance(10_000);
    await host.ensureRunning("ben", { reason: "tool" });

    // Both were used within the last minute, so neither gives up its place.
    await assert.rejects(
      host.updateBase(),
      (error: unknown) => error instanceof BotComputerError && error.code === "busy" && /Stop a Bot's computer/u.test(error.message),
    );
    assert.equal((await host.status()).setup.kind, "failed");
    assert.equal(await host.baseReady(), true, "a failed update leaves the working base usable");
    assert.equal(context.vmRunning(botComputerVmName("ada")), true);
    assert.equal(context.vmRunning(botComputerVmName("ben")), true);
    assert.equal(context.calls().filter((call) => call.op === "create").length, 1, "no install is tried past the limit");

    // Another app holds the second macOS place, so the install itself fails.
    await host.stop("ben", { reason: "person" });
    context.config.limit = 1;
    context.writeConfig();
    // "Try again" in Settings is Set up. With a working base it retries the update;
    // it never rebuilds, in place, the base the Bots' computers came from.
    await assert.rejects(
      host.setUp(),
      (error: unknown) => error instanceof BotComputerError && error.code === "vm_limit" && /available slot/u.test(error.message),
    );
    assert.deepEqual(
      context.vmNames().filter((name) => name.startsWith("aiden-base")),
      [BOT_COMPUTER_BASE_VM],
      "the working base is kept and the half-made one removed",
    );
    assert.equal((await host.give("dot")).baseBuild, "25G83", "Bots can still get a computer from the working base");

    // Once the computers have sat idle, the one used longest ago stops for the base.
    context.config.limit = 2;
    context.writeConfig();
    context.advance(20_000);
    await host.ensureRunning("ben", { reason: "tool" });
    context.advance(2 * 60_000);
    await host.updateBase();
    assert.equal((await host.status()).setup.kind, "ready");
    assert.equal((await host.computer("ada"))?.state, "stopped", "Ada's was used longest ago");
    assert.equal((await host.computer("ben"))?.state, "running");
  });
});

test("a VNC endpoint off loopback, or one reachable from the network, is refused and the VM stopped", async () => {
  await withHost(
    async (context) => {
      await setUp(context);
      await context.host.give("ada");
      await assert.rejects(
        context.host.ensureRunning("ada", { reason: "tool" }),
        (error: unknown) => error instanceof BotComputerError && error.code === "vnc_not_loopback",
      );
      assert.equal(context.vmRunning(botComputerVmName("ada")), false);
      assert.equal((await context.host.computer("ada"))?.state, "stopped");
    },
    {
      openVncTunnel: async () => ({
        host: "192.168.1.20" as "127.0.0.1",
        port: 5901,
        close: async () => undefined,
      }),
    },
  );
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
    assert.equal(await context.host.baseReady(), false);
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
      assert.equal(await context.host.baseReady(), false);
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

const NEWER_HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherInstallMakesItsOwnHostKeyForAidenTests987654";

test("Update base keeps reaching the Bots' older computers and keeps their password, even when the update fails", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.give("ada");
    const password = context.secrets.get(BOT_COMPUTER_GUEST_PASSWORD_SECRET);
    assert.match(password ?? "", /^[A-Za-z0-9]{32}$/u);
    await context.host.shutdown(5_000);

    // A newer pinned image; a fresh macOS install makes its own SSH host key.
    context.config.hostKey = NEWER_HOST_KEY;
    context.writeConfig();
    const host = context.relaunch({ image: newerPin(context) });
    const guestCommand = { timeoutMs: 5_000, maxOutputBytes: 4_096 };

    // The update fails after it pinned the new base's host key and changed its password.
    context.ssh.fails = (args) => args.some((arg) => arg.includes("sshd -T"));
    await assert.rejects(host.updateBase());
    context.ssh.fails = undefined;
    assert.equal(context.secrets.get(BOT_COMPUTER_GUEST_PASSWORD_SECRET), password, "Ada's computer's password is still known");
    assert.equal((await host.runGuestCommand("ada", "true", guestCommand)).exitCode, 0, "Ada's computer still accepts Aiden's ssh");
    await host.stop("ada", { reason: "person" });

    await host.updateBase();
    assert.equal((await host.status()).setup.kind, "ready");
    assert.equal(context.secrets.get(BOT_COMPUTER_GUEST_PASSWORD_SECRET), password, "one password opens every Bot computer");
    const ada = await host.computer("ada");
    assert.equal(ada?.outdated, true);
    assert.equal((await host.runGuestCommand("ada", "true", guestCommand)).exitCode, 0, "the outdated computer is still reachable");
    await host.stop("ada", { reason: "person" });
    // Reset moves Ada to the new base, which is reachable too.
    await host.reset("ada");
    assert.equal((await host.runGuestCommand("ada", "true", guestCommand)).exitCode, 0);
  });
});

const NOT_VENDORED = "The pinned Lume helper has not been vendored. Run npm run bot-computers:vendor.";

test("Set up checks the bundled Lume before it downloads anything", async () => {
  await withHost(
    async (context) => {
      await assert.rejects(context.host.setUp(), (error: unknown) => error instanceof Error && error.message === NOT_VENDORED);
      assert.deepEqual(context.fetches, [], "nothing of the 20 GB download is fetched for a Mac that can't build a base");
      assert.deepEqual((await context.host.status()).setup, { kind: "failed", message: NOT_VENDORED, resumable: false });
      // Nothing that would make later Bot deletes or startups run Lume is left behind.
      assert.equal(existsSync(path.join(context.root, "vms")), false);
    },
    {
      lume: async () => {
        throw new BotComputerError("lume_failed", NOT_VENDORED);
      },
    },
  );
});

test("deleting a Bot that never had a computer finishes even when Lume can't run; one with a computer keeps it to retry", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.give("ada");
    await context.host.shutdown(5_000);
    // A later launch where the bundled Lume fails its checks.
    const broken = context.relaunch({
      lume: async () => {
        throw new BotComputerError("lume_failed", "The packaged computer helper is missing or invalid.");
      },
    });
    await broken.deleteForBot("ben");
    await assert.rejects(broken.deleteForBot("ada"));
    assert.equal((await broken.computer("ada"))?.vmName, botComputerVmName("ada"), "Ada's record stays, so Delete Bot retries");

    // Once Lume works again, the retry finishes.
    const fixed = context.relaunch({});
    await fixed.deleteForBot("ada");
    assert.equal(await fixed.computer("ada"), undefined);
    assert.deepEqual(context.vmNames(), [BOT_COMPUTER_BASE_VM]);
  });
});

/** Hold the next start at its network-exposure check, after Lume reports the VM running. */
function startGate() {
  let hold: { reached(): void; release: Promise<void> } | undefined;
  return {
    vncExposed: async () => {
      const current = hold;
      hold = undefined;
      if (current) {
        current.reached();
        await current.release;
      }
      return false;
    },
    arm() {
      let reached!: () => void;
      let release!: () => void;
      const atGate = new Promise<void>((resolve) => (reached = resolve));
      hold = { reached, release: new Promise<void>((resolve) => (release = resolve)) };
      return { atGate, release };
    },
  };
}

test("the startup check never stops a computer that is starting, or the base being built", async () => {
  const gate = startGate();
  await withHost(
    async (context) => {
      // Reconcile runs while Set up boots and provisions the base (base runs with --vnc disabled).
      const building = gate.arm();
      context.ssh.onCall = async (args) => {
        if (args.some((arg) => arg.includes("cloud-init status --wait"))) {
          await gate.vncExposed();
        }
      };
      const setup = context.host.setUp();
      await building.atGate;
      await context.host.reconcile();
      building.release();
      await setup;
      context.ssh.onCall = undefined;
      assert.equal((await context.host.status()).setup.kind, "ready");

      // And while a Bot's computer is starting, for example one a routine needs at launch.
      const given = await context.host.give("ada");
      const starting = gate.arm();
      const start = context.host.ensureRunning("ada", { reason: "routine" });
      await starting.atGate;
      await context.host.reconcile();
      starting.release();
      await start;
      assert.equal(context.vmRunning(given.vmName), true, "the computer the Bot was given is the one running");
      assert.equal((await context.host.computer("ada"))?.state, "running");
    },
    { vncExposed: gate.vncExposed },
  );
});

test("a start two callers share keeps going while either still wants it", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.updateSettings({ maxRunning: 1 });
    for (const botId of ["ada", "ben"]) await context.host.give(botId);
    await context.host.ensureRunning("ada", { reason: "tool" });

    // The person opens Ben's Computer tab, then Ben's own tool call needs the computer too.
    const viewer = new AbortController();
    const fromViewer = context.host.ensureRunning("ben", { reason: "viewer", signal: viewer.signal }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    const progress: string[] = [];
    const fromTool = context.host.ensureRunning("ben", { reason: "tool", onProgress: (text) => progress.push(text) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Closing the tab gives up the viewer's wait, not Ben's.
    viewer.abort();
    const viewerOutcome = await fromViewer;
    assert.ok(viewerOutcome instanceof BotComputerError && viewerOutcome.code === "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await context.host.computer("ben"))?.state, "waiting_for_slot");

    await context.host.stop("ada", { reason: "person" });
    const connection = await fromTool;
    assert.equal(connection.vmName, botComputerVmName("ben"));
    assert.ok(progress.includes("Starting Ben's computer…"), "the tool call hears the start it joined");

    // When every caller gives up, so does the start.
    await context.host.stop("ben", { reason: "person" });
    await context.host.ensureRunning("ada", { reason: "tool" });
    const first = new AbortController();
    const second = new AbortController();
    const waits = [first, second].map((controller) =>
      context.host.ensureRunning("ben", { reason: "tool", signal: controller.signal }).then(
        () => undefined,
        (error: unknown) => error,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    first.abort();
    second.abort();
    for (const outcome of await Promise.all(waits)) assert.ok(outcome instanceof BotComputerError && outcome.code === "cancelled");
    assert.equal((await context.host.computer("ben"))?.state, "stopped");
    await context.host.stop("ada", { reason: "person" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(context.vmRunning(botComputerVmName("ben")), false, "nobody wanted it, so it never started");
  });
});

test("a caller that arrives while an abandoned start is still winding down gets a start of its own", async () => {
  let memoryCheck: Promise<void> | undefined;
  await withHost(
    async (context) => {
      await setUp(context);
      await context.host.give("ada");
      // The person's Computer tab starts Ada's computer; the memory check is slow.
      let releaseCheck!: () => void;
      memoryCheck = new Promise<void>((resolve) => (releaseCheck = resolve));
      const viewer = new AbortController();
      const fromViewer = context.host.ensureRunning("ada", { reason: "viewer", signal: viewer.signal }).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 60));
      // The tab closes, and Ada's tool call asks for the computer while that start is still ending.
      viewer.abort();
      const fromTool = context.host.ensureRunning("ada", { reason: "tool" });
      await new Promise((resolve) => setTimeout(resolve, 60));
      memoryCheck = undefined;
      releaseCheck();
      assert.ok((await fromViewer) instanceof BotComputerError);
      assert.equal((await fromTool).vmName, botComputerVmName("ada"));
      assert.equal(context.vmRunning(botComputerVmName("ada")), true);
    },
    {
      resources: {
        freeDiskBytes: async () => 1e13,
        availableMemoryBytes: async () => {
          await memoryCheck;
          return 64 * 1024 ** 3;
        },
      },
    },
  );
});

test("Remove everything turns off a computer an earlier launch left running before it deletes its files", async () => {
  await withHost(async (context) => {
    await setUp(context);
    await context.host.give("ada");
    await context.host.ensureRunning("ada", { reason: "tool" });
    const pid = context.vmPid(botComputerVmName("ada"));
    assert.ok(pid);
    // A later launch removes everything before its startup check got to Ada's computer.
    await context.relaunch({}).removeEverything();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(processRunning(pid), false, "no VM keeps running unseen once Aiden's storage is gone");
  });
});

// ── The guest driver lane (P11) ─────────────────────────────────────────────

const GUEST_FIXTURE = path.resolve("main/services/bot-computers/fixtures/guest-cua-driver.mjs");

/** A host whose guest sessions run the fake Linux guest driver (no macOS permission grants). */
function guestDriverHarness(options: { executable?: () => Promise<string>; failProbe?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "p11-guest-"));
  const callLog = path.join(dir, "guest-calls.jsonl");
  const permissions = path.join(dir, "permissions.json");
  // Linux guests run with --no-permissions-gate so check_permissions reports ready unless testing probe failure.
  writeFileSync(
    permissions,
    JSON.stringify({
      accessibility: !options.failProbe,
      screen_recording: !options.failProbe,
    }),
  );
  const driverFile = path.join(dir, "cua-driver");
  writeFileSync(driverFile, "vendored linux arm64 driver bytes");
  const noticeFile = path.join(dir, "LICENSE.cua-driver.md");
  writeFileSync(noticeFile, "MIT License");
  const bridges: { command: string; args: readonly string[] }[] = [];
  const overrides: Partial<BotComputerHostDependencies> = {
    guestDriverExecutable: options.executable ?? (async () => driverFile),
    guestDriverNotice: () => noticeFile,
    guestDriverHost: (bridge) =>
      createGuestCuaDriverHostFactory({
        bridge: async () => {
          bridges.push(await bridge());
          return {
            command: process.execPath,
            args: [GUEST_FIXTURE, "--permissions-file", permissions, "--log", callLog],
            env: { PATH: "/usr/bin:/bin" },
          };
        },
      }),
  };
  return {
    overrides,
    driverFile,
    noticeFile,
    bridges,
    toolCalls: (): string[] =>
      existsSync(callLog)
        ? readFileSync(callLog, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as { name: string }).name)
        : [],
  };
}

/** The guest answers the install's location step as a Linux guest would. */
function answerLinuxGuest(context: Harness): void {
  context.ssh.stdout = (args) => (last(args)?.includes("aiden-guest-driver") ? "aiden-guest-driver 1000 /home/lume\n" : undefined);
}

test("Set up installs the Linux guest driver automatically, probes it with no permission prompts, and clones inherit it", async (t) => {
  const sent = captureAnalyticsEvents(t);
  const guest = guestDriverHarness();
  await withHost(async (context) => {
    answerLinuxGuest(context);
    await setUp(context);
    const status = await context.host.status();
    assert.equal(status.setup.kind, "ready");

    // The vendored Linux binary and its licence notice went over stdin; no password ever in argv.
    const password = context.secrets.get(BOT_COMPUTER_GUEST_PASSWORD_SECRET) ?? "";
    assert.ok(context.sshCalls.some((call) => call.stdinFile === guest.driverFile));
    assert.ok(context.sshCalls.some((call) => call.stdinFile === guest.noticeFile && /LICENSE\.cua-driver\.md/u.test(last(call.args) ?? "")));
    for (const call of context.sshCalls) assert.equal(call.args.join(" ").includes(password), false);
    assert.ok(guest.bridges.length >= 1, "probed the installed driver over ssh");
    for (const bridge of guest.bridges) {
      assert.equal(bridge.command, "/usr/bin/ssh");
      assert.match(last(bridge.args) ?? "", /systemctl --user start cua-driver\.service/u);
      assert.match(last(bridge.args) ?? "", /mcp --embedded --socket/u);
    }

    // Clones inherit the base's disk and guest driver record; the Bot's computer offers the driver lane.
    await context.host.give("ada");
    assert.ok(await context.host.guestDriver("ada"));
    await analyticsSettled();
    assert.deepEqual(sent, [{ event: "bot_computer_set_up", props: { element_control: true } }]);
  }, guest.overrides);
});

test("a Linux guest driver that can't be installed or fails its probe leaves a working base on the VNC lane", async () => {
  const missing = guestDriverHarness({
    executable: async () => {
      throw new Error("The pinned Linux arm64 cua-driver has not been vendored.");
    },
  });
  await withHost(async (context) => {
    answerLinuxGuest(context);
    await setUp(context);
    assert.equal((await context.host.status()).setup.kind, "ready");
    await context.host.give("ada");
    assert.equal(await context.host.guestDriver("ada"), undefined);
    assert.equal(missing.bridges.length, 0);
  }, missing.overrides);

  const probeFailed = guestDriverHarness({ failProbe: true });
  await withHost(async (context) => {
    answerLinuxGuest(context);
    await setUp(context);
    assert.equal((await context.host.status()).setup.kind, "ready");
    await context.host.give("ada");
    assert.equal(await context.host.guestDriver("ada"), undefined);
  }, probeFailed.overrides);
});

test("a finished Set up counts once, and one that failed counts nothing", async (t) => {
  const sent = captureAnalyticsEvents(t);
  await withHost(
    async (context) => {
      await assert.rejects(context.host.setUp());
      await analyticsSettled();
    },
    { resources: { freeDiskBytes: async () => 1_000, availableMemoryBytes: async () => 64 * 1024 ** 3 } },
  );
  assert.deepEqual(sent, []);

  await withHost(async (context) => {
    await setUp(context);
    await analyticsSettled();
    assert.deepEqual(sent, [{ event: "bot_computer_set_up", props: { element_control: false } }]);
  });
});

test("Linux Set up downloads via HTTPS mirror redirect, creates and provisions a Linux base with no permissions step, and cleans up", async () => {
  const linuxRaw = Buffer.from("fake Debian 13 generic arm64 raw disk image\n".repeat(64));
  const linuxImage = {
    version: "13",
    build: "20261123-2671",
    url: "https://cloud.debian.org/images/cloud/trixie/20261123-2671/debian-13-generic-arm64-20261123-2671.raw",
    bytes: linuxRaw.length,
    sha256: createHash("sha256").update(linuxRaw).digest("hex"),
  };
  const mirrorUrl = "https://mirror.debian.org/images/debian-13-generic-arm64-20261123-2671.raw";
  const observedSteps: string[] = [];
  const fetched: { url: string; redirect?: RequestRedirect }[] = [];

  await withHost(
    async (context) => {
      const before = await context.host.status();
      assert.equal(before.requirements.maxRunningLimit, 4);
      assert.equal(before.requirements.memoryPerComputerBytes, 4 * 1024 ** 3);
      assert.equal(before.requirements.baseDiskBytes, 8_000_000_000);

      context.host.onChange(() => {
        void context.host.status().then((next) => {
          if (next.setup.kind === "building_base") observedSteps.push(next.setup.step);
        });
      });

      await setUp(context);
      const status = await context.host.status();
      assert.deepEqual(status.setup, {
        kind: "ready",
        baseVersion: "13",
        baseBuild: "20261123-2671",
        updateAvailable: false,
      });
      assert.equal(observedSteps.includes("permissions"), false, "Linux setup has no macOS permissions step");
      assert.deepEqual(fetched, [
        { url: linuxImage.url, redirect: "manual" },
        { url: mirrorUrl, redirect: "manual" },
      ]);

      const cliCalls = context.calls().filter((call) => call.kind === "cli");
      const createCall = cliCalls.find((call) => call.op === "create");
      assert.equal(createCall?.args?.[createCall.args.indexOf("--os") + 1], "linux");
      assert.equal(createCall?.args?.[createCall.args.indexOf("--memory") + 1], "4GB");
      assert.equal(createCall?.args?.[createCall.args.indexOf("--disk-size") + 1], "24GB");
      assert.equal(createCall?.args?.[createCall.args.indexOf("--display") + 1], "1280x800");
      assert.equal(createCall?.args?.includes("--ipsw"), false);

      const runCall = cliCalls.find((call) => call.op === "run");
      assert.ok(runCall?.args?.includes("--mount"), "first Linux boot mounts the CIDATA seed ISO");
      assert.equal(runCall?.args?.[runCall.args.indexOf("--vnc") + 1], "disabled", "Linux base boot disables Lume's host VNC");
      assert.equal(runCall?.args?.includes("--vnc-password"), false);
      assert.equal(context.vncTunnels.length, 0, "base setup opens no SSH VNC tunnel");
      const mountedIso = runCall?.args?.[runCall.args.indexOf("--mount") + 1] ?? "";
      assert.equal(existsSync(mountedIso), false, "temporary CIDATA seed ISO is deleted after base build");

      assert.equal(context.calls().filter((call) => call.kind === "ssh").length, 0, "Linux provisioning never uses password lume ssh");
      assert.ok(context.sshCalls.length >= 6, "provisioning runs over key-based system ssh");
      const stored = context.secrets.get(BOT_COMPUTER_GUEST_PASSWORD_SECRET);
      assert.match(stored ?? "", /^[A-Za-z0-9]{32}$/u);
      assert.ok(context.sshCalls.every((call) => !call.args.some((arg) => arg.includes(stored ?? "<none>"))));
      assert.equal(readFileSync(path.join(context.root, "known_hosts"), "utf8"), `aiden-bot-computer ${HOST_KEY}\n`);
      assert.equal(existsSync(path.join(context.root, "restore-images", "debian-20261123-2671.raw")), false);
      assert.equal(context.vmRunning(BOT_COMPUTER_BASE_VM), false);
    },
    {
      env: { LANG: "en_US.UTF-8" },
      image: linuxImage,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        fetched.push({ url: href, redirect: init?.redirect });
        if (href === linuxImage.url) {
          return new Response(null, { status: 302, headers: { location: mirrorUrl } });
        }
        return new Response(new Uint8Array(linuxRaw));
      }) as typeof fetch,
    },
  );
});

test("Linux Update base builds aiden-base-next, swaps cleanly, and marks existing Bot computers outdated until Reset", async () => {
  const firstRaw = Buffer.from("debian build 1\n".repeat(64));
  const secondRaw = Buffer.from("debian build 2\n".repeat(64));
  const firstImage = {
    version: "13",
    build: "20261101-1001",
    url: "https://cloud.debian.org/images/debian-1.raw",
    bytes: firstRaw.length,
    sha256: createHash("sha256").update(firstRaw).digest("hex"),
  };
  const secondImage = {
    version: "13",
    build: "20261123-2671",
    url: "https://cloud.debian.org/images/debian-2.raw",
    bytes: secondRaw.length,
    sha256: createHash("sha256").update(secondRaw).digest("hex"),
  };

  await withHost(
    async (context) => {
      context.serve(firstImage.url, firstRaw);
      context.serve(secondImage.url, secondRaw);
      await setUp(context);
      await context.host.give("ada");

      const updatedHost = context.relaunch({ image: secondImage });
      const before = await updatedHost.status();
      assert.equal(before.setup.kind === "ready" && before.setup.updateAvailable, true);

      await updatedHost.updateBase();
      const after = await updatedHost.status();
      assert.deepEqual(after.setup, {
        kind: "ready",
        baseVersion: "13",
        baseBuild: "20261123-2671",
        updateAvailable: false,
      });
      assert.equal((await updatedHost.computer("ada"))?.outdated, true);
      assert.equal(context.vmNames().includes("aiden-base-next"), false, "staging base removed after swap");
      assert.equal(context.vmNames().includes(BOT_COMPUTER_BASE_VM), true);

      const reset = await updatedHost.reset("ada");
      assert.equal(reset.outdated, false);
      assert.equal(reset.baseBuild, "20261123-2671");
    },
    { image: firstImage },
  );
});

test("Linux mode scales maxRunning up to 4 with host free memory and enforces the 2 GB minimum floor", async () => {
  const linuxRaw = Buffer.from("debian concurrency image\n".repeat(64));
  const linuxImage = {
    version: "13",
    build: "20261123-2671",
    url: "https://cloud.debian.org/images/debian.raw",
    bytes: linuxRaw.length,
    sha256: createHash("sha256").update(linuxRaw).digest("hex"),
  };
  let freeMem = 64 * 1024 ** 3;

  await withHost(
    async (context) => {
      context.serve(linuxImage.url, linuxRaw);
      await setUp(context);

      // 64 GiB available → limit is 4; all four Bots can run at once.
      assert.equal((await context.host.status()).requirements.maxRunningLimit, 4);
      const updated = await context.host.updateSettings({ maxRunning: 4 });
      assert.equal(updated.maxRunning, 4);
      await assert.rejects(context.host.updateSettings({ maxRunning: 5 as 4 }), /At most 4/u);

      for (const botId of ["ada", "ben", "cyd", "dan"]) {
        await context.host.give(botId);
        await context.host.ensureRunning(botId, { reason: "tool" });
      }
      for (const botId of ["ada", "ben", "cyd", "dan"]) {
        assert.equal((await context.host.computer(botId))?.state, "running", `${botId} runs concurrently`);
        await context.host.stop(botId, { reason: "person" });
      }

      // 10 GiB available → limit drops to 2; setting maxRunning to 3 is refused.
      freeMem = 10 * 1024 ** 3;
      assert.equal((await context.host.status()).requirements.maxRunningLimit, 2);
      await assert.rejects(context.host.updateSettings({ maxRunning: 3 }), /At most 2/u);

      // 3 GiB available (above 2 GiB minimum, below 4 GiB) → limit is 1 and the first Linux VM still starts.
      freeMem = 3 * 1024 ** 3;
      assert.equal((await context.host.status()).requirements.maxRunningLimit, 1);
      await context.host.ensureRunning("ada", { reason: "tool" });
      assert.equal((await context.host.computer("ada"))?.state, "running");
      await context.host.stop("ada", { reason: "person" });

      // 1 GiB available (below 2 GiB minimum) → starting even one Linux VM is refused with low_memory.
      freeMem = 1 * 1024 ** 3;
      await assert.rejects(
        context.host.ensureRunning("ada", { reason: "tool" }),
        (error: unknown) => error instanceof BotComputerError && error.code === "low_memory",
      );
    },
    {
      image: linuxImage,
      resources: { freeDiskBytes: async () => 1e13, availableMemoryBytes: async () => freeMem },
    },
  );
});

test("first-launch macOS cleanup stops and deletes only Aiden's macOS VMs and IPSWs, notifies each Bot once, keeps settings, and auto-clones after Linux setup", async () => {
  const migratedNotes: Array<{ botId: string; note: string }> = [];
  await withHost(
    async (context) => {
      const vmsDir = path.join(context.root, "vms");
      const imagesDir = path.join(context.root, "restore-images");
      mkdirSync(vmsDir, { recursive: true });
      mkdirSync(imagesDir, { recursive: true });

      const adaVm = botComputerVmName("ada");
      const beaVm = botComputerVmName("bea");
      // Spawn a harmless dummy process to play a running macOS VM left over from before the upgrade.
      const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
      assert.ok(sleeper.pid);

      // Seed dummy disk files so freedBytes is measured cleanly.
      for (const name of [BOT_COMPUTER_BASE_VM, BOT_COMPUTER_STAGING_BASE_VM, adaVm, beaVm, "user-other-macos"]) {
        mkdirSync(path.join(vmsDir, name), { recursive: true });
        writeFileSync(path.join(vmsDir, name, "disk.img"), Buffer.alloc(64 * 1024, 1));
      }
      const ipswPart = path.join(imagesDir, "UniversalMac_25G83_Restore.ipsw.part");
      writeFileSync(ipswPart, Buffer.alloc(128 * 1024, 2));

      writeFileSync(
        path.join(vmsDir, ".fake-state.json"),
        JSON.stringify({
          vms: {
            [BOT_COMPUTER_BASE_VM]: { os: "macOS", status: "stopped", mac: "02:00:00:00:00:01" },
            [BOT_COMPUTER_STAGING_BASE_VM]: { os: "macOS", status: "stopped", mac: "02:00:00:00:00:02" },
            [adaVm]: { os: "macOS", status: "running", pid: sleeper.pid, ip: "192.168.64.2", port: 5901, mac: "02:00:00:00:00:03" },
            [beaVm]: { os: "macOS", status: "stopped", mac: "02:00:00:00:00:04" },
            "user-other-macos": { os: "macOS", status: "stopped", mac: "02:00:00:00:00:05" },
          },
        }),
      );
      writeFileSync(
        path.join(context.root, "state.json"),
        JSON.stringify({
          version: 1,
          settings: { maxRunning: 2, idleStopMinutes: 10 },
          setup: { baseBuild: "25G83", baseVersion: "26.6.2", ipswPath: ipswPart },
          computers: {
            ada: { vmName: adaVm, baseBuild: "25G83", createdAt: 100 },
            bea: { vmName: beaVm, baseBuild: "25G83", createdAt: 200 },
          },
        }),
      );
      context.secrets.set(BOT_COMPUTER_GUEST_PASSWORD_SECRET, "OldMacosPassword0123456789abcdef");

      await context.host.reconcile();

      // Running macOS VM stopped; all Aiden macOS VMs + IPSW removed; non-Aiden VM untouched!
      assert.equal(processRunning(sleeper.pid), false, "running legacy macOS VM was force-stopped");
      assert.deepEqual(context.vmNames(), ["user-other-macos"], "only non-Aiden VM remains in storage");
      assert.equal(existsSync(ipswPart), false, "partial Apple IPSW was removed");
      assert.equal(context.secrets.get(BOT_COMPUTER_GUEST_PASSWORD_SECRET), undefined, "old guest password removed");

      // Setup reset to not_set_up; Settings notice persisted with freed bytes; Bots kept their computer setting.
      const after = await context.host.status();
      assert.deepEqual(after.setup, { kind: "not_set_up" });
      assert.ok((after.migrationNotice?.freedBytes ?? 0) > 0, "migration notice reports freed bytes");
      assert.deepEqual(after.computers.map((entry) => entry.botId).sort(), ["ada", "bea"]);
      assert.ok(after.computers.every((entry) => entry.state === "stopped"), "migrated Bots are not marked stale");

      // Each Bot got its one-line Linux migration note exactly once.
      assert.deepEqual(
        migratedNotes.sort((a, b) => a.botId.localeCompare(b.botId)),
        [
          { botId: "ada", note: BOT_COMPUTER_LINUX_MIGRATION_BOT_NOTE },
          { botId: "bea", note: BOT_COMPUTER_LINUX_MIGRATION_BOT_NOTE },
        ],
      );

      // Second reconcile is idempotent: no duplicate notes, non-Aiden VM still untouched.
      await context.host.reconcile();
      assert.equal(migratedNotes.length, 2);
      assert.deepEqual(context.vmNames(), ["user-other-macos"]);

      // Before Linux Set up, a migrated Bot's computer call asks to set up Linux once for all Bots.
      await assert.rejects(
        context.host.ensureRunning("ada", { reason: "tool" }),
        (error: unknown) => error instanceof BotComputerError && error.code === "not_set_up" && /now run Linux/u.test(error.message),
      );

      // Dismissing the notice clears it persistently across relaunch.
      await context.host.dismissMigrationNotice();
      assert.equal((await context.host.status()).migrationNotice, undefined);
      const relaunched = context.relaunch({});
      assert.equal((await relaunched.status()).migrationNotice, undefined);

      // After Linux Set up finishes, the migrated Bot's next start automatically clones a fresh Linux VM and boots it.
      await setUp(context);
      const conn = await context.host.ensureRunning("ada", { reason: "tool" });
      assert.equal(conn.vmName, adaVm);
      assert.equal((await context.host.computer("ada"))?.state, "running");
      assert.equal((await context.host.computer("ada"))?.baseBuild, "20261123-2671");
    },
    {
      image: {
        version: "13",
        build: "20261123-2671",
        url: "https://cloud.debian.org/images/debian.raw",
        bytes: restoreImage.length,
        sha256: createHash("sha256").update(restoreImage).digest("hex"),
      },
      onMacosComputerMigrated: (botId, note) => {
        migratedNotes.push({ botId, note });
      },
    },
  );
});

test("reconcile does not migrate or show a notice on a fresh install or an existing Linux base", async () => {
  // Fresh install (root doesn't exist): runs zero Lume calls and sets no notice.
  await withHost(async (context) => {
    await context.host.reconcile();
    assert.equal(context.calls().length, 0);
    assert.equal((await context.host.status()).migrationNotice, undefined);
  });

  // Existing Linux install: reconcile preserves aiden-base and sets no notice.
  await withHost(async (context) => {
    await setUp(context);
    await context.host.give("ada");
    const relaunched = context.relaunch({});
    await relaunched.reconcile();
    const status = await relaunched.status();
    assert.equal(status.setup.kind, "ready");
    assert.equal(status.migrationNotice, undefined);
    assert.ok(context.vmNames().includes(BOT_COMPUTER_BASE_VM));
    assert.ok(context.vmNames().includes(botComputerVmName("ada")));
  });
});

test("first-launch macOS cleanup retries cleanly after lume ls or delete failure without duplicating Bot notes or miscounting freedBytes", async () => {
  const migratedNotes: Array<{ botId: string; note: string }> = [];
  const controlDir = mkdtempSync(path.join(tmpdir(), "aiden-bc-migration-retry-"));
  const controlFile = path.join(controlDir, "control.json");
  const wrapper = path.join(controlDir, "lume-wrapper.mjs");
  writeFileSync(
    wrapper,
    [
      'import { spawnSync } from "node:child_process";',
      'import { readFileSync } from "node:fs";',
      'const [controlPath, realFake, ...rest] = process.argv.slice(2);',
      'const control = JSON.parse(readFileSync(controlPath, "utf8"));',
      'if (control.failLs && rest.includes("ls")) { process.stderr.write("lume ls transient failure\\n"); process.exit(1); }',
      'if (control.failDelete && rest.includes("delete") && rest.includes(control.failDelete)) { process.stderr.write("lume delete transient failure\\n"); process.exit(1); }',
      'const result = spawnSync(process.execPath, [realFake, ...rest], { stdio: "inherit" });',
      'process.exit(result.status ?? 1);',
    ].join("\n"),
  );
  const setControl = (value: { failLs?: boolean; failDelete?: string }) => writeFileSync(controlFile, JSON.stringify(value));
  setControl({ failLs: true });

  try {
    await withHost(
    async (context) => {
      const vmsDir = path.join(context.root, "vms");
      mkdirSync(vmsDir, { recursive: true });
      const adaVm = botComputerVmName("ada");
      for (const name of [BOT_COMPUTER_BASE_VM, adaVm]) {
        mkdirSync(path.join(vmsDir, name), { recursive: true });
        writeFileSync(path.join(vmsDir, name, "disk.img"), Buffer.alloc(64 * 1024, 3));
      }
      writeFileSync(
        path.join(vmsDir, ".fake-state.json"),
        JSON.stringify({
          vms: {
            [BOT_COMPUTER_BASE_VM]: { os: "macOS", status: "stopped", mac: "02:00:00:00:00:01" },
            [adaVm]: { os: "macOS", status: "stopped", mac: "02:00:00:00:00:02" },
          },
        }),
      );
      writeFileSync(
        path.join(context.root, "state.json"),
        JSON.stringify({
          version: 1,
          settings: { maxRunning: 2, idleStopMinutes: 10 },
          setup: { baseBuild: "25G83", baseVersion: "26.6.2" },
          computers: { ada: { vmName: adaVm, baseBuild: "25G83", createdAt: 100 } },
        }),
      );

      // Launch 1: lume ls fails — migration must NOT mark itself complete or touch state.
      await context.host.reconcile();
      assert.equal((await context.host.status()).migrationNotice, undefined);
      assert.equal(migratedNotes.length, 0);
      assert.deepEqual(context.vmNames().sort(), [BOT_COMPUTER_BASE_VM, adaVm].sort());

      // Launch 2: lume ls works, but deleting ada's VM fails — base is removed, ada's VM remains,
      // migration stays incomplete (no notice yet), and Ada gets its memory note once.
      setControl({ failDelete: adaVm });
      await context.host.reconcile();
      assert.deepEqual(context.vmNames(), [adaVm], "failed delete kept adaVm in storage");
      assert.equal((await context.host.status()).migrationNotice, undefined, "notice waits until all VMs are removed");
      assert.equal(migratedNotes.length, 1);

      // Launch 3: delete succeeds — adaVm is removed, freedBytes includes both VMs, notice appears,
      // and Ada's memory note is NOT duplicated.
      setControl({});
      await context.host.reconcile();
      assert.deepEqual(context.vmNames(), []);
      const after = await context.host.status();
      assert.ok((after.migrationNotice?.freedBytes ?? 0) >= 128 * 1024, "freedBytes totals both removed VMs");
      assert.equal(migratedNotes.length, 1, "Bot memory note is never duplicated on retry");
    },
    {
      onMacosComputerMigrated: (botId, note) => {
        migratedNotes.push({ botId, note });
      },
      lume: async () => ({ command: process.execPath, prefixArgs: [wrapper, controlFile, fake] }),
    },
  );
  } finally {
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test("host.guestDriver resolves the ready Linux base guest driver for a migrated Bot on its first turn", async () => {
  const guest = guestDriverHarness();
  await withHost(
    async (context) => {
      answerLinuxGuest(context);
      const vmsDir = path.join(context.root, "vms");
      mkdirSync(vmsDir, { recursive: true });
      const adaVm = botComputerVmName("ada");
      writeFileSync(
        path.join(vmsDir, ".fake-state.json"),
        JSON.stringify({ vms: { [adaVm]: { os: "macOS", status: "stopped", mac: "02:00:00:00:00:01" } } }),
      );
      writeFileSync(
        path.join(context.root, "state.json"),
        JSON.stringify({
          version: 1,
          settings: { maxRunning: 2, idleStopMinutes: 10 },
          setup: { baseBuild: "25G83", baseVersion: "26.6.2" },
          computers: { ada: { vmName: adaVm, baseBuild: "25G83", createdAt: 100 } },
        }),
      );

      await context.host.reconcile();
      assert.equal(await context.host.guestDriver("ada"), undefined, "no guest driver before Linux setup");

      // Set up Linux with a ready guest driver; before Ada's VM is even cloned, guestDriver("ada") is available.
      await setUp(context);
      const guestHost = await context.host.guestDriver("ada");
      assert.ok(guestHost, "migrated Bot resolves guest driver immediately after Linux setup");
    },
    {
      ...guest.overrides,
      image: {
        version: "13",
        build: "20261123-2671",
        url: "https://cloud.debian.org/images/debian.raw",
        bytes: restoreImage.length,
        sha256: createHash("sha256").update(restoreImage).digest("hex"),
      },
    },
  );
});

test("Linux Bot computers disable Lume VNC, tunnel guest X0tigervnc on 127.0.0.1 passing real vncReachableBeyondLoopback, and tear down tunnels on stop or failure", async () => {
  const linuxRaw = Buffer.from("debian vnc tunnel image\n".repeat(64));
  const linuxImage = {
    version: "13",
    build: "20261123-2671",
    url: "https://cloud.debian.org/images/debian-vnc.raw",
    bytes: linuxRaw.length,
    sha256: createHash("sha256").update(linuxRaw).digest("hex"),
  };

  await withHost(
    async (context) => {
      context.serve(linuxImage.url, linuxRaw);
      await setUp(context);
      await context.host.give("ada");

      const beforeSsh = context.sshCalls.length;
      const conn = await context.host.ensureRunning("ada", { reason: "tool" });
      const runCall = last(context.calls().filter((c) => c.kind === "cli" && c.op === "run"));
      assert.equal(runCall?.args?.[runCall.args.indexOf("--vnc") + 1], "disabled", "Linux Bot VM runs with --vnc disabled");
      assert.equal(runCall?.args?.includes("--vnc-password"), false, "no --vnc-password passed to Lume");

      const vncStartCall = context.sshCalls.slice(beforeSsh).find((c) => c.args.some((a) => a.includes("tigervncpasswd")));
      assert.ok(vncStartCall, "guest VNC password & service started over SSH");
      assert.equal(vncStartCall?.stdin, `${conn.vnc.password}\n`, "per-run VNC password passes on stdin, not argv");
      assert.equal(vncStartCall?.args.some((a) => a.includes(conn.vnc.password)), false);

      assert.equal(context.vncTunnels.length, 1);
      assert.equal(context.vncTunnels[0]?.remoteSocket, BOT_COMPUTER_LINUX_VNC_SOCKET);
      assert.equal(context.vncTunnels[0]?.closed, false);
      assert.equal(conn.vnc.host, "127.0.0.1");
      assert.equal(conn.vnc.port, context.vncTunnels[0]?.port);

      await context.host.stop("ada", { reason: "person" });
      assert.equal(context.vncTunnels[0]?.closed, true, "SSH VNC tunnel closes when Bot VM stops");

      // When the G22 check reports exposure, both tunnel and VM are torn down cleanly.
      const exposedHost = context.relaunch({ image: linuxImage, vncExposed: async () => true });
      await assert.rejects(
        exposedHost.ensureRunning("ada", { reason: "tool" }),
        (error: unknown) => error instanceof BotComputerError && error.code === "vnc_not_loopback",
      );
      assert.equal(context.vncTunnels.length, 2);
      assert.equal(context.vncTunnels[1]?.closed, true, "tunnel closes on vnc_not_loopback rejection");
      assert.equal(context.vmRunning(botComputerVmName("ada")), false, "VM stops on vnc_not_loopback rejection");
    },
    {
      image: linuxImage,
      // Explicitly undefined so the REAL unmodified vncReachableBeyondLoopback(port) runs!
      vncExposed: undefined,
    },
  );
});

test("shared computer is the default: multiple Bots share one VM, keep per-Bot folders beside Shared, and deleting one Bot keeps the shared VM", async () => {
  await withHost(async (context) => {
    await setUp(context, "shared");
    const initial = await context.host.status();
    assert.equal(initial.settings.defaultComputerMode, "shared");
    assert.deepEqual(initial.vms, []);

    // Concurrent give() calls lazily clone aiden-vm-shared exactly once.
    const [ada, ben] = await Promise.all([context.host.give("ada"), context.host.give("ben")]);
    assert.equal(ada.computerId, "shared");
    assert.equal(ben.computerId, "shared");
    assert.equal(ada.vmName, BOT_COMPUTER_SHARED_VM);
    assert.equal(ben.vmName, BOT_COMPUTER_SHARED_VM);
    assert.equal(ada.shared, true);
    assert.equal(ben.shared, true);
    const sharedClones = context.calls().filter((c) => c.op === "clone" && c.args?.includes(BOT_COMPUTER_SHARED_VM));
    assert.equal(sharedClones.length, 1, "shared VM is cloned only once");

    // Both shared folder and per-Bot workspace folders exist on host virtiofs mount.
    const sharedRoot = path.join(context.root, "computers", "shared", "Computer");
    assert.equal(existsSync(sharedRoot), true);
    assert.equal(existsSync(path.join(sharedRoot, "bots", "ada")), true);
    assert.equal(existsSync(path.join(sharedRoot, "bots", "ben")), true);

    // Both Bots use the exact same running VM connection (1 running VM).
    const connAda = await context.host.ensureRunning("ada", { reason: "tool" });
    const connBen = await context.host.ensureRunning("ben", { reason: "tool" });
    assert.equal(connAda.vmName, BOT_COMPUTER_SHARED_VM);
    assert.equal(connBen.vmName, BOT_COMPUTER_SHARED_VM);
    assert.equal(connAda.vnc.port, connBen.vnc.port);
    assert.equal(connAda.vnc.password, connBen.vnc.password);
    assert.equal(context.vmRunning(BOT_COMPUTER_SHARED_VM), true);

    const status = await context.host.status();
    assert.equal(status.vms.length, 1);
    assert.deepEqual(status.vms[0]?.assignedBotIds.slice().sort(), ["ada", "ben"]);

    // Pausing one Bot on a shared VM never stops the VM under the other Bot.
    await context.host.stop("ada", { reason: "pause" });
    assert.equal(context.vmRunning(BOT_COMPUTER_SHARED_VM), true);
    assert.equal((await context.host.computer("ben"))?.state, "running");

    // Deleting one Bot unassigns it without stopping or deleting the shared VM.
    await context.host.deleteForBot("ada");
    assert.equal(await context.host.computer("ada"), undefined);
    assert.equal(context.vmRunning(BOT_COMPUTER_SHARED_VM), true);
    assert.equal((await context.host.computer("ben"))?.state, "running");
    assert.deepEqual((await context.host.status()).vms[0]?.assignedBotIds, ["ben"]);
  });
});

test("shared VM FIFO queue serializes Bots in order, exposes live queue status, and dequeues cleanly on AbortSignal", async () => {
  await withHost(async (context) => {
    await setUp(context, "shared");
    for (const botId of ["ada", "ben", "cyd", "dan"]) await context.host.give(botId);

    const releaseAda = await context.host.acquireLease("ada");
    assert.equal((await context.host.computer("ada"))?.activeBotId, "ada");
    assert.equal((await context.host.computer("ada"))?.queuePosition, undefined);

    const benProgress: string[] = [];
    const benAbort = new AbortController();
    const benWait = context.host.acquireLease("ben", {
      signal: benAbort.signal,
      onProgress: (text) => benProgress.push(text),
    });
    const cydWait = context.host.acquireLease("cyd");
    await new Promise((resolve) => setImmediate(resolve));

    // Status exposes activeBotId, queuedBotIds in FIFO order, and 1-based queuePosition.
    let status = await context.host.status();
    assert.equal(status.vms[0]?.activeBotId, "ada");
    assert.deepEqual(status.vms[0]?.queuedBotIds, ["ben", "cyd"]);
    assert.equal((await context.host.computer("ben"))?.queuePosition, 1);
    assert.equal((await context.host.computer("cyd"))?.queuePosition, 2);
    assert.ok(benProgress.some((line) => /Waiting for Ada/u.test(line)));

    // Aborting Ben's signal removes Ben from the queue and advances Cyd to #1.
    benAbort.abort();
    await assert.rejects(benWait, (error: unknown) => error instanceof BotComputerError && error.code === "cancelled");
    status = await context.host.status();
    assert.deepEqual(status.vms[0]?.queuedBotIds, ["cyd"]);
    assert.equal((await context.host.computer("cyd"))?.queuePosition, 1);

    // Enqueue Dan behind Cyd, then verify strict FIFO handoff: Ada -> Cyd -> Dan.
    const order: string[] = [];
    const danWait = context.host.acquireLease("dan");
    const cydRun = cydWait.then((release) => {
      order.push("cyd");
      return release;
    });
    const danRun = danWait.then((release) => {
      order.push("dan");
      return release;
    });

    releaseAda();
    const releaseCyd = await cydRun;
    assert.deepEqual(order, ["cyd"]);
    assert.equal((await context.host.status()).vms[0]?.activeBotId, "cyd");
    assert.deepEqual((await context.host.status()).vms[0]?.queuedBotIds, ["dan"]);

    releaseCyd();
    const releaseDan = await danRun;
    assert.deepEqual(order, ["cyd", "dan"]);
    assert.equal((await context.host.status()).vms[0]?.activeBotId, "dan");

    releaseDan();
    assert.equal((await context.host.status()).vms[0]?.activeBotId, undefined);
    assert.deepEqual((await context.host.status()).vms[0]?.queuedBotIds, []);
  });
});

test("human Take over and Give back on a shared VM block and notify every assigned Bot together", async () => {
  await withHost(async (context) => {
    await setUp(context, "shared");
    await context.host.give("ada");
    await context.host.give("ben");
    await context.host.ensureRunning("ada", { reason: "tool" });

    const notified: string[] = [];
    const unsub = context.host.control.onChange((botId) => notified.push(botId));

    let benAborted = false;
    const benAction = context.host.control.run(
      "ben",
      undefined,
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            benAborted = true;
            reject(signal.reason);
          });
        }),
    );

    // Take over through Ada blocks Ben too and notifies both.
    context.host.control.takeOver("ada", "sign_in");
    await assert.rejects(benAction, BotComputerTakenOverError);
    assert.equal(benAborted, true);
    assert.equal(context.host.control.controller("ada"), "person");
    assert.equal(context.host.control.controller("ben"), "person");
    assert.equal((await context.host.computer("ada"))?.controller, "person");
    assert.equal((await context.host.computer("ben"))?.controller, "person");
    assert.ok(notified.includes("ada") && notified.includes("ben"));

    // Give back releases both Bots together.
    context.host.control.giveBack("ada");
    assert.equal(context.host.control.controller("ada"), "bot");
    assert.equal(context.host.control.controller("ben"), "bot");
    unsub();
  });
});

test("first-class VM pool supports create, rename, assign existing/new, refuse busy delete, force delete, and resetComputer", async () => {
  await withHost(async (context) => {
    await setUp(context, "shared");
    await context.host.give("ada");

    // Create standalone dedicated VM and rename it.
    const created = await context.host.createComputer("Research Linux");
    assert.equal(created.kind, "dedicated");
    assert.equal(created.name, "Research Linux");
    assert.deepEqual(created.assignedBotIds, []);

    const renamed = await context.host.renameComputer(created.id, "Lab Linux");
    assert.equal(renamed.name, "Lab Linux");

    // Assign Ada from shared -> existing dedicated VM.
    const moved = await context.host.assignComputer("ada", { kind: "existing", computerId: created.id });
    assert.equal(moved.computerId, created.id);
    assert.equal(moved.computerName, "Lab Linux");
    assert.equal(moved.shared, false);

    // Refuses deleting while Ada is assigned unless force: true.
    await assert.rejects(
      context.host.deleteComputer(created.id),
      (error: unknown) => error instanceof BotComputerError && error.code === "busy",
    );

    // Assign Ben to a newly cloned dedicated VM.
    const benDedicated = await context.host.assignComputer("ben", { kind: "new", name: "Ben Box" });
    assert.equal(benDedicated.computerName, "Ben Box");
    assert.equal(benDedicated.shared, false);
    assert.notEqual(benDedicated.computerId, created.id);
    assert.notEqual(benDedicated.computerId, "shared");

    // Force-deleting Lab Linux unassigns Ada and deletes the VM.
    await context.host.deleteComputer(created.id, { force: true });
    assert.equal(await context.host.computer("ada"), undefined);
    assert.equal(
      (await context.host.status()).vms.some((vm) => vm.id === created.id),
      false,
    );

    // resetComputer re-clones the shared VM while keeping its record.
    const resetShared = await context.host.resetComputer("shared");
    assert.equal(resetShared.id, "shared");
    assert.equal(resetShared.vmName, BOT_COMPUTER_SHARED_VM);
  });
});

test("removeEverything racing a shared give and a later deleteComputer settles without deadlocking", async () => {
  await withHost(async (context) => {
    await setUp(context, "shared");
    const results = await Promise.race([
      Promise.allSettled([
        context.host.give("ada"),
        context.host.removeEverything(),
        context.host.deleteComputer("shared", { force: true }),
      ]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlock in inTurn")), 10_000)),
    ]);
    assert.equal(results[1].status, "fulfilled", "removeEverything completes cleanly");
    assert.equal((await context.host.status()).vms.length, 0);
  });
});

test("reconcile on a Linux install with a missing base preserves guestOs, never triggers bogus macOS migration, and recovers aiden-base-next", async () => {
  // Case 1: missing aiden-base with no staging copy keeps Linux state intact and never triggers macOS migration.
  await withHost(async (context) => {
    await setUp(context, "shared");
    await context.host.give("ada");
    // Simulate aiden-base missing on disk without any macOS VMs or .ipsw files.
    const fakeStatePath = path.join(context.root, "vms", ".fake-state.json");
    const fakeState = JSON.parse(readFileSync(fakeStatePath, "utf8")) as { vms: Record<string, unknown> };
    delete fakeState.vms[BOT_COMPUTER_BASE_VM];
    writeFileSync(fakeStatePath, JSON.stringify(fakeState));

    const relaunched = context.relaunch({});
    await relaunched.reconcile();
    const status = await relaunched.status();
    assert.equal(status.setup.kind, "not_set_up");
    assert.equal(status.migrationNotice, undefined, "must not show macOS migration notice on a Linux install");
    assert.ok(context.vmNames().includes(BOT_COMPUTER_SHARED_VM), "existing Linux Bot VM is preserved");
    const persisted = JSON.parse(readFileSync(path.join(context.root, "state.json"), "utf8")) as {
      setup: { guestOs?: string };
      vms: Record<string, { migratedFromMacos?: boolean }>;
    };
    assert.equal(persisted.setup.guestOs, "linux");
    assert.equal(persisted.vms.shared?.migratedFromMacos, undefined);
  });

  // Case 2: missing aiden-base with a healthy aiden-base-next recovers aiden-base automatically.
  await withHost(async (context) => {
    await setUp(context, "shared");
    const fakeStatePath = path.join(context.root, "vms", ".fake-state.json");
    const fakeState = JSON.parse(readFileSync(fakeStatePath, "utf8")) as { vms: Record<string, Record<string, unknown>> };
    fakeState.vms[BOT_COMPUTER_STAGING_BASE_VM] = { ...fakeState.vms[BOT_COMPUTER_BASE_VM] };
    delete fakeState.vms[BOT_COMPUTER_BASE_VM];
    writeFileSync(fakeStatePath, JSON.stringify(fakeState));

    const relaunched = context.relaunch({});
    await relaunched.reconcile();
    const status = await relaunched.status();
    assert.equal(status.setup.kind, "ready", "recovered aiden-base from healthy staging copy");
    assert.ok(context.vmNames().includes(BOT_COMPUTER_BASE_VM));
    assert.equal(context.vmNames().includes(BOT_COMPUTER_STAGING_BASE_VM), false);
  });
});

test("active lease blocks resetComputer and unforced deleteComputer, while forced delete bumps leaseEpoch", async () => {
  await withHost(async (context) => {
    await setUp(context, "shared");
    await context.host.give("ada");
    const releaseAda = await context.host.acquireLease("ada");

    await assert.rejects(
      context.host.resetComputer("shared"),
      (error: unknown) => error instanceof BotComputerError && error.code === "busy",
    );
    await assert.rejects(
      context.host.deleteComputer("shared"),
      (error: unknown) => error instanceof BotComputerError && error.code === "busy",
    );

    // Forced delete succeeds, clears active lease, and old release is a no-op.
    await context.host.deleteComputer("shared", { force: true });
    assert.doesNotThrow(() => releaseAda());
    assert.equal((await context.host.status()).vms.length, 0);
  });
});

test("concurrent deleteComputer and assignComputer serialize cleanly without leaving dangling assignments", async () => {
  await withHost(async (context) => {
    await setUp(context, "shared");
    const created = await context.host.createComputer("Temp VM");

    const [delResult, assignResult] = await Promise.allSettled([
      context.host.deleteComputer(created.id),
      context.host.assignComputer("ada", { kind: "existing", computerId: created.id }),
    ]);

    const status = await context.host.status();
    const vmExists = status.vms.some((vm) => vm.id === created.id);
    const adaComputer = await context.host.computer("ada");
    if (delResult.status === "fulfilled") {
      assert.equal(vmExists, false);
      assert.equal(adaComputer, undefined, "must not leave Ada assigned to a deleted VM");
      assert.equal(assignResult.status, "rejected");
    } else {
      assert.equal(vmExists, true);
      assert.equal(adaComputer?.computerId, created.id);
    }
  });
});

test("reassigning the last Bot off a VM releases orphaned person Take over, and deletes clean workspace folders", async () => {
  await withHost(async (context) => {
    await setUp(context, "shared");
    await context.host.give("ada");
    await context.host.give("ben");
    const adaDir = path.join(context.root, "computers", "shared", "Computer", "bots", botComputerWorkspaceDirName("ada"));
    const benDir = path.join(context.root, "computers", "shared", "Computer", "bots", botComputerWorkspaceDirName("ben"));
    assert.equal(existsSync(adaDir), true);
    assert.equal(existsSync(benDir), true);

    // Deleting Ada removes Ada's subfolder on the shared VM while keeping Ben's.
    await context.host.deleteForBot("ada");
    assert.equal(existsSync(adaDir), false);
    assert.equal(existsSync(benDir), true);

    // Take over on shared while only Ben is assigned, then reassign Ben to a new VM -> orphaned scope is released.
    context.host.control.takeOver("ben", "viewer");
    assert.equal(context.host.control.controllerForScope("shared"), "person");
    const benNew = await context.host.assignComputer("ben", { kind: "new", name: "Ben Solo" });
    assert.equal(context.host.control.controllerForScope("shared"), "bot");

    // Deleting the shared VM removes its computers/shared workspace folder.
    await context.host.deleteComputer("shared");
    assert.equal(existsSync(path.join(context.root, "computers", "shared")), false);
    assert.equal(existsSync(path.join(context.root, "computers", benNew.computerId)), true);
    await context.host.deleteForBot("ben");
    assert.equal(existsSync(path.join(context.root, "computers", benNew.computerId)), false);
  });
});

test("sharedDirForVm refuses symbolic links planted inside the host Computer workspace", async () => {
  await withHost(async (context) => {
    await setUp(context, "shared");
    const outside = mkdtempSync(path.join(tmpdir(), "aiden-outside-target-"));
    try {
      const sharedComputerDir = path.join(context.root, "computers", "shared", "Computer");
      mkdirSync(sharedComputerDir, { recursive: true });
      symlinkSync(outside, path.join(sharedComputerDir, "bots"));

      await assert.rejects(
        context.host.give("ada"),
        (error: unknown) => error instanceof BotComputerError && error.code === "invalid",
      );
      assert.equal(existsSync(path.join(outside, botComputerWorkspaceDirName("ada"))), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
