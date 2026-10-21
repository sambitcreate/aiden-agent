import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { BoundedProcessOptions, BoundedProcessResult } from "./bounded-process.js";
import { createGuestCuaDriverHostFactory } from "./guest-driver.js";
import { createBotComputerHost, type BotComputerHostDependencies } from "./host.js";
import { BOT_COMPUTER_GUEST_PASSWORD_SECRET, BotComputerError } from "./types.js";
import { BOT_COMPUTER_BASE_VM, botComputerVmName } from "./vm-names.js";

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
  vncHost?: string;
  stopDelayMs?: number;
  stopFails?: string;
  cloneDelayMs?: number;
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
  const fetches: { url: string; redirect?: RequestRedirect }[] = [];
  const idle: { botId?: string; callback: () => void; ms: number; cancelled: boolean }[] = [];
  let clock = 1_000_000_000;
  const events = { ready: 0, removed: 0 };
  /** A guest command that should fail, for example one step of provisioning, or answer with its own output. */
  const ssh: {
    fails?: (args: readonly string[]) => boolean;
    stdout?: (args: readonly string[]) => string | undefined;
  } = {};
  const runProcess = async (command: string, args: readonly string[], options: BoundedProcessOptions): Promise<BoundedProcessResult> => {
    const done = { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false };
    if (command.endsWith("ssh-keygen")) {
      const file = args[args.indexOf("-f") + 1] ?? "";
      writeFileSync(file, "PRIVATE", { mode: 0o600 });
      writeFileSync(`${file}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAidenKeyForBotComputerProvisioningTests012345678 aiden\n");
      return done;
    }
    sshCalls.push({ args, stdin: options.stdin, stdinFile: options.stdinFile });
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
  const deps: BotComputerHostDependencies = {
    root,
    lume: async () => ({ command: process.execPath, prefixArgs: [fake, "--fake-config", configFile] }),
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
    secrets,
    sshCalls,
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
        ...calls().filter((call) => call.kind === "vnc").map((call) => call.pid),
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
    assert.equal(await context.host.baseReady(), false, "no Bot can use a computer before Set up");
    assert.equal(context.calls().length, 0, "status alone never runs Lume");
    assert.equal(context.fetches.length, 0, "nothing downloads before Set up");

    await setUp(context);
    assert.equal(await context.host.baseReady(), true);
    const status = await context.host.status();
    assert.deepEqual(status.setup, { kind: "ready", baseVersion: "26.6.2", baseBuild: "25G83", updateAvailable: false, elementControl: false });
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

test("Set up with too little free memory says so before downloading, and again before it boots the base", async () => {
  const plenty = 64 * 1024 ** 3;
  const short = 2 * 1024 ** 3;
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
      const partial = path.join(context.root, "restore-images", "UniversalMac_25G83_Restore.ipsw.part");
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
    // An earlier launch quit while Lume was installing macOS into the base.
    mkdirSync(path.join(context.root, "vms", BOT_COMPUTER_BASE_VM), { recursive: true });
    writeFileSync(
      path.join(context.root, "vms", ".fake-state.json"),
      JSON.stringify({ vms: { [BOT_COMPUTER_BASE_VM]: { status: "stopped", ip: "192.168.64.10", mac: "a6:4f:2c:9e:13:10" } } }),
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
      (error: unknown) => error instanceof BotComputerError && error.code === "vm_limit" && /two virtual machines/u.test(error.message),
    );
    assert.equal((await context.host.computer("ben"))?.state, "stopped");
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
    assert.deepEqual((await host.status()).setup, { kind: "ready", baseVersion: "26.6.2", baseBuild: "25G83", updateAvailable: true, elementControl: false });
    assert.equal((await host.computer("ada"))?.outdated, false);

    await host.updateBase();
    assert.deepEqual((await host.status()).setup, { kind: "ready", baseVersion: "26.7", baseBuild: "25H5", updateAvailable: false, elementControl: false });
    assert.equal(last(context.fetches)?.url, pin.url);
    const installs = context.calls().filter((call) => call.op === "create");
    assert.equal(installs.length, 2);
    assert.match(installs[1]?.args?.[installs[1].args.indexOf("--ipsw") + 1] ?? "", /25H5/u, "the new base installs the newer image");
    assert.deepEqual(context.vmNames(), [BOT_COMPUTER_BASE_VM, botComputerVmName("ada")].sort(), "the new base is swapped in, nothing left beside it");
    assert.equal(existsSync(path.join(context.root, "restore-images", "UniversalMac_25H5_Restore.ipsw")), false);
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
      (error: unknown) => error instanceof BotComputerError && error.code === "vm_limit" && /two virtual machines/u.test(error.message),
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
      // Reconcile runs while Set up boots the base to prepare it.
      const building = gate.arm();
      const setup = context.host.setUp();
      await building.atGate;
      await context.host.reconcile();
      building.release();
      await setup;
      assert.equal((await context.host.status()).setup.kind, "ready");

      // And while a Bot's computer is starting, for example one a routine needs at launch.
      await context.host.give("ada");
      const starting = gate.arm();
      const start = context.host.ensureRunning("ada", { reason: "routine" });
      await starting.atGate;
      await context.host.reconcile();
      starting.release();
      await start;
      assert.equal(context.vmRunning(botComputerVmName("ada")), true, "the computer the Bot was given is the one running");
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

/** A host whose guest sessions run the fake guest driver, with grants read from a file. */
function guestDriverHarness(options: { grantOnPrompt?: boolean; executable?: () => Promise<string>; hangOn?: string } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "p11-guest-"));
  const callLog = path.join(dir, "guest-calls.jsonl");
  const permissions = path.join(dir, "permissions.json");
  writeFileSync(permissions, JSON.stringify({ accessibility: false, screen_recording: false }));
  const driverFile = path.join(dir, "cua-driver");
  writeFileSync(driverFile, "vendored driver bytes");
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
            args: [
              GUEST_FIXTURE,
              "--permissions-file",
              permissions,
              "--log",
              callLog,
              ...(options.grantOnPrompt ? ["--grant-on-prompt"] : []),
              ...(options.hangOn ? ["--hang-on", options.hangOn] : []),
            ],
            env: { PATH: "/usr/bin:/bin" },
          };
        },
      }),
    permissionPollMs: 20,
  };
  return {
    overrides,
    driverFile,
    noticeFile,
    bridges,
    grant: () => writeFileSync(permissions, JSON.stringify({ accessibility: true, screen_recording: true })),
    /** The driver tools the guest was asked to run, in order. */
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

/** The guest answers the install's location step as a macOS guest would. */
function answerGuest(context: Harness): void {
  context.ssh.stdout = (args) => (last(args)?.includes("aiden-guest-driver") ? "aiden-guest-driver 501 /Users/lume\n" : undefined);
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Set up installs the guest driver, waits in the base's live view for the grants, and records element control", async () => {
  const guest = guestDriverHarness();
  await withHost(async (context) => {
    answerGuest(context);
    const setup = context.host.setUp();
    await waitFor(async () => {
      const state = (await context.host.status()).setup;
      return state.kind === "building_base" && state.step === "permissions" && state.permissions !== undefined;
    }, "the permission step");
    // While it waits, Settings can show the running base's screen.
    const view = context.host.baseView();
    assert.equal(view?.vmName, BOT_COMPUTER_BASE_VM);
    assert.equal(view?.vnc.host, "127.0.0.1");
    assert.deepEqual((await context.host.status()).setup, {
      kind: "building_base",
      step: "permissions",
      permissions: { accessibility: false, screenRecording: false },
    });

    guest.grant();
    context.host.checkPermissions();
    await setup;
    assert.equal(context.host.baseView(), undefined, "the view ends with the step");
    const status = await context.host.status();
    assert.equal(status.setup.kind === "ready" && status.setup.elementControl, true);

    // The vendored file, and its licence notice, went over stdin; the password only ever on stdin.
    const password = context.secrets.get(BOT_COMPUTER_GUEST_PASSWORD_SECRET) ?? "";
    assert.ok(context.sshCalls.some((call) => call.stdinFile === guest.driverFile));
    assert.ok(context.sshCalls.some((call) => call.stdinFile === guest.noticeFile && /LICENSE\.cua-driver\.md/u.test(last(call.args) ?? "")));
    const restart = context.sshCalls.find((call) => last(call.args)?.includes("kickstart -k gui/501/com.aiden.bot-computer.cua-driver"));
    assert.equal(restart?.stdin, `${password}\n`);
    for (const call of context.sshCalls) assert.equal(call.args.join(" ").includes(password), false);
    // Every guest session went over Aiden's own ssh to the base, ending in the driver's MCP proxy.
    assert.ok(guest.bridges.length >= 2, "one session to wait for the grants, one to probe after the restart");
    for (const bridge of guest.bridges) {
      assert.equal(bridge.command, "/usr/bin/ssh");
      assert.match(last(bridge.args) ?? "", /mcp --embedded --socket/u);
    }

    // Clones inherit the base's disk, grants and flag; the Bot's computer offers the driver lane.
    await context.host.give("ada");
    assert.ok(await context.host.guestDriver("ada"));
  }, guest.overrides);
});

test("skipping the grants keeps the screen-only lane, and element control can be set up later on the ready base", async () => {
  const guest = guestDriverHarness();
  await withHost(async (context) => {
    answerGuest(context);
    const setup = context.host.setUp();
    await waitFor(async () => {
      const state = (await context.host.status()).setup;
      return state.kind === "building_base" && state.step === "permissions";
    }, "the permission step");
    context.host.skipPermissions();
    await setup;
    const skipped = (await context.host.status()).setup;
    assert.equal(skipped.kind, "ready");
    assert.equal(skipped.kind === "ready" && skipped.elementControl, false);
    assert.match(skipped.kind === "ready" ? (skipped.elementControlNote ?? "") : "", /skipped/u);
    await context.host.give("ada");
    assert.equal(await context.host.guestDriver("ada"), undefined, "a computer from that base stays on the VNC lane");

    // Later, from Settings: the base boots once, the person allows them, and it shuts down again.
    const runsBefore = context.calls().filter((call) => call.kind === "cli" && call.op === "run").length;
    const later = context.host.setUpElementControl();
    await waitFor(async () => {
      const state = (await context.host.status()).setup;
      return state.kind === "building_base" && state.step === "permissions";
    }, "the permission step again");
    await assert.rejects(context.host.give("bea"), (error: unknown) => error instanceof BotComputerError && error.code === "busy");
    guest.grant();
    context.host.checkPermissions();
    await later;
    const ready = (await context.host.status()).setup;
    assert.equal(ready.kind === "ready" && ready.elementControl, true);
    const cli = context.calls().filter((call) => call.kind === "cli");
    assert.equal(cli.filter((call) => call.op === "run").length, runsBefore + 1);
    assert.equal(last(cli)?.op, "stop", "the base is shut down again");
    assert.equal(context.vmRunning(BOT_COMPUTER_BASE_VM), false);
    // Ada's computer predates the grant; a new one gets it.
    assert.equal(await context.host.guestDriver("ada"), undefined);
    await context.host.give("bea");
    assert.ok(await context.host.guestDriver("bea"));
  }, guest.overrides);
});

test("Skip ends the permission step at once, even while the guest is still answering the first check", async () => {
  const guest = guestDriverHarness({ hangOn: "check_permissions" });
  await withHost(async (context) => {
    answerGuest(context);
    const setup = context.host.setUp();
    await waitFor(() => guest.toolCalls().includes("check_permissions"), "the first permission check");
    const skippedAt = Date.now();
    context.host.skipPermissions();
    await setup;
    assert.ok(Date.now() - skippedAt < 5_000, "Skip doesn't wait for the guest's answer");
    const status = (await context.host.status()).setup;
    assert.equal(status.kind, "ready");
    assert.equal(status.kind === "ready" && status.elementControl, false);
    assert.match(status.kind === "ready" ? (status.elementControlNote ?? "") : "", /skipped/u);
    assert.equal(context.vmRunning(BOT_COMPUTER_BASE_VM), false, "the base is shut down");
  }, guest.overrides);
});

test("Skip during the probe after the grants also finishes without element control", async () => {
  const guest = guestDriverHarness({ grantOnPrompt: true, hangOn: "health_report" });
  await withHost(async (context) => {
    answerGuest(context);
    const setup = context.host.setUp();
    await waitFor(() => guest.toolCalls().includes("health_report"), "the probe");
    context.host.skipPermissions();
    await setup;
    const status = (await context.host.status()).setup;
    assert.equal(status.kind === "ready" && status.elementControl, false);
    assert.match(status.kind === "ready" ? (status.elementControlNote ?? "") : "", /skipped/u);
  }, guest.overrides);
});

test("element control setup waits for a computer still being copied from the base before it boots the base", async () => {
  await withHost(async (context) => {
    await setUp(context);
    context.config.cloneDelayMs = 400;
    context.writeConfig();
    const giving = context.host.give("ada");
    await waitFor(() => context.calls().some((call) => call.op === "clone"), "the copy to begin");
    const elementControl = context.host.setUpElementControl();
    const given = await giving;
    await elementControl;
    assert.equal(given.vmName, botComputerVmName("ada"), "the copy finished whole");
    const cli = context.calls().filter((call) => call.kind === "cli");
    const copy = cli.find((call) => call.op === "clone");
    const boot = cli.find((call) => call.op === "run" && call.args?.includes(BOT_COMPUTER_BASE_VM) && (call.at ?? 0) > (copy?.at ?? 0));
    assert.ok(copy?.at !== undefined && boot?.at !== undefined, "the copy and then the base's boot both ran");
    assert.ok(boot.at >= copy.at + 400, "the base boots only once the copy is done");
  });
});

test("a guest driver that can't be installed leaves a working base that acts on the screen only", async () => {
  const guest = guestDriverHarness({
    executable: async () => {
      throw new Error("The pinned cua-driver has not been vendored.");
    },
  });
  await withHost(async (context) => {
    answerGuest(context);
    await setUp(context);
    const status = (await context.host.status()).setup;
    assert.equal(status.kind === "ready" && status.elementControl, false);
    assert.match(status.kind === "ready" ? (status.elementControlNote ?? "") : "", /couldn't install its helper/u);
    assert.equal(guest.bridges.length, 0, "no guest session without a driver");
  }, guest.overrides);
});
