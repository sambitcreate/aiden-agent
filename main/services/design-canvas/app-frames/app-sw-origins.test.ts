// The device-local list of app origins whose service workers are cleared
// (design mode v2 Phase 3a, S76).

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { APP_SW_ORIGINS_MAX, createAppServiceWorkerOrigins } from "./app-sw-origins.ts";

async function setup(t: test.TestContext, options: { failFor?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "aiden-sw-origins-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "design", "app-sw-origins.json");
  const cleared: string[] = [];
  const logs: string[] = [];
  const origins = createAppServiceWorkerOrigins({
    file,
    session: {
      clearStorageData: async (request) => {
        assert.deepEqual(request.storages, ["serviceworkers"]);
        if (request.origin === options.failFor) throw new Error("gone");
        cleared.push(request.origin);
      },
    },
    log: (event) => logs.push(event),
  });
  return { file, origins, cleared, logs };
}

test("remember keeps loopback origins only, canonical and without paths, newest last", async (t) => {
  const s = await setup(t);
  await s.origins.remember("http://127.0.0.1:5173/pricing?x=1");
  await s.origins.remember("http://[::1]:3000");
  await s.origins.remember("https://example.com");
  await s.origins.remember("file:///etc/passwd");
  await s.origins.remember("not a url");
  await s.origins.remember("http://127.0.0.1:5173");
  assert.deepEqual(await s.origins.list(), ["http://[::1]:3000", "http://127.0.0.1:5173"]);
  assert.deepEqual(JSON.parse(await readFile(s.file, "utf8")), { origins: ["http://[::1]:3000", "http://127.0.0.1:5173"] });
});

test("a loopback page on the default port is remembered and cleared, written with or without :80", async (t) => {
  const s = await setup(t);
  await s.origins.remember("http://localhost/");
  await s.origins.remember("http://127.0.0.1:80/index.html");
  await s.origins.remember("http://[::1]/");
  assert.deepEqual(await s.origins.list(), ["http://localhost", "http://127.0.0.1", "http://[::1]"]);
  await s.origins.remember("http://localhost:80");
  assert.deepEqual(await s.origins.list(), ["http://127.0.0.1", "http://[::1]", "http://localhost"], "the same origin, so it isn't listed twice");
  await s.origins.clear();
  assert.deepEqual(s.cleared, ["http://127.0.0.1", "http://[::1]", "http://localhost"]);
  assert.deepEqual(await s.origins.list(), []);
});

test(`past ${APP_SW_ORIGINS_MAX} origins, the oldest are cleared before they are dropped; one that fails to clear stays for the next try`, async (t) => {
  const s = await setup(t, { failFor: "http://127.0.0.1:5001" });
  for (let port = 5000; port < 5000 + APP_SW_ORIGINS_MAX + 3; port++) await s.origins.remember(`http://127.0.0.1:${port}`);
  assert.deepEqual(s.cleared, ["http://127.0.0.1:5000", "http://127.0.0.1:5002"], "evicted origins are cleared first");
  const list = await s.origins.list();
  assert.equal(list[0], "http://127.0.0.1:5001", "the one that failed is still listed");
  assert.equal(list.includes("http://127.0.0.1:5000"), false);
  assert.equal(list.length, APP_SW_ORIGINS_MAX + 1);
  await s.origins.clear();
  assert.equal(s.cleared.length, 2 + APP_SW_ORIGINS_MAX, "the next clear covers every origin except the one that fails again");
  assert.deepEqual(await s.origins.list(), ["http://127.0.0.1:5001"]);
});

test(`past ${APP_SW_ORIGINS_MAX} origins, one still owned is never evicted: the oldest unowned goes, and with every origin owned the list grows`, async (t) => {
  const s = await setup(t);
  const at = (port: number) => `http://127.0.0.1:${port}`;
  const owned = new Set([at(5000)]);
  const keep = (origin: string) => owned.has(origin);
  for (let port = 5000; port < 5000 + APP_SW_ORIGINS_MAX; port++) await s.origins.remember(at(port), keep);
  await s.origins.remember(at(5000 + APP_SW_ORIGINS_MAX), keep);
  assert.deepEqual(s.cleared, [at(5001)], "the oldest origin is still owned, so the next oldest is evicted");
  const list = await s.origins.list();
  assert.equal(list.includes(at(5000)), true);
  assert.equal(list.length, APP_SW_ORIGINS_MAX);

  for (const origin of list) owned.add(origin);
  owned.add(at(6000));
  await s.origins.remember(at(6000), keep);
  assert.deepEqual(s.cleared, [at(5001)], "with every origin owned, nothing is evicted");
  assert.equal((await s.origins.list()).length, APP_SW_ORIGINS_MAX + 1, "the bound is soft");
});

test("an eviction is a clear like any other: whenCleared covers it while it runs", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiden-sw-evict-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const clearing = new Promise<void>((resolve) => (started = resolve));
  const origins = createAppServiceWorkerOrigins({
    file: path.join(dir, "origins.json"),
    session: {
      clearStorageData: async () => {
        started();
        await hold;
      },
    },
  });
  const at = (port: number) => `http://127.0.0.1:${port}`;
  for (let port = 5000; port < 5000 + APP_SW_ORIGINS_MAX; port++) await origins.remember(at(port));
  const adding = origins.remember(at(5000 + APP_SW_ORIGINS_MAX));
  await clearing;
  const evicted = origins.whenCleared(at(5000));
  assert.notEqual(evicted, null, "the evicted origin's clear is pending");
  assert.equal(origins.whenCleared(at(5001)), null, "the others aren't being cleared");
  release();
  assert.equal(await evicted, true);
  await adding;
  assert.equal((await origins.list()).includes(at(5000)), false);
});

test("clear clears each origin's service workers and empties the list; a subset clears only those", async (t) => {
  const s = await setup(t);
  await s.origins.remember("http://127.0.0.1:5173");
  await s.origins.remember("http://127.0.0.1:5174");
  await s.origins.remember("http://127.0.0.1:5175");
  await s.origins.clear(["http://127.0.0.1:5174", "http://127.0.0.1:9999"]);
  assert.deepEqual(s.cleared, ["http://127.0.0.1:5174"]);
  assert.deepEqual(await s.origins.list(), ["http://127.0.0.1:5173", "http://127.0.0.1:5175"]);
  await s.origins.clear();
  assert.deepEqual(s.cleared, ["http://127.0.0.1:5174", "http://127.0.0.1:5173", "http://127.0.0.1:5175"]);
  assert.deepEqual(await s.origins.list(), []);
});

test("one origin failing to clear doesn't stop the rest, and it stays listed so the next clear tries again", async (t) => {
  const s = await setup(t, { failFor: "http://127.0.0.1:5173" });
  await s.origins.remember("http://127.0.0.1:5173");
  await s.origins.remember("http://127.0.0.1:5174");
  await s.origins.clear();
  assert.deepEqual(s.cleared, ["http://127.0.0.1:5174"]);
  assert.deepEqual(s.logs, ["design-live-sw-clear-failed"]);
  assert.deepEqual(await s.origins.list(), ["http://127.0.0.1:5173"]);
  await s.origins.clear(["http://127.0.0.1:5173"]);
  assert.deepEqual(s.logs, ["design-live-sw-clear-failed", "design-live-sw-clear-failed"], "tried again");
});

test("clear asks whether to keep each origin when it gets to it: one kept, or claimed while its own clear ran, stays listed", async (t) => {
  const s = await setup(t);
  for (const port of [5001, 5002, 5003]) await s.origins.remember(`http://127.0.0.1:${port}`);
  const owned = new Set<string>();
  // 5002 is claimed while 5001 is being cleared; 5003 is claimed while its own clear runs.
  const keep = (origin: string) => {
    if (s.cleared.includes("http://127.0.0.1:5001")) owned.add("http://127.0.0.1:5002");
    if (s.cleared.includes("http://127.0.0.1:5003")) owned.add("http://127.0.0.1:5003");
    return owned.has(origin);
  };
  await s.origins.clear(undefined, keep);
  assert.deepEqual(s.cleared, ["http://127.0.0.1:5001", "http://127.0.0.1:5003"], "5002 was claimed before its turn, so it isn't cleared");
  assert.deepEqual(await s.origins.list(), ["http://127.0.0.1:5002", "http://127.0.0.1:5003"], "both claimed origins stay for their owner's end");
});

test("a corrupt file clears nothing and is reset", async (t) => {
  const s = await setup(t);
  await s.origins.remember("http://127.0.0.1:5173");
  await writeFile(s.file, "{not json");
  await s.origins.clear();
  assert.deepEqual(s.cleared, []);
  assert.deepEqual(JSON.parse(await readFile(s.file, "utf8")), { origins: [] });
});

test("a missing file is an empty list and clearing it writes nothing", async (t) => {
  const s = await setup(t);
  await s.origins.clear();
  assert.deepEqual(s.cleared, []);
  await assert.rejects(readFile(s.file, "utf8"), { code: "ENOENT" });
});

test("remember and clear run in order, so a clear queued first never wipes a later admission", async (t) => {
  const s = await setup(t);
  await s.origins.remember("http://127.0.0.1:5173");
  const clearing = s.origins.clear();
  const remembering = s.origins.remember("http://127.0.0.1:5174");
  await Promise.all([clearing, remembering]);
  assert.deepEqual(s.cleared, ["http://127.0.0.1:5173"]);
  assert.deepEqual(await s.origins.list(), ["http://127.0.0.1:5174"]);
});
