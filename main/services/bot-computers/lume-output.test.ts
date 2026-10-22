import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { classifyLumeError, isLoopbackHost, parseLumeVmInfo, parseLumeVmList } from "./lume-output.js";

const fixture = (name: string) => readFileSync(path.resolve("main/services/bot-computers/fixtures", name), "utf8");

test("a running VM reports its IP and loopback VNC endpoint, never its password", () => {
  const info = parseLumeVmInfo(fixture("lume-get-running.json"));
  assert.deepEqual(info, {
    name: "aiden-bot-5d41402abc4b2a76",
    state: "running",
    ip: "192.168.64.7",
    sshAvailable: true,
    vnc: { host: "127.0.0.1", port: 62295 },
    diskAllocatedBytes: 31_138_512_896,
  });
  assert.equal(JSON.stringify(info).includes("Zq7Tn2"), false);
});

test("a stopped VM has no address or screen", () => {
  assert.deepEqual(parseLumeVmInfo(fixture("lume-get-stopped.json")), {
    name: "aiden-bot-5d41402abc4b2a76",
    state: "stopped",
    diskAllocatedBytes: 31_138_512_896,
  });
});

test("ls lists every VM and marks an interrupted create as stale", () => {
  const list = parseLumeVmList(fixture("lume-ls.json"));
  assert.deepEqual(
    list.map(({ name, state, stale }) => ({ name, state, stale: stale ?? false })),
    [
      { name: "aiden-base", state: "stopped", stale: false },
      { name: "aiden-bot-5d41402abc4b2a76", state: "running", stale: false },
      { name: "aiden-bot-7d793037a0760186", state: "provisioning", stale: true },
    ],
  );
});

test("log lines Lume prints to stdout before the JSON are skipped", () => {
  const noisy = `[2026-10-21T09:14:03Z] ERROR: Failed to get disk size name=aiden-base error=x\n${fixture("lume-get-stopped.json")}`;
  assert.equal(parseLumeVmInfo(noisy).state, "stopped");
  assert.deepEqual(parseLumeVmList("No virtual machines found in storage '/tmp/vms'\n"), []);
  assert.throws(() => parseLumeVmInfo("not json"), /can't read/u);
});

test("errors map to the VM limit, a missing VM, a stale VM, or a stopped one", () => {
  assert.equal(classifyLumeError(fixture("lume-error-vm-limit.txt"), 1), "vm_limit");
  assert.equal(classifyLumeError(fixture("lume-error-not-found.txt"), 1), "not_found");
  assert.equal(classifyLumeError("Error: VM 'aiden-base' not found\n", 1), "not_found");
  assert.equal(classifyLumeError("Error: Virtual machine is still being provisioned: aiden-base\n", 1), "stale");
  assert.equal(classifyLumeError("Error: Virtual machine not running: aiden-base\n", 1), "not_running");
  assert.equal(classifyLumeError("Error: Disk full\n", 1), "other");
  assert.equal(classifyLumeError(fixture("lume-error-vm-limit.txt"), 0), "other");
});

test("only loopback hosts count as private (G22)", () => {
  for (const host of ["127.0.0.1", "::1", "[::1]", "localhost"]) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ["192.168.1.20", "0.0.0.0", "10.0.0.5", "fe80::1"]) assert.equal(isLoopbackHost(host), false, host);
});
