import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DataStore } from "./data-store.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("serializes full config mutations so a delayed write cannot resurrect stale settings", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-data-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DataStore(
    "config.json",
    { settings: { computerUseEnabled: true, appearance: "system" }, providers: ["first"] },
    () => directory,
  );
  await store.save(await store.load());

  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const disable = store.update(async (draft) => {
    draft.settings.computerUseEnabled = false;
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;

  const unrelated = store.update((draft) => {
    draft.settings.appearance = "dark";
    draft.providers.push("second");
  });
  releaseFirst.resolve();
  await Promise.all([disable, unrelated]);

  assert.deepEqual(await store.load(), {
    settings: { computerUseEnabled: false, appearance: "dark" },
    providers: ["first", "second"],
  });
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf-8")),
    await store.load(),
  );
});

test("serialized snapshots hold later writers without publishing a no-op write", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-data-store-guard-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  const store = new DataStore("state.json", { count: 0 }, () => directory);
  await store.save({ count: 1 });
  const before = await fs.readFile(file, "utf8");
  const guardStarted = deferred<void>();
  const releaseGuard = deferred<void>();
  let writerStarted = false;
  const guarded = store.withSerializedSnapshot(async (snapshot) => {
    assert.equal(snapshot.count, 1);
    guardStarted.resolve();
    await releaseGuard.promise;
    return "guarded";
  });
  await guardStarted.promise;
  const writer = store.update((draft) => {
    writerStarted = true;
    draft.count = 2;
  });
  await Promise.resolve();
  assert.equal(writerStarted, false, "the writer stays behind the read guard");
  assert.equal(await fs.readFile(file, "utf8"), before, "the read guard never writes");
  releaseGuard.resolve();
  assert.equal(await guarded, "guarded");
  await writer;
  assert.equal((await store.load()).count, 2);
});
