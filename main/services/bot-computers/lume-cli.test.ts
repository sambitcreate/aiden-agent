import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { lumeArgs, lumeEnvironment, runLume, type LumeCommand } from "./lume-cli.js";
import { runBoundedProcess } from "./bounded-process.js";
import { BotComputerError } from "./types.js";
import { BOT_COMPUTER_BASE_VM, botComputerVmName, isAidenVmName } from "./vm-names.js";

const storage = "/Users/person/Library/Application Support/Aiden Agent/bot-computers/vms";
const botVm = botComputerVmName("bot-ada");
const fake = path.resolve("tests/e2e/lume-fake.mjs");

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

test("every operation names Aiden's storage; clone names it as source and destination", () => {
  const commands: LumeCommand[] = [
    { op: "create", name: BOT_COMPUTER_BASE_VM, ipsw: "/tmp/restore.ipsw", unattended: "tahoe" },
    { op: "run", name: botVm, vncPassword: "Zq7Tn2Lw9Rk4Hm6X", sharedDir: "/Users/person/Bots/ada/Computer" },
    { op: "get", name: botVm },
    { op: "list" },
    { op: "stop", name: botVm },
    { op: "delete", name: botVm },
    { op: "ssh", name: BOT_COMPUTER_BASE_VM, command: "uname -a" },
  ];
  for (const command of commands) {
    const args = lumeArgs(command, storage);
    assert.equal(option(args, "--storage"), storage, `${command.op} carries --storage`);
  }
  const clone = lumeArgs({ op: "clone", source: BOT_COMPUTER_BASE_VM, target: botVm }, storage);
  assert.equal(option(clone, "--source-storage"), storage);
  assert.equal(option(clone, "--dest-storage"), storage);
  assert.equal(clone.includes("--storage"), false, "clone has no --storage flag in Lume 0.6.1");
});

test("run is detached and headless with the shared folder tagged read-write", () => {
  const args = lumeArgs(
    { op: "run", name: botVm, vncPassword: "Zq7Tn2Lw9Rk4Hm6X", sharedDir: "/Users/person/Bots/ada/Computer", logFile: "/tmp/ada.log" },
    storage,
  );
  assert.ok(args.includes("--detach"));
  assert.equal(option(args, "--display"), "none");
  assert.equal(option(args, "--shared-dir"), "/Users/person/Bots/ada/Computer:rw");
  assert.equal(option(args, "--log-file"), "/tmp/ada.log");
});

test("delete always passes --force and ssh puts its options before the VM name", () => {
  assert.ok(lumeArgs({ op: "delete", name: botVm }, storage).includes("--force"));
  const ssh = lumeArgs({ op: "ssh", name: botVm, command: "echo hi; ls ~", timeoutSeconds: 20 }, storage);
  assert.deepEqual(ssh.slice(-2), [botVm, "echo hi; ls ~"], "the remote command is one argv element after the name");
  assert.equal(option(ssh, "--timeout"), "20");
});

test("a shared folder with a colon, a relative path or a foreign VM name is refused", () => {
  const refuse = (command: LumeCommand, store = storage) =>
    assert.throws(() => lumeArgs(command, store), (error: unknown) => error instanceof BotComputerError && error.code === "invalid");
  refuse({ op: "run", name: botVm, vncPassword: "Zq7Tn2Lw9Rk4Hm6X", sharedDir: "/Users/person/a:b/Computer" });
  refuse({ op: "run", name: botVm, vncPassword: "Zq7Tn2Lw9Rk4Hm6X", sharedDir: "relative/Computer" });
  refuse({ op: "get", name: "my-own-vm" });
  // A `name:tag` reaching `lume run` would make it pull from a registry.
  refuse({ op: "run", name: "macos-sequoia:latest", vncPassword: "Zq7Tn2Lw9Rk4Hm6X", sharedDir: "/tmp/x" });
  refuse({ op: "create", name: BOT_COMPUTER_BASE_VM, ipsw: "latest", unattended: "tahoe" });
  refuse({ op: "list" }, "relative/vms");
  refuse({ op: "serve" } as unknown as LumeCommand);
});

test("VM names hash the Bot id and never carry it", () => {
  const name = botComputerVmName("bot:with/odd~chars");
  assert.match(name, /^aiden-bot-[0-9a-f]{16}$/u);
  assert.equal(name, botComputerVmName("bot:with/odd~chars"));
  assert.notEqual(name, botComputerVmName("bot:with/odd~chars2"));
  assert.ok(isAidenVmName(name) && isAidenVmName(BOT_COMPUTER_BASE_VM));
  assert.equal(isAidenVmName("aiden-bot-XYZ"), false);
});

test("the environment is an allowlist with privacy switches and an isolated home", () => {
  const env = lumeEnvironment(
    {
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/person",
      LANG: "en_GB.UTF-8",
      LC_ALL: "en_GB.UTF-8",
      TMPDIR: "/var/folders/x",
      USER: "person",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      LUME_TELEMETRY_ENABLED: "true",
      GITHUB_TOKEN: "ghp_secret",
      NODE_OPTIONS: "--inspect",
    },
    "/Users/person/Library/Application Support/Aiden Agent/bot-computers/home",
  );
  assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(env.LUME_TELEMETRY_ENABLED, "false");
  assert.equal(env.LUME_UPDATE_CHECK, "false");
  assert.equal(env.DO_NOT_TRACK, "1");
  assert.equal(env.HOME, "/Users/person/Library/Application Support/Aiden Agent/bot-computers/home");
  assert.ok(env.XDG_CONFIG_HOME?.startsWith(env.HOME));
  assert.equal(env.LANG, "en_GB.UTF-8");
  assert.equal(env.LC_ALL, "en_GB.UTF-8");
  for (const leaked of ["SSH_AUTH_SOCK", "GITHUB_TOKEN", "NODE_OPTIONS"]) assert.equal(env[leaked], undefined, leaked);
  for (const value of Object.values(env)) assert.equal(value.startsWith("/Users/person/.") , false);
});

test("runLume spawns the fixed invocation and returns a failing exit as a result", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p8-lume-cli-"));
  const logFile = path.join(dir, "calls.jsonl");
  const env = { ...lumeEnvironment({}, path.join(dir, "home")), AIDEN_E2E_FAKE_LUME_LOG: logFile };
  const missing = await runLume(
    { command: process.execPath, prefixArgs: [fake] },
    { op: "get", name: botVm },
    { storage: path.join(dir, "vms"), env, timeoutMs: 10_000 },
  );
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /Virtual machine not found/u);
  const [call] = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
  assert.equal(call?.env.LUME_TELEMETRY_ENABLED, "false");
  assert.ok(call?.args.includes("--storage"));

  await assert.rejects(
    runLume({ command: process.execPath, prefixArgs: [fake] }, { op: "list" }, {
      storage: path.join(dir, "vms"),
      env: { ...env, LUME_TELEMETRY_ENABLED: "true" },
      timeoutMs: 10_000,
    }),
    /telemetry/u,
  );
});

test("output past the cap ends the child, and a hung child is killed at its timeout", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p8-bounded-"));
  const noisy = path.join(dir, "noisy.mjs");
  writeFileSync(noisy, "process.stdout.write('x'.repeat(4 * 1024 * 1024)); setInterval(() => {}, 1000);\n");
  await assert.rejects(
    runBoundedProcess(process.execPath, [noisy], { env: {}, timeoutMs: 10_000, maxStdoutBytes: 1024, overflow: "fail" }),
    /too much output/u,
  );
  const truncated = await runBoundedProcess(process.execPath, ["-e", "process.stdout.write('y'.repeat(5000))"], {
    env: {},
    timeoutMs: 10_000,
    maxStdoutBytes: 100,
    overflow: "truncate",
  });
  assert.equal(truncated.stdout.length, 100);
  assert.equal(truncated.truncated, true);

  const hung = path.join(dir, "hung.mjs");
  writeFileSync(hung, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
  const started = Date.now();
  const result = await runBoundedProcess(process.execPath, [hung], { env: {}, timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 8_000, "TERM then KILL ends a child that ignores TERM");

  const controller = new AbortController();
  const pending = runBoundedProcess(process.execPath, [hung], { env: {}, timeoutMs: 60_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof BotComputerError && error.code === "cancelled");
});

test("onSpawn hears that the executable started, and never fires for one that couldn't be started", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p8-bounded-"));
  let spawned = 0;
  const onSpawn = () => void (spawned += 1);
  const ran = await runBoundedProcess(process.execPath, ["-e", "process.exit(3)"], { env: {}, timeoutMs: 10_000, onSpawn });
  assert.equal(ran.exitCode, 3);
  assert.equal(spawned, 1, "a child that ran and failed still started");
  await assert.rejects(
    runBoundedProcess(path.join(dir, "missing-lume"), [], { env: {}, timeoutMs: 10_000, onSpawn }),
    (error: unknown) => error instanceof BotComputerError && error.code === "lume_failed" && /is missing/u.test(error.message),
  );
  assert.equal(spawned, 1, "a missing executable never started");
});
