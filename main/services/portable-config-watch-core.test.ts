import assert from "node:assert/strict";
import test from "node:test";
import { createPortableConfigWatcher } from "./portable-config-watch-core.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a changed file notifies the renderer exactly once", async () => {
  let changes = 0;
  const watcher = createPortableConfigWatcher(
    async () => true,
    () => void (changes += 1),
    (error) => assert.fail(String(error)),
  );

  await watcher.refresh();
  assert.equal(changes, 1);
});

// Window focus fires this constantly, so an unchanged file must cost the
// renderer nothing.
test("an unchanged file does not notify the renderer", async () => {
  let changes = 0;
  const watcher = createPortableConfigWatcher(
    async () => false,
    () => void (changes += 1),
    (error) => assert.fail(String(error)),
  );

  await watcher.refresh();
  await watcher.refresh();
  assert.equal(changes, 0);
});

test("concurrent refreshes coalesce into one re-read", async () => {
  let reloads = 0;
  const gate = deferred();
  const watcher = createPortableConfigWatcher(
    async () => {
      reloads += 1;
      await gate.promise;
      return true;
    },
    () => undefined,
    (error) => assert.fail(String(error)),
  );

  const first = watcher.refresh();
  const second = watcher.refresh();
  const third = watcher.refresh();
  assert.equal(reloads, 1, "focus storms must not queue a re-read each");
  gate.resolve();
  await Promise.all([first, second, third]);
  assert.equal(reloads, 1);
});

test("a refresh after the previous one settles starts a fresh re-read", async () => {
  let reloads = 0;
  const watcher = createPortableConfigWatcher(
    async () => {
      reloads += 1;
      return true;
    },
    () => undefined,
    (error) => assert.fail(String(error)),
  );

  await watcher.refresh();
  await watcher.refresh();
  assert.equal(reloads, 2, "coalescing must not latch the slot shut");
});

test("a failed re-read is reported and does not reject the caller", async () => {
  const failure = new Error("EACCES");
  const seen: unknown[] = [];
  const watcher = createPortableConfigWatcher(
    () => Promise.reject(failure),
    () => assert.fail("must not announce a change it never observed"),
    (error) => void seen.push(error),
  );

  await watcher.refresh();
  assert.deepEqual(seen, [failure]);
});

test("a failure does not wedge later refreshes", async () => {
  let attempt = 0;
  let changes = 0;
  const watcher = createPortableConfigWatcher(
    () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error("transient")) : Promise.resolve(true);
    },
    () => void (changes += 1),
    () => undefined,
  );

  await watcher.refresh();
  await watcher.refresh();
  assert.equal(changes, 1);
});
