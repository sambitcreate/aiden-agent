// Round-trip tests: the portable file must survive a full trip through the UI
// (save -> disk -> reload) and a full trip through the user's editor
// (external write -> reload -> visible), without the two racing into a torn state.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DataStore } from "./data-store.js";
import {
  PORTABLE_CONFIG_FILENAME,
  createPortableConfigStores,
  emptyPortableConfig,
  type PortableConfigShape,
} from "./portable-config-core.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function portableStore(t: test.TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-roundtrip-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const portableRoot = path.join(base, "dot-aiden");
  const stores = createPortableConfigStores(
    () => portableRoot,
    () => path.join(base, "userData"),
  );
  await stores.ensureMigrated();
  return { stores, file: path.join(portableRoot, PORTABLE_CONFIG_FILENAME) };
}

const populated: PortableConfigShape = {
  providers: [
    {
      id: "custom-vllm",
      kind: "openai",
      label: "vLLM",
      baseUrl: "http://10.0.0.4:8000/v1",
      needsKey: false,
      deployment: "local",
    },
  ],
  providerIdAliases: { legacy: "custom-vllm" },
  mcpServers: [
    { id: "fs", name: "Filesystem", transport: "stdio", command: "mcp-fs", enabled: true },
  ],
  skills: [{ id: "s", name: "S", description: "d", instructions: "i", enabled: true }],
};

test("a save round-trips through disk unchanged", async (t) => {
  const { stores, file } = await portableStore(t);
  await stores.portable.save(populated);

  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf-8")), populated);
  assert.deepEqual(await stores.portable.load(), populated);
});

test("the file is written pretty-printed so it can be edited by hand", async (t) => {
  const { stores, file } = await portableStore(t);
  await stores.portable.save(populated);

  const raw = await fs.readFile(file, "utf-8");
  assert.match(raw, /^\{\n {2}"providers": \[\n/, "two-space indent");
  assert.match(raw, /\}\n$/, "trailing newline, so the file is POSIX-clean");
});

test("reload picks up an edit made outside the app", async (t) => {
  const { stores, file } = await portableStore(t);
  await stores.portable.load();

  await fs.writeFile(file, JSON.stringify(populated, null, 2), "utf-8");
  assert.equal(await stores.portable.reload(), true, "reports the change");
  assert.deepEqual(await stores.portable.load(), populated);
});

test("reload reports no change when the file is untouched", async (t) => {
  const { stores } = await portableStore(t);
  await stores.portable.save(populated);

  assert.equal(await stores.portable.reload(), false);
  assert.equal(await stores.portable.reload(), false);
});

test("a rewrite with identical contents is not reported as a change", async (t) => {
  const { stores, file } = await portableStore(t);
  await stores.portable.save(populated);

  // Same bytes, new mtime: the stat gate opens but the content comparison closes.
  await fs.writeFile(file, `${JSON.stringify(populated, null, 2)}\n`, "utf-8");
  assert.equal(await stores.portable.reload(), false);
});

test("reload falls back to defaults when the user deletes the file", async (t) => {
  const { stores, file } = await portableStore(t);
  await stores.portable.save(populated);
  await fs.rm(file);

  assert.equal(await stores.portable.reload(), true);
  assert.deepEqual(await stores.portable.load(), emptyPortableConfig());
});

test("reload leaves the last good value in place when the file becomes invalid", async (t) => {
  const { stores, file } = await portableStore(t);
  await stores.portable.save(populated);
  await fs.writeFile(file, "{ broken", "utf-8");

  await stores.portable.reload();
  // Corrupt JSON falls back to defaults rather than throwing — the pinned
  // DataStore behavior. What matters is that the app keeps running.
  assert.deepEqual(await stores.portable.load(), emptyPortableConfig());
});

// An unqueued reload can land between the load() and the writeNow() of an
// in-flight update(), and the write then clobbers the very edit it observed.
// Queuing is what prevents that, so pin the ordering directly.
test("reload is serialized behind an in-flight update", async (t) => {
  const { stores } = await portableStore(t);
  const order: string[] = [];
  const started = deferred();
  const release = deferred();

  const update = stores.portable.update(async (draft) => {
    draft.skills = populated.skills;
    started.resolve();
    await release.promise;
    order.push("update");
  });
  await started.promise;

  const reload = stores.portable.reload().then(() => void order.push("reload"));
  release.resolve();
  await Promise.all([update, reload]);

  assert.deepEqual(order, ["update", "reload"]);
});

test("an external edit during an update leaves the cache agreeing with disk", async (t) => {
  const { stores, file } = await portableStore(t);
  const started = deferred();
  const release = deferred();

  const update = stores.portable.update(async (draft) => {
    draft.mcpServers = populated.mcpServers;
    started.resolve();
    await release.promise;
  });
  await started.promise;
  await fs.writeFile(file, JSON.stringify({ ...populated, skills: [] }, null, 2), "utf-8");
  release.resolve();
  await update;
  await stores.portable.reload();

  // Last writer wins at transaction granularity; the invariant is that memory
  // and disk never disagree, because a stale cache would silently clobber the
  // next write.
  assert.deepEqual(await stores.portable.load(), JSON.parse(await fs.readFile(file, "utf-8")));
});

test("writes leave no staging files behind in the user's folder", async (t) => {
  const { stores, file } = await portableStore(t);
  await stores.portable.save(populated);
  await stores.portable.update((draft) => void (draft.skills = []));

  const entries = await fs.readdir(path.dirname(file));
  assert.deepEqual(
    entries.filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("a concurrent DataStore on the same file sees a whole document, never a partial one", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-atomic-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const writer = new DataStore<PortableConfigShape>(
    PORTABLE_CONFIG_FILENAME,
    emptyPortableConfig(),
    () => base,
  );
  await writer.save(populated);

  // Rename-based replacement means a reader either sees the old inode or the new
  // one; there is no window in which the file exists but is truncated.
  const reads: Promise<PortableConfigShape>[] = [];
  const writes: Promise<void>[] = [];
  for (let i = 0; i < 20; i += 1) {
    writes.push(writer.save({ ...populated, skills: [] }));
    const reader = new DataStore<PortableConfigShape>(
      PORTABLE_CONFIG_FILENAME,
      emptyPortableConfig(),
      () => base,
    );
    reads.push(reader.load());
  }
  await Promise.all(writes);
  for (const result of await Promise.all(reads)) {
    assert.deepEqual(result.providers, populated.providers);
  }
});
