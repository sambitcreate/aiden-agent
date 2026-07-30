import assert from "node:assert/strict";
import test from "node:test";
import {
  createLastSafeSnapshotReload,
  createLastSafeSnapshotTracker,
  createPortableConfigWatcher,
} from "./portable-config-watch-core.js";
import {
  mutatePortableConfigAndSync,
  setPortableCredentialSnapshotListener,
  syncPortableCredentialSnapshot,
} from "./portable-credential-snapshot.js";

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

test("unsafe reloads cannot replace the last successfully reconciled snapshot", () => {
  const tracker = createLastSafeSnapshotTracker<{ endpoint: string }>();
  const endpointA = { endpoint: "https://a.example" };
  const unsafeDefaults = { endpoint: "defaults" };
  const endpointB = { endpoint: "https://b.example" };

  tracker.seed(endpointA, true);
  assert.deepEqual(tracker.afterReload(unsafeDefaults, false, true), {
    comparison: null,
    shouldNotify: false,
  });
  assert.deepEqual(tracker.afterReload(endpointB, true, true), {
    comparison: { previous: endpointA, current: endpointB },
    shouldNotify: true,
  });
});

test("a repaired file retries reconciliation until its exact transition commits", () => {
  const tracker = createLastSafeSnapshotTracker<{ endpoint: string }>();
  const endpointA = { endpoint: "https://a.example" };
  const repairedDefaults = { endpoint: "defaults" };

  tracker.seed(endpointA, true);
  tracker.afterReload(null, false, true);
  assert.deepEqual(
    tracker.afterReload(repairedDefaults, true, false),
    {
      comparison: { previous: endpointA, current: repairedDefaults },
      shouldNotify: true,
    },
    "a repair equal to the unsafe projection still reconciles",
  );
  assert.deepEqual(
    tracker.afterReload(repairedDefaults, true, false),
    {
      comparison: { previous: endpointA, current: repairedDefaults },
      shouldNotify: true,
    },
    "a failed side effect remains pending",
  );

  tracker.commit(repairedDefaults);
  assert.deepEqual(tracker.afterReload(repairedDefaults, true, false), {
    comparison: null,
    shouldNotify: false,
  });
});

test("the composed reload reconciles the cached before-state with one disk change", async () => {
  type Snapshot = { endpoint: string };
  let cache: Snapshot = { endpoint: "https://a.example" };
  let disk = structuredClone(cache);
  let safe = true;
  const reconciled: Array<{ previous: Snapshot; current: Snapshot }> = [];
  const reload = createLastSafeSnapshotReload(
    async () => safe,
    async () => structuredClone(cache),
    async () => {
      const changed = JSON.stringify(cache) !== JSON.stringify(disk);
      cache = structuredClone(disk);
      return changed;
    },
    async (previous, current) => void reconciled.push({ previous, current }),
  );

  disk = { endpoint: "https://b.example" };
  assert.equal(await reload(), true);
  assert.deepEqual(reconciled, [
    {
      previous: { endpoint: "https://a.example" },
      current: { endpoint: "https://b.example" },
    },
  ]);
  assert.equal(await reload(), false);
  assert.equal(reconciled.length, 1);

  safe = false;
  disk = { endpoint: "unsafe-defaults" };
  assert.equal(await reload(), false);
  safe = true;
  disk = { endpoint: "https://c.example" };
  assert.equal(await reload(), true);
  assert.deepEqual(reconciled[reconciled.length - 1], {
    previous: { endpoint: "https://b.example" },
    current: { endpoint: "https://c.example" },
  });
});

test("an app-authored mutation reconciles before advancing the baseline", async () => {
  type Snapshot = { servers: string[] };
  let cache: Snapshot = { servers: [] };
  let disk = structuredClone(cache);
  const reconciled: Array<{ previous: Snapshot; current: Snapshot }> = [];
  const reload = createLastSafeSnapshotReload(
    async () => true,
    async () => structuredClone(cache),
    async () => {
      const changed = JSON.stringify(cache) !== JSON.stringify(disk);
      cache = structuredClone(disk);
      return changed;
    },
    async (previous, current) => void reconciled.push({ previous, current }),
  );

  assert.equal(await reload(), false);
  cache = { servers: ["added-in-settings"] };
  disk = structuredClone(cache);
  await reload.syncCurrent();
  assert.deepEqual(reconciled, [
    {
      previous: { servers: [] },
      current: { servers: ["added-in-settings"] },
    },
  ]);

  disk = { servers: [] };
  assert.equal(await reload(), true);
  assert.deepEqual(reconciled, [
    {
      previous: { servers: [] },
      current: { servers: ["added-in-settings"] },
    },
    {
      previous: { servers: ["added-in-settings"] },
      current: { servers: [] },
    },
  ]);
});

test("snapshot sync reconciles an unrelated external edit already absorbed by a mutation", async () => {
  type Snapshot = { providerLabel: string; mcpEndpoint: string };
  let cache: Snapshot = { providerLabel: "A", mcpEndpoint: "https://mcp-a.example" };
  const reconciled: Array<{ previous: Snapshot; current: Snapshot }> = [];
  const reload = createLastSafeSnapshotReload(
    async () => true,
    async () => structuredClone(cache),
    async () => false,
    async (previous, current) => void reconciled.push({ previous, current }),
  );

  assert.equal(await reload(), false);
  // A provider save reloads disk after an external MCP edit, then publishes its
  // own unrelated field before asking the watcher to advance its baseline.
  cache = { providerLabel: "B", mcpEndpoint: "https://mcp-b.example" };
  await reload.syncCurrent();

  assert.deepEqual(reconciled, [
    {
      previous: { providerLabel: "A", mcpEndpoint: "https://mcp-a.example" },
      current: { providerLabel: "B", mcpEndpoint: "https://mcp-b.example" },
    },
  ]);
});

test("a snapshot absorbed during reconciliation is reconciled before the baseline advances", async () => {
  type Snapshot = { servers: string[] };
  let cache: Snapshot = { servers: ["A"] };
  let disk = structuredClone(cache);
  const disconnected: string[] = [];
  const transitions: Array<{ previous: Snapshot; current: Snapshot }> = [];
  let absorbLateEdit = true;
  const reload = createLastSafeSnapshotReload(
    async () => true,
    async () => structuredClone(cache),
    async () => {
      const changed = JSON.stringify(cache) !== JSON.stringify(disk);
      cache = structuredClone(disk);
      return changed;
    },
    async (previous, current) => {
      transitions.push({ previous: structuredClone(previous), current: structuredClone(current) });
      for (const server of previous.servers) {
        if (!current.servers.includes(server)) disconnected.push(server);
      }
      if (absorbLateEdit) {
        absorbLateEdit = false;
        // Model pending-journal recovery reloading a later MCP edit while the
        // watcher is reconciling the snapshot it originally selected.
        cache = { servers: ["C"] };
        disk = structuredClone(cache);
      }
    },
  );

  assert.equal(await reload(), false);
  disk = { servers: ["B"] };
  assert.equal(await reload(), true);
  assert.deepEqual(transitions, [
    { previous: { servers: ["A"] }, current: { servers: ["B"] } },
    { previous: { servers: ["B"] }, current: { servers: ["C"] } },
  ]);
  assert.deepEqual(disconnected, ["A", "B"]);

  assert.equal(await reload(), false, "the absorbed late edit becomes the committed baseline");
  assert.equal(transitions.length, 2);
  disk = { servers: [] };
  assert.equal(await reload(), true);
  assert.deepEqual(disconnected, ["A", "B", "C"]);
});

test("portable credential snapshot notifications await the installed listener", async () => {
  const gate = deferred();
  let completed = false;
  setPortableCredentialSnapshotListener(async () => {
    await gate.promise;
    completed = true;
  });

  const sync = syncPortableCredentialSnapshot();
  await Promise.resolve();
  assert.equal(completed, false);
  gate.resolve();
  await sync;
  assert.equal(completed, true);
});

test("portable mutation sync releases an inner credential queue before reconciliation", async () => {
  let innerTail: Promise<void> = Promise.resolve();
  const events: string[] = [];
  function inner<R>(operation: () => Promise<R>): Promise<R> {
    const result = innerTail.then(operation, operation);
    innerTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  setPortableCredentialSnapshotListener(() =>
    inner(async () => {
      events.push("reconciled");
    }),
  );

  const completed = mutatePortableConfigAndSync(() =>
    inner(async () => {
      events.push("mutated");
      return "saved";
    }),
  );
  const result = await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("portable mutation self-deadlocked")), 1_000),
    ),
  ]);

  assert.equal(result, "saved");
  assert.deepEqual(events, ["reconciled", "mutated", "reconciled"]);
});

test("the first portable mutation seeds its baseline before absorbing an external edit", async () => {
  type Snapshot = { endpoint: string };
  let cache: Snapshot = { endpoint: "https://a.example" };
  const transitions: Array<{ previous: Snapshot; current: Snapshot }> = [];
  const reload = createLastSafeSnapshotReload(
    async () => true,
    async () => structuredClone(cache),
    async () => false,
    async (previous, current) =>
      void transitions.push({
        previous: structuredClone(previous),
        current: structuredClone(current),
      }),
  );
  setPortableCredentialSnapshotListener(() => reload.syncCurrent());

  await mutatePortableConfigAndSync(async () => {
    // Model the first Settings write reloading an external endpoint edit before
    // publishing its own field.
    cache = { endpoint: "https://b.example" };
  });

  assert.deepEqual(transitions, [
    {
      previous: { endpoint: "https://a.example" },
      current: { endpoint: "https://b.example" },
    },
  ]);
});
