// Resilience / corruption-recovery tests for the on-disk stores.
//
// These PIN current behavior: a corrupt or missing JSON file silently falls
// back to the default value rather than throwing or crashing the app. This is
// the regression sentinel that makes a future schema-version / migration change
// safe to introduce and review — if the fallback semantics change, these tests
// must change in lockstep.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  DataStore,
  DataStoreCorruptWriteError,
  DataStoreExternalChangeError,
  DataStoreUnsafeWriteError,
} from "./data-store.js";
import { createChatStore } from "./chat-store-core.js";

async function tmpDir(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// ── DataStore ───────────────────────────────────────────────────────────────

test("DataStore.load returns the default value when the file is missing", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-missing-");
  const store = new DataStore("absent.json", { count: 0 }, () => dir);
  assert.deepEqual(await store.load(), { count: 0 });
});

test("DataStore.load returns the default value when the file is corrupt JSON", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-corrupt-");
  await fs.writeFile(path.join(dir, "config.json"), "{not valid json", "utf-8");
  const store = new DataStore("config.json", { count: 99 }, () => dir);
  assert.deepEqual(await store.load(), { count: 99 });
  assert.equal(await store.loadedFromCorruptFile(), true);
});

test("DataStore rejects invalid UTF-8 without rewriting the original bytes", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-invalid-utf8-");
  const file = path.join(dir, "config.json");
  const invalid = Buffer.from([
    ...Buffer.from('{"value":"', "utf-8"),
    0xff,
    ...Buffer.from('"}', "utf-8"),
  ]);
  await fs.writeFile(file, invalid);
  const store = new DataStore("config.json", { value: "default" }, () => dir, {
    preserveCorruptFile: true,
    reloadBeforeWrite: true,
    rejectCorruptWrite: true,
    rejectExternalChanges: true,
  });

  assert.deepEqual(await store.load(), { value: "default" });
  assert.equal(await store.loadedFromCorruptFile(), true);
  await assert.rejects(
    store.update((draft) => void (draft.value = "replacement")),
    DataStoreCorruptWriteError,
  );
  assert.equal((await fs.readFile(file)).equals(invalid), true);
});

test("DataStore normalizes valid JSON with the wrong runtime shape", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-normalize-");
  await fs.writeFile(path.join(dir, "config.json"), "null", "utf-8");
  const store = new DataStore("config.json", { count: 0 }, () => dir, {
    normalize: (value) =>
      value && typeof value === "object" ? (value as { count: number }) : { count: 7 },
  });

  assert.deepEqual(await store.load(), { count: 7 });
  assert.equal(await store.loadedFromCorruptFile(), false);
});

test("DataStore exposes valid-but-unsafe normalization state until a safe save", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-unsafe-");
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ count: "bad" }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    normalize: (value) =>
      value && typeof value === "object" && typeof (value as { count?: unknown }).count === "number"
        ? (value as { count: number })
        : { count: 7 },
    isSafe: (value) =>
      Boolean(
        value &&
        typeof value === "object" &&
        typeof (value as { count?: unknown }).count === "number",
      ),
  });

  assert.deepEqual(await store.load(), { count: 7 });
  assert.equal(await store.loadedFromUnsafeFile(), true);
  await store.save({ count: 8 });
  assert.equal(await store.loadedFromUnsafeFile(), false);
});

test("DataStore can make valid-but-unsafe files permanently read-only", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-reject-unsafe-");
  const target = path.join(dir, "config.json");
  const original = JSON.stringify({ count: "future-value" });
  await fs.writeFile(target, original, "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    normalize: () => ({ count: 7 }),
    isSafe: () => false,
    reloadBeforeWrite: true,
    rejectUnsafeWrite: true,
  });

  await assert.rejects(() => store.update((draft) => void (draft.count = 8)), {
    name: DataStoreUnsafeWriteError.name,
  });
  assert.equal(await fs.readFile(target, "utf-8"), original);
});

test("DataStore rejects a proposed write that violates its safety schema", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-proposed-unsafe-");
  const target = path.join(dir, "config.json");
  await fs.writeFile(target, JSON.stringify({ count: 1 }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    isSafe: (value) =>
      Boolean(
        value &&
        typeof value === "object" &&
        typeof (value as { count?: unknown }).count === "number" &&
        (value as { count: number }).count <= 10,
      ),
  });

  await assert.rejects(() => store.save({ count: 11 }), DataStoreUnsafeWriteError);
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { count: 1 });
});

test("DataStore refuses a regular file above its configured read ceiling", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-oversized-");
  const target = path.join(dir, "config.json");
  await fs.writeFile(target, JSON.stringify({ value: "x".repeat(128) }), "utf8");
  const store = new DataStore("config.json", { value: "default" }, () => dir, {
    maxBytes: 64,
  });

  assert.deepEqual(await store.load(), { value: "default" });
  assert.equal(await store.loadedFromCorruptFile(), true);
});

test("DataStore rejects JSON escaping that expands a write above its byte ceiling", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-expanded-write-");
  const target = path.join(dir, "config.json");
  await fs.writeFile(target, JSON.stringify({ value: "safe" }), "utf8");
  const store = new DataStore("config.json", { value: "default" }, () => dir, {
    maxBytes: 64,
  });

  await assert.rejects(
    () => store.save({ value: "\0".repeat(20) }),
    DataStoreUnsafeWriteError,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { value: "safe" });
});

test("DataStore.load caches: a second load does not re-read disk", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-cache-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ count: 7 }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);

  const first = await store.load();
  assert.equal(first.count, 7);
  // Mutate the file after the first load; the cached value must win.
  await fs.writeFile(file, JSON.stringify({ count: 999 }), "utf-8");
  const second = await store.load();
  assert.equal(second.count, 7);
});

// The companion to the pin above: load() never re-reads, so reload() is the only
// way an external edit becomes visible. Both halves must change together.
test("DataStore.reload re-reads disk and reports whether the contents changed", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-reload-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ count: 7 }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);
  assert.equal((await store.load()).count, 7);

  await fs.writeFile(file, JSON.stringify({ count: 999 }), "utf-8");
  assert.equal(await store.reload(), true);
  assert.equal((await store.load()).count, 999);
  assert.equal(await store.reload(), false, "a second reload has nothing new to report");
});

// PINS content comparison over an mtime/size stat gate. Two different hand-edits
// can share a byte length, and coarse mtime resolution (network shares, older
// filesystems) can place both inside one tick. A stat gate drops the second edit
// silently — exactly the case reload() exists to catch.
test("DataStore.reload sees an edit that shares the previous size and mtime", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-same-size-");
  const file = path.join(dir, "config.json");
  const store = new DataStore<{ id: string }>("config.json", { id: "" }, () => dir);

  await fs.writeFile(file, JSON.stringify({ id: "aaa" }), "utf-8");
  assert.equal((await store.load()).id, "aaa");
  const { mtime, atime, size } = await fs.stat(file);

  // Same length, different content, and the timestamp forced back to what the
  // store already observed.
  await fs.writeFile(file, JSON.stringify({ id: "bbb" }), "utf-8");
  await fs.utimes(file, atime, mtime);
  assert.equal((await fs.stat(file)).size, size, "the two edits really are the same size");

  assert.equal(await store.reload(), true);
  assert.equal((await store.load()).id, "bbb");
});

test("DataStore preserves an unparseable file before overwriting it when asked", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-corrupt-keep-");
  const file = path.join(dir, "config.json");
  const broken = '{ "count": oops }';
  await fs.writeFile(file, broken, "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    preserveCorruptFile: true,
  });

  assert.deepEqual(await store.load(), { count: 0 }, "still falls back to defaults");
  await store.save({ count: 5 });

  const rescued = (await fs.readdir(dir)).filter((name) => name.includes(".invalid-"));
  assert.equal(rescued.length, 1);
  assert.equal(await fs.readFile(path.join(dir, rescued[0]), "utf-8"), broken);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf-8")), { count: 5 });
});

test("DataStore leaves no rescue copy for a regenerable cache", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-corrupt-drop-");
  await fs.writeFile(path.join(dir, "config.json"), "{ nope", "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);

  await store.save({ count: 5 });

  assert.deepEqual(await fs.readdir(dir), ["config.json"], "opt-in only; no litter by default");
});

test("DataStore only rescues the corrupt file once, not on every later write", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-corrupt-once-");
  await fs.writeFile(path.join(dir, "config.json"), "{ nope", "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    preserveCorruptFile: true,
  });

  await store.save({ count: 1 });
  await store.save({ count: 2 });
  await store.update((draft) => void (draft.count += 1));

  const rescued = (await fs.readdir(dir)).filter((name) => name.includes(".invalid-"));
  assert.equal(rescued.length, 1);
});

test("DataStore refreshes before a protected mutation and preserves a new JSON typo", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-external-corrupt-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ count: 1 }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectCorruptWrite: true,
  });
  assert.deepEqual(await store.load(), { count: 1 });

  const broken = '{ "count": broken after load }';
  await fs.writeFile(file, broken, "utf-8");

  await assert.rejects(
    store.update((draft) => void (draft.count += 1)),
    /does not parse/u,
  );
  assert.equal(await fs.readFile(file, "utf-8"), broken);
});

test("DataStore rejects a stale save after a valid external edit", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-external-valid-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ count: 1 }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectExternalChanges: true,
  });
  assert.deepEqual(await store.load(), { count: 1 });

  const edited = JSON.stringify({ count: 2 });
  await fs.writeFile(file, edited, "utf-8");

  await assert.rejects(store.save({ count: 3 }), /changed outside/u);
  assert.equal(await fs.readFile(file, "utf-8"), edited);
});

test("DataStore rejects a first save when it discovers an existing file", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-first-save-existing-");
  const file = path.join(dir, "config.json");
  const existing = JSON.stringify({ count: 4 });
  await fs.writeFile(file, existing, "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectExternalChanges: true,
  });

  await assert.rejects(store.save({ count: 5 }), /changed outside/u);
  assert.equal(await fs.readFile(file, "utf-8"), existing);
});

test("DataStore rejects an external edit made during an async mutation", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-mid-mutation-edit-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ count: 1 }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectExternalChanges: true,
  });
  let mutationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    mutationStarted = resolve;
  });
  let releaseMutation!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });

  const update = store.update(async (draft) => {
    mutationStarted();
    await release;
    draft.count = 2;
  });
  await started;
  const edited = JSON.stringify({ count: 99, externallyAdded: true });
  await fs.writeFile(file, edited, "utf-8");
  releaseMutation();

  await assert.rejects(update, /changed outside/u);
  assert.equal(await fs.readFile(file, "utf-8"), edited);
});

test("DataStore protected publication never overwrites a file created after the hold", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-post-hold-edit-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ count: 1 }), "utf-8");
  const edited = JSON.stringify({ count: 99, external: true });
  let publishHookRuns = 0;
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectExternalChanges: true,
    beforeProtectedPublish: async () => {
      publishHookRuns += 1;
      await fs.writeFile(file, edited, "utf-8");
    },
  });

  await assert.rejects(
    store.update((draft) => void (draft.count = 2)),
    /changed outside/u,
  );
  assert.equal(publishHookRuns, 1);
  assert.equal(await fs.readFile(file, "utf-8"), edited);
  assert.equal(
    (await fs.readdir(dir)).some((name) => name.endsWith(".held")),
    false,
  );
});

test("DataStore restores a special file swapped into the canonical path before the hold", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-pre-hold-special-swap-");
  const file = path.join(dir, "config.json");
  const original = JSON.stringify({ count: 1 });
  await fs.writeFile(file, original, "utf-8");
  const displaced = path.join(dir, "original.json");
  const symlinkTarget = path.join(dir, "symlink-target.json");
  await fs.writeFile(symlinkTarget, JSON.stringify({ count: 9 }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectExternalChanges: true,
    beforeProtectedHold: async () => {
      await fs.rename(file, displaced);
      await fs.symlink(symlinkTarget, file);
    },
  });

  await assert.rejects(
    store.update((draft) => void (draft.count = 2)),
    DataStoreExternalChangeError,
  );
  assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(displaced, "utf-8"), original);
  assert.equal(
    (await fs.readdir(dir)).some((name) => name.endsWith(".held")),
    false,
  );
});

test("DataStore restores a directory swapped into the canonical path before the hold", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-pre-hold-directory-swap-");
  const file = path.join(dir, "config.json");
  const original = JSON.stringify({ count: 1 });
  await fs.writeFile(file, original, "utf-8");
  const displaced = path.join(dir, "original.json");
  const nested = path.join(file, "nested");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectExternalChanges: true,
    beforeProtectedHold: async () => {
      await fs.rename(file, displaced);
      await fs.mkdir(file);
      await fs.writeFile(nested, "preserve directory contents", "utf-8");
    },
  });

  await assert.rejects(
    store.update((draft) => void (draft.count = 2)),
    DataStoreExternalChangeError,
  );
  assert.equal((await fs.lstat(file)).isDirectory(), true);
  assert.equal(await fs.readFile(nested, "utf-8"), "preserve directory contents");
  assert.equal(await fs.readFile(displaced, "utf-8"), original);
  assert.equal(
    (await fs.readdir(dir)).some((name) => name.endsWith(".held")),
    false,
  );
});

test("DataStore preserves an in-place edit made through the pre-rename file descriptor", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-held-inode-edit-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ count: 1 }), "utf-8");
  const originalHandle = await fs.open(file, "r+");
  t.after(() => originalHandle.close().catch(() => undefined));
  const edited = JSON.stringify({ count: 99, external: true });
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectExternalChanges: true,
    beforeProtectedPublish: async () => {
      await originalHandle.truncate(0);
      await originalHandle.writeFile(edited, "utf-8");
      await originalHandle.sync();
    },
  });

  await assert.rejects(
    store.update((draft) => void (draft.count = 2)),
    /changed outside/u,
  );
  assert.equal(await fs.readFile(file, "utf-8"), edited);
});

test("DataStore keeps an old descriptor recoverable after the protected write returns", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-late-held-inode-edit-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ count: 1 }), "utf-8");
  const originalHandle = await fs.open(file, "r+");
  t.after(() => originalHandle.close().catch(() => undefined));
  const edited = JSON.stringify({ count: 99, lateExternal: true });
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectExternalChanges: true,
  });

  await store.update((draft) => void (draft.count = 2));
  await originalHandle.truncate(0);
  await originalHandle.writeFile(edited, "utf-8");
  await originalHandle.sync();

  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf-8")), { count: 2 });
  assert.deepEqual(await store.load(), { count: 2 }, "a committed write must refresh its cache");
  await new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir).load();
  const conflict = (await fs.readdir(dir)).find((name) => name.startsWith("config.json.conflict-"));
  assert.ok(conflict);
  assert.equal(await fs.readFile(path.join(dir, conflict), "utf-8"), edited);
});

test("DataStore recovery preserves special held-file candidates as conflicts", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-special-held-");
  const canonical = path.join(dir, "config.json");
  await fs.writeFile(canonical, JSON.stringify({ count: 2 }), "utf-8");
  const symlink = path.join(dir, ".config.json.symlink.held");
  await fs.symlink(canonical, symlink);
  const fifo = path.join(dir, ".config.json.fifo.held");
  execFileSync("/usr/bin/mkfifo", [fifo]);

  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);
  assert.deepEqual(await store.load(), { count: 2 });
  const conflicts = (await fs.readdir(dir)).filter((name) =>
    name.startsWith("config.json.conflict-"),
  );
  assert.equal(conflicts.length, 2);
  const conflictTypes = await Promise.all(
    conflicts.map(async (name) => {
      const info = await fs.lstat(path.join(dir, name));
      return info.isSymbolicLink() ? "symlink" : info.isFIFO() ? "fifo" : "other";
    }),
  );
  assert.deepEqual(conflictTypes.sort(), ["fifo", "symlink"]);
});

test("DataStore refuses a canonical FIFO or symlink without blocking startup", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-special-canonical-");
  const canonical = path.join(dir, "config.json");
  execFileSync("/usr/bin/mkfifo", [canonical]);
  const loadWithinDeadline = async (
    store: DataStore<{ count: number }>,
  ): Promise<{ count: number }> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        store.load(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("special-file read blocked startup")), 500);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const fifoStore = new DataStore("config.json", { count: 0 }, () => dir);
  assert.deepEqual(await loadWithinDeadline(fifoStore), { count: 0 });
  assert.equal(await fifoStore.loadedFromCorruptFile(), true);

  await fs.rm(canonical);
  const target = path.join(dir, "actual.json");
  await fs.writeFile(target, JSON.stringify({ count: 4 }), "utf-8");
  await fs.symlink(target, canonical);
  const symlinkStore = new DataStore("config.json", { count: 0 }, () => dir, {
    preserveCorruptFile: true,
    rejectCorruptWrite: true,
    reloadBeforeWrite: true,
    rejectExternalChanges: true,
  });
  assert.deepEqual(await loadWithinDeadline(symlinkStore), { count: 0 });
  assert.equal(await symlinkStore.loadedFromCorruptFile(), true);
  await assert.rejects(
    symlinkStore.update((draft) => void (draft.count = 5)),
    DataStoreCorruptWriteError,
  );
  assert.equal((await fs.lstat(canonical)).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf-8")), { count: 4 });
});

test("DataStore recovers a crash-orphaned held file before loading defaults", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-held-recovery-");
  const held = path.join(dir, ".config.json.crash.held");
  await fs.writeFile(held, JSON.stringify({ count: 7 }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);

  assert.deepEqual(await store.load(), { count: 7 });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8")), {
    count: 7,
  });
  assert.equal(
    (await fs.readdir(dir)).some(
      (name) => name.startsWith("config.json.previous-") || name.endsWith(".held"),
    ),
    false,
  );
});

test("DataStore restores crash-held symlinks, FIFOs, and directories without following them", async (t) => {
  for (const kind of ["symlink", "fifo", "directory"] as const) {
    const dir = await tmpDir(t, `aiden-ds-held-${kind}-`);
    const held = path.join(dir, `.config.json.absent.${kind}.held`);
    const canonical = path.join(dir, "config.json");
    if (kind === "symlink") {
      const target = path.join(dir, "external.json");
      await fs.writeFile(target, JSON.stringify({ count: 9 }), "utf-8");
      await fs.symlink(target, held);
    } else if (kind === "fifo") {
      execFileSync("mkfifo", [held]);
    } else {
      await fs.mkdir(path.join(held, "nested"), { recursive: true });
      await fs.writeFile(path.join(held, "nested", "sentinel.txt"), "untouched", "utf-8");
    }
    const store = new DataStore("config.json", { count: 0 }, () => dir, {
      preserveCorruptFile: true,
      reloadBeforeWrite: true,
      rejectCorruptWrite: true,
      rejectExternalChanges: true,
    });

    assert.deepEqual(await store.load(), { count: 0 });
    assert.equal(await store.loadedFromCorruptFile(), true);
    await assert.rejects(
      store.update((draft) => void (draft.count = 1)),
      DataStoreCorruptWriteError,
    );
    const info = await fs.lstat(canonical);
    if (kind === "symlink") assert.equal(info.isSymbolicLink(), true);
    if (kind === "fifo") assert.equal(info.isFIFO(), true);
    if (kind === "directory") {
      assert.equal(info.isDirectory(), true);
      assert.equal(
        await fs.readFile(path.join(canonical, "nested", "sentinel.txt"), "utf-8"),
        "untouched",
      );
    }
  }
});

test("DataStore retains process-lifetime predecessors without imposing a write-count limit", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-predecessor-bound-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, `${JSON.stringify({ count: 0 })}\n`, "utf-8");
  const store = new DataStore("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectUnsafeWrite: true,
    rejectExternalChanges: true,
  });
  await store.load();

  for (let count = 1; count <= 64; count += 1) {
    await store.update((draft) => void (draft.count = count));
  }
  assert.equal(JSON.parse(await fs.readFile(file, "utf-8")).count, 64);
  assert.equal((await fs.readdir(dir)).filter((name) => name.endsWith(".previous")).length, 64);
});

test("DataStore preserves an old-descriptor edit after multiple later app writes", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-predecessor-conflict-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, `${JSON.stringify({ count: 0 })}\n`, "utf-8");
  const originalHandle = await fs.open(file, "r+");
  t.after(() => originalHandle.close().catch(() => undefined));
  const store = new DataStore("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectExternalChanges: true,
  });

  await store.update((draft) => void (draft.count = 1));
  await store.update((draft) => void (draft.count = 2));
  await store.update((draft) => void (draft.count = 3));
  await originalHandle.truncate(0);
  await originalHandle.writeFile(JSON.stringify({ count: 99, lateExternal: true }), "utf-8");
  await originalHandle.sync();

  assert.equal(JSON.parse(await fs.readFile(file, "utf-8")).count, 3);
  const relaunched = new DataStore("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectExternalChanges: true,
  });
  assert.deepEqual(await relaunched.load(), { count: 3 });
  const conflict = (await fs.readdir(dir)).find((name) => name.startsWith("config.json.conflict-"));
  assert.ok(conflict);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, conflict), "utf-8")), {
    count: 99,
    lateExternal: true,
  });
});

test("DataStore removes an unchanged crash-held predecessor when canonical data exists", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-held-cleanup-");
  const oldContents = JSON.stringify({ count: 1 });
  const oldHash = createHash("sha256").update(oldContents).digest("hex");
  const held = path.join(dir, `.config.json.${oldHash}.crash.held`);
  await fs.writeFile(held, oldContents, "utf-8");
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ count: 2 }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);

  assert.deepEqual(await store.load(), { count: 2 });
  assert.deepEqual(await fs.readdir(dir), ["config.json"]);
});

test("DataStore preserves a changed crash-held predecessor as a conflict", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-held-conflict-");
  const expected = JSON.stringify({ count: 1 });
  const edited = JSON.stringify({ count: 9, external: true });
  const expectedHash = createHash("sha256").update(expected).digest("hex");
  await fs.writeFile(path.join(dir, `.config.json.${expectedHash}.crash.held`), edited, "utf-8");
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ count: 2 }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);

  assert.deepEqual(await store.load(), { count: 2 });
  const conflict = (await fs.readdir(dir)).find((name) => name.startsWith("config.json.conflict-"));
  assert.ok(conflict);
  assert.equal(await fs.readFile(path.join(dir, conflict), "utf-8"), edited);
});

test("DataStore.reload waits for an in-flight initial load before reading newer bytes", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-load-reload-race-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ count: 1 }), "utf-8");
  let firstRead!: () => void;
  const read = new Promise<void>((resolve) => {
    firstRead = resolve;
  });
  let releaseFirstRead!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  let loadCommits = 0;
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    beforeLoadCommit: async () => {
      loadCommits += 1;
      if (loadCommits !== 1) return;
      firstRead();
      await release;
    },
  });

  const initialLoad = store.load();
  await read;
  await fs.writeFile(file, JSON.stringify({ count: 2 }), "utf-8");
  const reload = store.reload();
  releaseFirstRead();

  assert.deepEqual(await initialLoad, { count: 1 });
  assert.equal(await reload, true);
  assert.deepEqual(await store.load(), { count: 2 });
});

test("DataStore.reload on a missing file yields the default value", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-reload-gone-");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);
  await store.save({ count: 5 });

  await fs.rm(path.join(dir, "config.json"));
  assert.equal(await store.reload(), true);
  assert.equal((await store.load()).count, 0);
});

// PINS the atomic-write contract. An in-place write can leave a truncated file if
// the process dies mid-write, which is unacceptable for a config the user edits
// by hand rather than a cache the app can regenerate.
test("DataStore.save replaces the file by rename and leaves no staging file", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-atomic-");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);
  await store.save({ count: 1 });
  await store.save({ count: 2 });

  assert.deepEqual(await fs.readdir(dir), ["config.json"]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8")), {
    count: 2,
  });
});

test("DataStore.save leaves no staging file behind when the write is rejected", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-atomic-fail-");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);
  await store.save({ count: 1 });

  await assert.rejects(() => store.save({ count: 2 }, () => false));
  assert.deepEqual(await fs.readdir(dir), ["config.json"]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8")), {
    count: 1,
  });
});

test("DataStore.update throws when isCurrent() reports the document is stale", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-stale-");
  const store = new DataStore<{ n: number }>("state.json", { n: 0 }, () => dir);
  await store.load();
  await assert.rejects(
    () =>
      store.update(
        (draft) => void (draft.n += 1),
        () => false,
      ),
    /renderer document is no longer active/i,
  );
});

test("DataStore rechecks renderer ownership immediately before protected publication", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-owner-before-publish-");
  const file = path.join(dir, "config.json");
  const original = JSON.stringify({ count: 1 });
  await fs.writeFile(file, original, "utf-8");
  let current = true;
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    reloadBeforeWrite: true,
    rejectExternalChanges: true,
    beforeProtectedPublish: async () => void (current = false),
  });

  await assert.rejects(
    () =>
      store.update(
        (draft) => void (draft.count = 2),
        () => current,
      ),
    /renderer document is no longer active/u,
  );
  assert.equal(await fs.readFile(file, "utf-8"), original);
});

test("DataStore.update serializes concurrent transactions in arrival order", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-serial-");
  const store = new DataStore<{ log: string[] }>("state.json", { log: [] }, () => dir);

  // Interleave updates; each blocks on its own deferred so ordering is forced.
  const order: string[] = [];
  function gate(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    return { promise, release };
  }
  const g1 = gate();
  const g2 = gate();
  const g3 = gate();

  const u1 = store.update(async (draft) => {
    order.push("u1-start");
    await g1.promise;
    draft.log.push("a");
    order.push("u1-end");
  });
  const u2 = store.update(async (draft) => {
    order.push("u2-start");
    await g2.promise;
    draft.log.push("b");
    order.push("u2-end");
  });
  const u3 = store.update(async (draft) => {
    order.push("u3-start");
    await g3.promise;
    draft.log.push("c");
    order.push("u3-end");
  });

  // Release in order.
  g1.release();
  await u1;
  g2.release();
  await u2;
  g3.release();
  await u3;

  assert.deepEqual(order, ["u1-start", "u1-end", "u2-start", "u2-end", "u3-start", "u3-end"]);
  assert.deepEqual((await store.load()).log, ["a", "b", "c"]);
});

// ── Chat store (chat-store-core) ────────────────────────────────────────────

test("chat store: list() returns [] when index.json is corrupt", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-corrupt-index-");
  await fs.writeFile(path.join(dir, "index.json"), "[broken,}", "utf-8");
  const store = createChatStore(async () => dir);
  assert.deepEqual(await store.list(), []);
});

test("chat store: list() returns [] when index.json is valid JSON with the wrong root shape", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-invalid-index-shape-");
  for (const value of [{}, null, "not-an-array"]) {
    await fs.writeFile(path.join(dir, "index.json"), JSON.stringify(value), "utf-8");
    const store = createChatStore(async () => dir);
    assert.deepEqual(await store.list(), []);
  }
});

test("chat store: list() drops malformed index entries while preserving valid chats", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-invalid-index-entry-");
  const valid = {
    id: "valid",
    title: "Valid",
    createdAt: 1,
    updatedAt: 2,
    workspaceId: "default",
    providerId: undefined,
    model: undefined,
  };
  await fs.writeFile(
    path.join(dir, `${valid.id}.json`),
    JSON.stringify({ ...valid, messages: [] }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "index.json"),
    JSON.stringify([valid, null, {}, { ...valid, id: "" }, { ...valid, updatedAt: "later" }]),
    "utf-8",
  );
  const store = createChatStore(async () => dir);
  assert.deepEqual(await store.list(), [valid]);
});

test("chat store: list() returns [] when index.json is missing", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-missing-index-");
  const store = createChatStore(async () => dir);
  assert.deepEqual(await store.list(), []);
});

test("chat store: get() returns null for a chat file that fails to parse", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-corrupt-chat-");
  // A valid index pointing at a chat file that is corrupt JSON.
  const chatId = "deadbeef";
  await fs.writeFile(
    path.join(dir, "index.json"),
    JSON.stringify([
      { id: chatId, title: "Ghost", createdAt: 1, updatedAt: 1, workspaceId: "default" },
    ]),
    "utf-8",
  );
  await fs.writeFile(path.join(dir, `${chatId}.json`), "{not json", "utf-8");
  const store = createChatStore(async () => dir);
  assert.equal(await store.get(chatId), null);
});

test("chat store: a chat file with unknown extra fields still loads (forward-compat)", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-forward-");
  const store = createChatStore(async () => dir);
  const created = await store.create({ workspaceId: "default" });
  await store.appendMessage(created.id, { role: "user", content: "hi" });

  // Inject a future-shape field into the chat file directly, then reload.
  const file = path.join(dir, `${created.id}.json`);
  const raw = JSON.parse(await fs.readFile(file, "utf-8"));
  raw.futureField = { anything: true };
  raw.messages[0].futureMessageField = 42;
  await fs.writeFile(file, JSON.stringify(raw), "utf-8");

  const reloaded = await store.get(created.id);
  assert.equal(reloaded?.id, created.id);
  assert.equal(reloaded?.messages[0].content, "hi");
});

test("chat store: a chat message missing optional fields loads with safe defaults", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-minimal-");
  const store = createChatStore(async () => dir);
  const created = await store.create({ workspaceId: "default" });

  // Write a minimal chat file with only the required message fields (no
  // reasoning/timeline/model — the sanitization in readChat must not throw).
  const minimal = {
    id: created.id,
    title: "Minimal",
    createdAt: 1,
    updatedAt: 1,
    workspaceId: "default",
    messages: [
      { id: "m1", role: "assistant", content: "ok", createdAt: 1 },
      { id: "m2", role: "user", content: "hey", createdAt: 2 },
    ],
  };
  await fs.writeFile(
    path.join(dir, "index.json"),
    JSON.stringify([
      {
        id: created.id,
        title: "Minimal",
        createdAt: 1,
        updatedAt: 1,
        workspaceId: "default",
      },
    ]),
    "utf-8",
  );
  await fs.writeFile(path.join(dir, `${created.id}.json`), JSON.stringify(minimal), "utf-8");

  const reloaded = await store.get(created.id);
  assert.equal(reloaded?.messages.length, 2);
  // The assistant message keeps an undefined reasoning (not thrown); the user
  // message has reasoning stripped to undefined per readChat sanitization.
  assert.equal(reloaded?.messages[0].reasoning, undefined);
  assert.equal(reloaded?.messages[1].reasoning, undefined);
});
