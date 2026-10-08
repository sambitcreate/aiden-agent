import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runToolMaintenance } from "./device-tool-maintenance.js";

const HUB = { name: "expo-device-hub", version: "0.12.0" };
const AGENT = { name: "agent-device", version: "0.21.12" };

async function install(root: string, name: string, version: string, ageSeconds = 0): Promise<string> {
  const directory = path.join(root, name, version);
  await mkdir(path.join(directory, "node_modules", name), { recursive: true });
  const sentinel = path.join(directory, ".install-complete");
  await writeFile(sentinel, `${version}\n`);
  if (ageSeconds) {
    const time = new Date(Date.now() - ageSeconds * 1000);
    await utimes(sentinel, time, time);
  }
  return directory;
}

async function versions(root: string, name: string): Promise<string[]> {
  return (await readdir(path.join(root, name)).catch(() => [])).filter((entry) => !entry.startsWith(".")).sort();
}

async function toolsRoot(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), "aiden-tool-maintenance-")), "tools");
}

const run = (root: string, policy: "prune" | "reclaim", specs = [HUB, AGENT]) =>
  runToolMaintenance({ nodePath: process.execPath, toolsRoot: root, specs, policy });

test("an explicit prune removes every unpinned completed install and leaves partial ones alone", async () => {
  const root = await toolsRoot();
  await install(root, HUB.name, "0.10.0");
  await install(root, HUB.name, "0.11.0");
  await install(root, HUB.name, HUB.version);
  await install(root, AGENT.name, "0.20.0");
  // No sentinel: an install in progress or abandoned by a crash is not a completed version.
  await mkdir(path.join(root, HUB.name, "0.9.0"), { recursive: true });
  const removed = await run(root, "prune");
  assert.deepEqual(removed.sort(), ["agent-device@0.20.0", "expo-device-hub@0.10.0", "expo-device-hub@0.11.0"]);
  assert.deepEqual(await versions(root, HUB.name), ["0.12.0", "0.9.0"]);
  assert.deepEqual(await versions(root, AGENT.name), []);
});

test("an automatic reclaim keeps the newest previous install and waits for the pinned one", async () => {
  const root = await toolsRoot();
  await install(root, HUB.name, "0.10.0", 300);
  await install(root, HUB.name, "0.11.0", 60);
  assert.deepEqual(await run(root, "reclaim", [HUB]), [], "nothing is reclaimed before the pinned install completes");
  await install(root, HUB.name, HUB.version);
  assert.deepEqual(await run(root, "reclaim", [HUB]), ["expo-device-hub@0.10.0"]);
  assert.deepEqual(await versions(root, HUB.name), ["0.11.0", "0.12.0"]);
});

test("a version a running process was started from is never removed", async (t) => {
  const root = await toolsRoot();
  const inUse = await install(root, AGENT.name, "0.20.0");
  await install(root, AGENT.name, "0.19.0");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", path.join(inUse, "bin", "agent.mjs")], {
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve) => child.once("spawn", resolve));
  assert.deepEqual(await run(root, "prune", [AGENT]), ["agent-device@0.19.0"]);
  assert.deepEqual(await versions(root, AGENT.name), ["0.20.0"]);
});

test("maintenance runs one at a time and recovers a lock left by a dead process", async () => {
  const root = await toolsRoot();
  await install(root, HUB.name, "0.11.0");
  await install(root, HUB.name, HUB.version);
  // A crashed holder: a published lock directory whose owner pid no longer exists.
  const lock = path.join(root, ".maintenance-lock");
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, "999999.dead.json"), JSON.stringify({ pid: 999_999 }));
  const results = await Promise.all([run(root, "prune", [HUB]), run(root, "prune", [HUB])]);
  assert.deepEqual(results.flat(), ["expo-device-hub@0.11.0"], "exactly one run removes the old version");
  assert.deepEqual((await readdir(root)).filter((entry) => entry.startsWith(".maintenance-lock")), []);
  await rm(path.dirname(root), { recursive: true, force: true });
});
