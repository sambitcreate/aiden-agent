import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAndBootHiddenLinuxBase, prepareLinuxBaseDisk } from "./linux-base.js";
import { BOT_COMPUTERS_LINUX_FLAG } from "./linux-feature-flag.js";
import { lumeEnvironment, runLume } from "./lume-cli.js";
import { BOT_COMPUTER_LINUX_DISK_BYTES } from "./release.js";
import { BotComputerError } from "./types.js";
import { BOT_COMPUTER_BASE_VM } from "./vm-names.js";

const FAKE_LUME = path.resolve("tests/e2e/lume-fake.mjs");
const TEST_SSH_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAidenKeyForBotComputerLinuxBaseTests0123456789";

interface LoggedCall {
  kind: string;
  op?: string;
  pid?: number;
  args?: string[];
  env?: Record<string, string | undefined>;
}

function readCalls(logPath: string): LoggedCall[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedCall);
}

test("prepareLinuxBaseDisk copies the verified raw image and grows it sparsely to 24 GiB", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-linux-disk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "debian-13-generic-arm64.raw");
  const target = path.join(dir, "vms", BOT_COMPUTER_BASE_VM, "disk.img");
  const header = Buffer.from("DEBIAN-13-RAW-GPT-HEADER");
  writeFileSync(source, header);

  const result = await prepareLinuxBaseDisk({ sourceImagePath: source, targetDiskPath: target });
  assert.equal(result.bytes, BOT_COMPUTER_LINUX_DISK_BYTES);
  const info = statSync(target);
  assert.equal(info.size, BOT_COMPUTER_LINUX_DISK_BYTES);
  const prefix = Buffer.alloc(header.length);
  const { openSync, readSync, closeSync } = await import("node:fs");
  const fd = openSync(target, "r");
  try {
    readSync(fd, prefix, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  assert.deepEqual(prefix, header, "the original raw disk bytes remain intact at offset 0");

  await assert.rejects(
    prepareLinuxBaseDisk({ sourceImagePath: source, targetDiskPath: target, targetBytes: 4 }),
    (error: unknown) => error instanceof BotComputerError && error.code === "invalid",
  );
});

test("createAndBootHiddenLinuxBase is refused when AIDEN_BOT_COMPUTERS_LINUX is off and runs no Lume", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-linux-off-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, "lume.jsonl");
  const configFile = path.join(dir, "fake.json");
  writeFileSync(configFile, JSON.stringify({ log: logPath }));
  const rawImage = path.join(dir, "debian.raw");
  writeFileSync(rawImage, "raw");

  await assert.rejects(
    createAndBootHiddenLinuxBase({
      vmName: BOT_COMPUTER_BASE_VM,
      invocation: { command: process.execPath, prefixArgs: [FAKE_LUME, "--fake-config", configFile] },
      storage: path.join(dir, "vms"),
      lumeEnv: lumeEnvironment({}, path.join(dir, "home")),
      sharedDir: path.join(dir, "shared"),
      logFile: path.join(dir, "base.log"),
      sourceImagePath: rawImage,
      seedIsoPath: path.join(dir, "cidata.iso"),
      sshAuthorizedKey: TEST_SSH_KEY,
      password: "GuestPassword1234567890",
      vncPassword: "Zq7Tn2Lw9Rk4Hm6X",
      featureEnv: {},
      pollIntervalMs: 20,
    }),
    (error: unknown) => error instanceof BotComputerError && error.code === "unsupported",
  );
  assert.equal(readCalls(logPath).length, 0, "no Lume call runs while the build switch is off");
});

test("createAndBootHiddenLinuxBase creates a Linux VM, grows its disk, mounts CIDATA ISO, and boots with audio/clipboard off", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-linux-on-"));
  const storage = path.join(dir, "vms");
  const home = path.join(dir, "home");
  const logPath = path.join(dir, "lume.jsonl");
  const configFile = path.join(dir, "fake.json");
  writeFileSync(configFile, JSON.stringify({ log: logPath }));
  const rawImage = path.join(dir, "debian.raw");
  writeFileSync(rawImage, "debian-13-generic-arm64");
  const seedIsoPath = path.join(dir, "cidata.iso");
  const invocation = { command: process.execPath, prefixArgs: [FAKE_LUME, "--fake-config", configFile] };
  const env = lumeEnvironment({}, home);

  t.after(async () => {
    await runLume(invocation, { op: "stop", name: BOT_COMPUTER_BASE_VM, force: true }, { storage, env, timeoutMs: 10_000 }).catch(
      () => undefined,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  const booted = await createAndBootHiddenLinuxBase({
    vmName: BOT_COMPUTER_BASE_VM,
    invocation,
    storage,
    lumeEnv: env,
    sharedDir: path.join(dir, "shared"),
    logFile: path.join(dir, "base.log"),
    sourceImagePath: rawImage,
    seedIsoPath,
    sshAuthorizedKey: TEST_SSH_KEY,
    password: "GuestPassword1234567890",
    vncPassword: "Zq7Tn2Lw9Rk4Hm6X",
    featureEnv: { [BOT_COMPUTERS_LINUX_FLAG]: "1" },
    pollIntervalMs: 20,
    startTimeoutMs: 10_000,
  });

  assert.equal(booted.vmName, BOT_COMPUTER_BASE_VM);
  assert.equal(booted.vnc.host, "127.0.0.1");
  assert.ok(booted.vnc.port > 0);
  assert.equal(statSync(booted.diskPath).size, BOT_COMPUTER_LINUX_DISK_BYTES);
  assert.equal(statSync(seedIsoPath).size, booted.seedIsoBytes);

  const calls = readCalls(logPath).filter((entry) => entry.kind === "cli");
  const createCall = calls.find((entry) => entry.op === "create");
  assert.ok(createCall?.args?.includes("--os"));
  assert.equal(createCall?.args?.[createCall.args.indexOf("--os") + 1], "linux");
  assert.equal(createCall?.args?.[createCall.args.indexOf("--memory") + 1], "4GB");
  assert.equal(createCall?.args?.[createCall.args.indexOf("--disk-size") + 1], "24GB");
  assert.equal(createCall?.args?.includes("--ipsw"), false);

  const runCall = calls.find((entry) => entry.op === "run");
  assert.ok(runCall?.args?.includes("--no-audio-device"));
  assert.ok(runCall?.args?.includes("--no-clipboard-device"));
  assert.equal(runCall?.args?.[runCall.args.indexOf("--mount") + 1], seedIsoPath);

  for (const call of calls) {
    assert.equal(call.env?.LUME_TELEMETRY_ENABLED, "false");
    assert.equal(call.env?.LUME_UPDATE_CHECK, "false");
    assert.equal(call.env?.HOME, home);
    assert.equal(call.args?.[call.args.indexOf("--storage") + 1], storage);
  }
});

test("createAndBootHiddenLinuxBase supports --disk-path override and stops the VM when VNC is non-loopback", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-linux-diskpath-"));
  const storage = path.join(dir, "vms");
  const home = path.join(dir, "home");
  const logPath = path.join(dir, "lume.jsonl");
  const configFile = path.join(dir, "fake.json");
  writeFileSync(configFile, JSON.stringify({ log: logPath, vncHost: "192.168.1.99" }));
  const rawImage = path.join(dir, "debian.raw");
  writeFileSync(rawImage, "debian-13-generic-arm64");
  const customDisk = path.join(dir, "custom", "linux.img");
  const invocation = { command: process.execPath, prefixArgs: [FAKE_LUME, "--fake-config", configFile] };
  const env = lumeEnvironment({}, home);

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    createAndBootHiddenLinuxBase({
      vmName: BOT_COMPUTER_BASE_VM,
      invocation,
      storage,
      lumeEnv: env,
      sharedDir: path.join(dir, "shared"),
      logFile: path.join(dir, "base.log"),
      sourceImagePath: rawImage,
      diskPathOverride: customDisk,
      seedIsoPath: path.join(dir, "cidata.iso"),
      sshAuthorizedKey: TEST_SSH_KEY,
      vncPassword: "Zq7Tn2Lw9Rk4Hm6X",
      featureEnv: { [BOT_COMPUTERS_LINUX_FLAG]: "true" },
      pollIntervalMs: 20,
      startTimeoutMs: 10_000,
    }),
    (error: unknown) => error instanceof BotComputerError && error.code === "vnc_not_loopback",
  );

  const calls = readCalls(logPath).filter((entry) => entry.kind === "cli");
  const runCall = calls.find((entry) => entry.op === "run");
  assert.equal(runCall?.args?.[runCall.args.indexOf("--disk-path") + 1], customDisk);
  assert.ok(calls.some((entry) => entry.op === "stop" && entry.args?.includes("--force")), "a non-loopback Linux VM is force-stopped");
});

test("createAndBootHiddenLinuxBase force-stops a VM when aborted while lume run is still returning", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-linux-abort-"));
  const storage = path.join(dir, "vms");
  const home = path.join(dir, "home");
  const logPath = path.join(dir, "lume.jsonl");
  const configFile = path.join(dir, "fake.json");
  writeFileSync(configFile, JSON.stringify({ log: logPath, runReturnDelayMs: 2_000 }));
  const rawImage = path.join(dir, "debian.raw");
  writeFileSync(rawImage, "debian-13-generic-arm64");
  const invocation = { command: process.execPath, prefixArgs: [FAKE_LUME, "--fake-config", configFile] };
  const env = lumeEnvironment({}, home);

  t.after(async () => {
    await runLume(invocation, { op: "stop", name: BOT_COMPUTER_BASE_VM, force: true }, { storage, env, timeoutMs: 10_000 }).catch(
      () => undefined,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  const controller = new AbortController();
  const pending = createAndBootHiddenLinuxBase({
    vmName: BOT_COMPUTER_BASE_VM,
    invocation,
    storage,
    lumeEnv: env,
    sharedDir: path.join(dir, "shared"),
    logFile: path.join(dir, "base.log"),
    sourceImagePath: rawImage,
    seedIsoPath: path.join(dir, "cidata.iso"),
    sshAuthorizedKey: TEST_SSH_KEY,
    vncPassword: "Zq7Tn2Lw9Rk4Hm6X",
    featureEnv: { [BOT_COMPUTERS_LINUX_FLAG]: "1" },
    pollIntervalMs: 20,
    startTimeoutMs: 10_000,
    signal: controller.signal,
  });

  // Wait until `lume run` has spawned the VM, then abort before `lume run` returns.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (readCalls(logPath).some((entry) => entry.kind === "vnc")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(readCalls(logPath).some((entry) => entry.kind === "vnc"), "fake VM spawned before abort");
  controller.abort();
  await assert.rejects(pending);

  const calls = readCalls(logPath).filter((entry) => entry.kind === "cli");
  assert.ok(calls.some((entry) => entry.op === "stop" && entry.args?.includes("--force")), "aborted mid-run launch still force-stops the VM");
});
