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
