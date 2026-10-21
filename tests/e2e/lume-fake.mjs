// A stand-in for the vendored `lume` 0.6.1 CLI in Bot-computer host tests.
// It parses arguments the way Lume's swift-argument-parser commands do and
// prints the JSON shapes in main/services/bot-computers/fixtures/, but runs no
// VM: `run --detach` starts a detached loopback TCP server that plays the VNC
// listener and records its port.
//
// It enforces what Aiden must always do and fails otherwise:
// - LUME_TELEMETRY_ENABLED and LUME_UPDATE_CHECK are "false";
// - every command names Aiden's storage (`--storage`, or for `clone` both
//   `--source-storage` and `--dest-storage`);
// - `serve`, `pull`, `update`, `push`, `ipsw` and `setup` are refused;
// - `delete` needs `--force` (the real CLI would wait on stdin).
//
// State lives in <storage>/.fake-state.json. Every call is appended as a JSON
// line to AIDEN_E2E_FAKE_LUME_LOG. Switches (environment variables, or the
// keys log, stale, limit, vncHost, stopDelayMs, stopFails, cloneDelayMs, hostKey and vncUpstream of a
// JSON file named by a leading `--fake-config <file>`):
// - AIDEN_FAKE_LUME_STALE: comma-separated VM names reported as "provisioning (stale)";
// - AIDEN_FAKE_LUME_LIMIT: how many VMs may run before a start fails with the
//   Virtualization VM-limit error (written to the --log-file, as the detached run does);
//   an unattended `create` boots its VM, so it fails the same way, on stderr;
// - AIDEN_FAKE_LUME_VNC_HOST: the host `get` reports in vncUrl (default 127.0.0.1);
// - AIDEN_FAKE_LUME_STOP_DELAY_MS: how long `stop` takes before the VM is off (default 0);
// - AIDEN_FAKE_LUME_STOP_FAILS: comma-separated VM names whose `stop` (graceful or forced)
//   fails and leaves the VM running;
// - AIDEN_FAKE_LUME_CLONE_DELAY_MS: how long `clone` copies the disk. A source that starts
//   running meanwhile fails the clone: the real copy would be torn, and the fake says so.
// - AIDEN_FAKE_LUME_HOST_KEY: the `ssh-ed25519 …` host key a fresh install gets
//   (every macOS install makes its own; clones keep their source's). The VM's
//   key is in the fake state, so host tests can check what ssh would trust.
// - AIDEN_FAKE_LUME_VNC_UPSTREAM: a loopback port the VM's VNC listener
//   forwards every connection to, so a test's fake RFB server plays the
//   guest's screen (it reads the run's `--vnc-password` from the fake state).
//   Unset, the listener only greets and hangs up.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const fixtures = path.resolve(path.dirname(self), "../../main/services/bot-computers/fixtures");
let args = process.argv.slice(2);
// Aiden gives Lume an allowlisted environment, so host tests pass the
// switches as `--fake-config <file>` ahead of the real arguments instead.
if (args[0] === "--fake-config") {
  const config = JSON.parse(readFileSync(args[1], "utf8"));
  const names = {
    log: "AIDEN_E2E_FAKE_LUME_LOG",
    stale: "AIDEN_FAKE_LUME_STALE",
    limit: "AIDEN_FAKE_LUME_LIMIT",
    vncHost: "AIDEN_FAKE_LUME_VNC_HOST",
    stopDelayMs: "AIDEN_FAKE_LUME_STOP_DELAY_MS",
    stopFails: "AIDEN_FAKE_LUME_STOP_FAILS",
    cloneDelayMs: "AIDEN_FAKE_LUME_CLONE_DELAY_MS",
    hostKey: "AIDEN_FAKE_LUME_HOST_KEY",
    vncUpstream: "AIDEN_FAKE_LUME_VNC_UPSTREAM",
  };
  for (const [key, name] of Object.entries(names)) {
    if (config[key] !== undefined && config[key] !== null) process.env[name] = String(config[key]);
  }
  args = args.slice(2);
}
const logPath = process.env.AIDEN_E2E_FAKE_LUME_LOG;
const log = (entry) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
};
const fail = (message, code = 1) => {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
};

const DEFAULT_HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfakeHostKeyForAidenBotComputerTests0123456789";

const VALUE_OPTIONS = new Set([
  "--storage",
  "--source-storage",
  "--dest-storage",
  "--format",
  "-f",
  "--vnc-password",
  "--shared-dir",
  "--log-file",
  "--timeout",
  "--os",
  "--ipsw",
  "--unattended",
  "--display",
  "--user",
  "--password",
  "--network",
]);

function parse(list) {
  const options = {};
  const flags = new Set();
  const positionals = [];
  for (let index = 0; index < list.length; index += 1) {
    const value = list[index];
    if (VALUE_OPTIONS.has(value)) {
      options[value] = list[index + 1];
      index += 1;
    } else if (value.startsWith("--")) {
      flags.add(value);
    } else {
      positionals.push(value);
      // `ssh` takes the rest after its name as the remote command.
      if (list[0] === "ssh" && positionals.length === 2) {
        positionals.push(...list.slice(index + 1));
        break;
      }
    }
  }
  return { options, flags, positionals };
}

function statePath(storage) {
  return path.join(storage, ".fake-state.json");
}

function readState(storage) {
  try {
    return JSON.parse(readFileSync(statePath(storage), "utf8"));
  } catch {
    return { vms: {} };
  }
}

function writeState(storage, state) {
  mkdirSync(storage, { recursive: true });
  writeFileSync(statePath(storage), JSON.stringify(state, null, 2));
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRunning(vm) {
  return vm.status === "running" && alive(vm.pid);
}

function staleNames() {
  return new Set((process.env.AIDEN_FAKE_LUME_STALE ?? "").split(",").filter(Boolean));
}

/** Swift's JSONEncoder(.prettyPrinted): `"key" : value`, `/` escaped. */
function swiftJson(value) {
  return JSON.stringify(value, null, 2).replace(/": /gu, '" : ').replace(/\//gu, "\\/");
}

function details(storage, name, vm) {
  const running = isRunning(vm);
  const template = JSON.parse(
    readFileSync(path.join(fixtures, running ? "lume-get-running.json" : "lume-get-stopped.json"), "utf8"),
  )[0];
  const stale = staleNames().has(name);
  const host = process.env.AIDEN_FAKE_LUME_VNC_HOST ?? "127.0.0.1";
  return {
    ...template,
    name,
    status: stale ? "provisioning (stale)" : running ? "running" : "stopped",
    provisioningOperation: stale ? "unattended_setup" : null,
    vncUrl: running && !stale ? `vnc://:${vm.vncPassword}@${host}:${vm.port}` : null,
    ipAddress: running && !stale ? vm.ip : null,
    sshAvailable: running && !stale ? true : null,
    locationName: storage,
    macAddress: vm.mac,
  };
}

async function vncChild(storage, name, port) {
  const upstream = Number(process.env.AIDEN_FAKE_LUME_VNC_UPSTREAM ?? "0");
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    if (!(upstream > 0)) {
      socket.end("RFB 003.008\n");
      return;
    }
    // The guest's screen is the test's RFB server; the VM going away drops it, as a stopping VM does.
    const guest = connect({ host: "127.0.0.1", port: upstream });
    guest.on("error", () => socket.destroy());
    guest.on("close", () => socket.destroy());
    socket.on("close", () => guest.destroy());
    socket.pipe(guest);
    guest.pipe(socket);
  });
  await new Promise((resolve) => server.listen(port, process.env.AIDEN_FAKE_LUME_VNC_BIND ?? "127.0.0.1", resolve));
  const state = readState(storage);
  const vm = state.vms[name];
  if (!vm) process.exit(0);
  vm.port = server.address().port;
  vm.pid = process.pid;
  vm.status = "running";
  writeState(storage, state);
  log({ kind: "vnc", name, pid: process.pid, port: vm.port });
  const deadline = Date.now() + 10 * 60_000;
  // Exit once stopped or replaced, or after ten minutes, so no test leaves it
  // behind. Like a real detached VM, it keeps running if its storage is
  // deleted underneath it (macOS keeps the open disk image alive).
  for (;;) {
    await sleep(200);
    if (Date.now() > deadline) break;
    if (!existsSync(statePath(storage))) continue;
    const current = readState(storage).vms[name];
    if (!current || current.pid !== process.pid || current.status !== "running") break;
  }
  server.close();
  process.exit(0);
}

async function main() {
  if (args[0] === "__vnc") {
    await vncChild(args[1], args[2], Number(args[3] ?? 0));
    return;
  }
  const op = args[0];
  const { options, flags, positionals } = parse(args);
  log({
    kind: "cli",
    op,
    args,
    env: {
      LUME_TELEMETRY_ENABLED: process.env.LUME_TELEMETRY_ENABLED,
      LUME_UPDATE_CHECK: process.env.LUME_UPDATE_CHECK,
      HOME: process.env.HOME,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    },
  });
  if (op === "--version") {
    process.stdout.write("0.6.1\n");
    return;
  }
  if (process.env.LUME_TELEMETRY_ENABLED !== "false" || process.env.LUME_UPDATE_CHECK !== "false") {
    fail("fake lume refuses to run with telemetry or update checks on", 70);
  }
  if (["serve", "pull", "update", "push", "ipsw", "setup", "images", "prune"].includes(op)) {
    fail(`fake lume refuses '${op}': Aiden never runs it`, 71);
  }
  let storage;
  if (op === "clone") {
    if (!options["--source-storage"] || !options["--dest-storage"]) fail("clone needs --source-storage and --dest-storage", 72);
    if (options["--source-storage"] !== options["--dest-storage"]) fail("fake lume keeps one storage directory", 72);
    storage = options["--source-storage"];
  } else {
    if (!options["--storage"]) fail(`${op} needs --storage`, 72);
    storage = options["--storage"];
  }
  if (!path.isAbsolute(storage)) fail("storage must be an absolute path", 72);
  const state = readState(storage);

  switch (op) {
    case "create": {
      const [, name] = positionals;
      if (options["--os"] !== "macOS" || options["--unattended"] !== "tahoe") fail("unexpected create options", 74);
      if (!options["--ipsw"] || !existsSync(options["--ipsw"])) fail("restore image not found");
      if (state.vms[name]) fail(`Virtual machine already exists with name: ${name}`);
      // `--unattended` boots the new VM to drive Setup Assistant, so it needs one of
      // the macOS VM places like `run` does (assumed, confirm on the owner Mac).
      const createLimit = Number(process.env.AIDEN_FAKE_LUME_LIMIT ?? "0");
      if (createLimit > 0 && Object.values(state.vms).filter(isRunning).length >= createLimit) {
        process.stderr.write(readFileSync(path.join(fixtures, "lume-error-vm-limit.txt"), "utf8"));
        process.exit(1);
      }
      const count = Object.keys(state.vms).length;
      state.vms[name] = {
        status: "stopped",
        ip: `192.168.64.${10 + count}`,
        mac: `a6:4f:2c:9e:13:${String(10 + count)}`,
        // A fresh install makes its own SSH host key; clones keep their source's.
        hostKey: process.env.AIDEN_FAKE_LUME_HOST_KEY ?? DEFAULT_HOST_KEY,
      };
      mkdirSync(path.join(storage, name), { recursive: true });
      writeFileSync(path.join(storage, name, "disk.img"), "base");
      writeState(storage, state);
      return;
    }
    case "clone": {
      const [, source, target] = positionals;
      const vm = state.vms[source];
      if (!vm) fail(`Virtual machine not found: ${source}`);
      if (isRunning(vm)) fail(`Virtual machine already running: ${source}`);
      if (state.vms[target]) fail(`Virtual machine already exists with name: ${target}`);
      const cloneDelay = Number(process.env.AIDEN_FAKE_LUME_CLONE_DELAY_MS ?? "0");
      if (cloneDelay > 0) {
        await sleep(cloneDelay);
        const copied = readState(storage);
        if (copied.vms[source] && isRunning(copied.vms[source])) fail(`fake lume: ${source} started while its disk was being copied`);
        Object.assign(state, copied);
      }
      const count = Object.keys(state.vms).length;
      state.vms[target] = {
        status: "stopped",
        ip: `192.168.64.${10 + count}`,
        mac: `a6:4f:2c:9e:14:${String(10 + count)}`,
        hostKey: vm.hostKey,
      };
      mkdirSync(path.join(storage, target), { recursive: true });
      writeFileSync(path.join(storage, target, "disk.img"), "clone");
      writeState(storage, state);
      return;
    }
    case "run": {
      const [, name] = positionals;
      const vm = state.vms[name];
      if (!vm) fail(`Virtual machine not found: ${name}`);
      if (!flags.has("--detach") || options["--display"] !== "none") fail("Aiden always runs detached with no display", 75);
      const shared = options["--shared-dir"] ?? "";
      if (!shared.endsWith(":rw") || !path.isAbsolute(shared.slice(0, -3)) || !existsSync(shared.slice(0, -3))) {
        fail("shared directory must be an existing absolute path tagged :rw", 76);
      }
      if (!options["--vnc-password"]) fail("Aiden always sets a VNC password", 77);
      const logFile = options["--log-file"];
      if (isRunning(vm)) fail(`Virtual machine already running: ${name}`);
      const limit = Number(process.env.AIDEN_FAKE_LUME_LIMIT ?? "0");
      const running = Object.values(state.vms).filter(isRunning).length;
      if (limit > 0 && running >= limit) {
        // The real detached child fails after `run` returned; its error lands in the log.
        if (logFile) {
          mkdirSync(path.dirname(logFile), { recursive: true });
          appendFileSync(logFile, readFileSync(path.join(fixtures, "lume-error-vm-limit.txt"), "utf8"));
        }
        process.stdout.write(`Started '${name}' in the background (PID 1).\nLog: ${logFile}\n`);
        return;
      }
      vm.vncPassword = options["--vnc-password"];
      vm.sharedDir = shared;
      vm.status = "starting";
      vm.pid = undefined;
      writeState(storage, state);
      const child = spawn(process.execPath, [self, "__vnc", storage, name, "0"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await sleep(50);
        if (readState(storage).vms[name]?.status === "running") break;
      }
      process.stdout.write(`Started '${name}' in the background (PID ${child.pid}).\nLog: ${logFile}\n`);
      return;
    }
    case "get": {
      if (options["--format"] !== "json") fail("Aiden reads JSON", 78);
      const [, name] = positionals;
      const vm = state.vms[name];
      if (!vm) fail(`Virtual machine not found: ${name}`);
      process.stdout.write(`${swiftJson([details(storage, name, vm)])}\n`);
      return;
    }
    case "ls": {
      if (options["--format"] !== "json") fail("Aiden reads JSON", 78);
      const entries = Object.entries(state.vms)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, vm]) => details(storage, name, vm));
      process.stdout.write(`${swiftJson(entries)}\n`);
      return;
    }
    case "stop": {
      const [, name] = positionals;
      const vm = state.vms[name];
      if (!vm) fail(`Virtual machine not found: ${name}`);
      if (!isRunning(vm)) fail(`Virtual machine not running: ${name}`);
      if ((process.env.AIDEN_FAKE_LUME_STOP_FAILS ?? "").split(",").includes(name)) fail(`Failed to stop virtual machine: ${name}`);
      const stopDelay = Number(process.env.AIDEN_FAKE_LUME_STOP_DELAY_MS ?? "0");
      if (stopDelay > 0) await sleep(stopDelay);
      // Re-read: other Lume calls may have changed the state while this one waited.
      const latest = readState(storage);
      const stopping = latest.vms[name] ?? vm;
      const pid = stopping.pid;
      stopping.status = "stopped";
      stopping.pid = undefined;
      writeState(storage, latest);
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      return;
    }
    case "delete": {
      const [, name] = positionals;
      if (!flags.has("--force")) fail("delete without --force would wait for confirmation", 73);
      const vm = state.vms[name];
      if (!vm) fail(`Virtual machine not found: ${name}`);
      // A running VM holds its resize guard, so Lume refuses to delete it (and
      // `delete` only stops a VM run by its own process, never a detached one).
      if (isRunning(vm)) fail(`Virtual machine already running: ${name}`);
      delete state.vms[name];
      rmSync(path.join(storage, name), { recursive: true, force: true });
      writeState(storage, state);
      return;
    }
    case "ssh": {
      const [, name, ...command] = positionals;
      const vm = state.vms[name];
      log({ kind: "ssh", name, command: command.join(" "), timeout: options["--timeout"] });
      if (!vm) fail(`VM '${name}' not found`);
      if (!isRunning(vm)) fail(`VM '${name}' is not running`);
      if (command.join(" ") === "cat /etc/ssh/ssh_host_ed25519_key.pub") {
        process.stdout.write(`${vm.hostKey ?? DEFAULT_HOST_KEY} root@guest\n`);
      }
      return;
    }
    default:
      fail(`fake lume does not know '${op}'`, 79);
  }
}

await main();
