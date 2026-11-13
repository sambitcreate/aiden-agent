import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPrivateSession } from "./private-session.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test("private browsing cycles reuse one session and remove the prior cycle's state", async () => {
  let created = 0;
  const cookies = new Map<string, string>();
  const cache = new Set<string>();
  const sessions = new BrowserPrivateSession(() => {
    created++;
    return {
      cookies,
      cache,
      clearStorageData: async () => { cookies.clear(); },
      clearCache: async () => { cache.clear(); },
    };
  });
  let original: unknown;
  for (let cycle = 0; cycle < 5; cycle++) {
    await sessions.open((session) => {
      original ??= session;
      assert.equal(session, original);
      assert.equal(session.cookies.size, 0);
      assert.equal(session.cache.size, 0);
      session.cookies.set("login", `cycle-${cycle}`);
      session.cache.add("private-response");
    });
    sessions.clear();
  }
  await sessions.open(() => {});
  assert.equal(created, 1);
});

test("opening waits for both private storage and cache cleanup", async () => {
  const storage = deferred();
  const cache = deferred();
  const cleanupStarted = deferred();
  const sessions = new BrowserPrivateSession(() => ({
    clearStorageData: () => { cleanupStarted.resolve(); return storage.promise; },
    clearCache: () => cache.promise,
  }));
  await sessions.open(() => {});
  sessions.clear();
  await cleanupStarted.promise;
  let opened = false;
  const opening = sessions.open(() => { opened = true; });
  storage.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(opened, false);
  cache.resolve();
  await opening;
  assert.equal(opened, true);
});

test("cleanup failure refuses reuse after both cleanup operations settle", async () => {
  const cache = deferred();
  let fail = true;
  const sessions = new BrowserPrivateSession(() => ({
    clearStorageData: async () => { if (fail) throw new Error("storage cleanup failed"); },
    clearCache: () => cache.promise,
  }));
  await sessions.open(() => {});
  sessions.clear();
  let settled = false;
  const opening = sessions.open(() => assert.fail("dirty session opened"));
  const rejected = assert.rejects(opening, /storage cleanup failed/).then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  cache.resolve();
  await rejected;
  fail = false;
  sessions.clear();
  assert.equal(await sessions.open(() => "clean"), "clean");
});

test("a last-close cleanup that starts while opening waits is also awaited", async () => {
  const storage = deferred();
  const sessions = new BrowserPrivateSession(() => ({
    clearStorageData: () => storage.promise,
    clearCache: async () => {},
  }));
  await sessions.open(() => {});
  let opened = false;
  const opening = sessions.open(() => { opened = true; });
  sessions.clear();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(opened, false);
  storage.resolve();
  await opening;
  assert.equal(opened, true);
});
