import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsModule from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { StudioAssetError, type StudioAssetLimits } from "./contract.js";
import { StudioAssetStore } from "./store.js";
import { fakeThumbnailer, pngBytes } from "./test-fixture.js";

const HOUR = 60 * 60 * 1000;
const code = (expected: StudioAssetError["code"]) => (error: unknown) =>
  error instanceof StudioAssetError && error.code === expected;

async function fixture(t: TestContext, limits: Partial<StudioAssetLimits> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-studio-assets-"));
  let now = 1_000_000;
  const thumbs = fakeThumbnailer();
  const open = async () => {
    const store = new StudioAssetStore({
      root: () => root,
      thumbnailer: thumbs.thumbnailer,
      now: () => now,
      limits,
    });
    await store.initialize();
    t.after(() => store.close());
    return store;
  };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    thumbs,
    open,
    store: await open(),
    advance(ms: number) {
      now += ms;
    },
    async blobFiles() {
      const shards = await fs.readdir(path.join(root, "blobs"));
      return (
        await Promise.all(shards.map((shard) => fs.readdir(path.join(root, "blobs", shard))))
      ).flat();
    },
  };
}

test("put stores validated bytes once and deduplicates identical content", async (t) => {
  const f = await fixture(t);
  const bytes = pngBytes(640, 480, 1);
  const first = await f.store.put({ bytes, declaredMimeType: "image/png" });
  const second = await f.store.put({ bytes });
  assert.match(first.assetId, /^[0-9a-f]{64}$/u);
  assert.deepEqual(second, first);
  assert.deepEqual(
    { mediaType: first.mediaType, width: first.width, height: first.height, bytes: first.bytes },
    { mediaType: "image/png", width: 640, height: 480, bytes: bytes.byteLength },
  );
  assert.deepEqual(Buffer.from((await f.store.read(first.assetId)).bytes), Buffer.from(bytes));
  assert.deepEqual(f.store.usage(), { assets: 1, bytes: bytes.byteLength });
  assert.deepEqual(await f.blobFiles(), [first.assetId]);
});

test("rejected images write nothing", async (t) => {
  const f = await fixture(t, { maxAssetBytes: 1_000 });
  await assert.rejects(
    f.store.put({ bytes: new TextEncoder().encode("not an image") }),
    code("invalid_image"),
  );
  await assert.rejects(f.store.put({ bytes: pngBytes(20_000, 2) }), code("too_large"));
  await assert.rejects(f.store.put({ bytes: new Uint8Array(1_001) }), code("too_large"));
  assert.deepEqual(f.store.usage(), { assets: 0, bytes: 0 });
  assert.deepEqual(await f.blobFiles(), []);
});

test("only unheld assets past the grace period are collected, across a restart", async (t) => {
  const f = await fixture(t);
  const held = await f.store.put({ bytes: pngBytes(10, 10, 1) });
  const loose = await f.store.put({ bytes: pngBytes(10, 10, 2) });
  f.store.retain({ kind: "design", id: "project-1" }, [held.assetId]);

  assert.deepEqual(await f.store.collectGarbage(), { deletedAssets: 0, freedBytes: 0 });
  f.advance(2 * HOUR);
  await f.store.close();
  const restarted = await f.open(); // initialize() collects too
  assert.equal(restarted.get(loose.assetId), undefined);
  await assert.rejects(restarted.read(loose.assetId), code("not_found"));
  assert.deepEqual(restarted.holders(held.assetId), [{ kind: "design", id: "project-1" }]);
  assert.equal(
    (await restarted.read(held.assetId)).bytes.byteLength,
    held.bytes,
    "held blob survives the sweep",
  );

  restarted.release({ kind: "design", id: "project-1" }, [held.assetId]);
  assert.equal(
    (await restarted.collectGarbage()).deletedAssets,
    0,
    "a fresh release is still within grace",
  );
  f.advance(2 * HOUR);
  assert.equal((await restarted.collectGarbage()).deletedAssets, 1);
  assert.deepEqual(await f.blobFiles(), []);
});

test("holders are independent; releaseAll and replace change only their own holds", async (t) => {
  const f = await fixture(t);
  const [a, b, c] = await Promise.all(
    [1, 2, 3].map((seed) => f.store.put({ bytes: pngBytes(10, 10, seed) })),
  );
  const workflow = { kind: "images-workflow", id: "wf-1" } as const;
  const run = { kind: "images-run", id: "run-1" } as const;
  f.store.retain(workflow, [a!.assetId, b!.assetId]);
  f.store.retain(run, [b!.assetId]);

  assert.equal(f.store.releaseAllForHolder(workflow), 2);
  assert.deepEqual(f.store.holders(a!.assetId), []);
  assert.deepEqual(f.store.holders(b!.assetId), [run]);

  f.store.replaceHolder(workflow, [b!.assetId, c!.assetId]);
  f.store.replaceHolder(workflow, [c!.assetId]);
  assert.deepEqual(f.store.holders(b!.assetId), [run]);
  assert.deepEqual(f.store.holders(c!.assetId), [workflow]);
});

test("retain is atomic and refuses unknown assets and unsafe holders", async (t) => {
  const f = await fixture(t);
  const a = await f.store.put({ bytes: pngBytes(10, 10, 1) });
  assert.throws(
    () => f.store.retain({ kind: "design", id: "project-1" }, [a.assetId, "f".repeat(64)]),
    code("not_found"),
  );
  assert.deepEqual(f.store.holders(a.assetId), []);
  assert.throws(
    () => f.store.retain({ kind: "design", id: "../x" }, [a.assetId]),
    code("invalid_holder"),
  );
});

test("a blob written without its row is swept on restart", async (t) => {
  const f = await fixture(t);
  const orphanId = "a".repeat(64);
  await fs.mkdir(path.join(f.root, "blobs", "aa"), { recursive: true });
  await fs.writeFile(path.join(f.root, "blobs", "aa", orphanId), pngBytes(4, 4));
  await fs.writeFile(path.join(f.root, "blobs", "aa", `.${orphanId}.crash.tmp`), "partial");
  await fs.writeFile(path.join(f.root, "thumbs", `${orphanId}-256.png`), pngBytes(4, 4));
  await f.store.close();
  await f.open();
  assert.deepEqual(await f.blobFiles(), []);
  assert.deepEqual(await fs.readdir(path.join(f.root, "thumbs")), []);
});

test("store-wide quota fails closed", async (t) => {
  const f = await fixture(t, { maxAssets: 1 });
  await f.store.put({ bytes: pngBytes(10, 10, 1) });
  await assert.rejects(f.store.put({ bytes: pngBytes(10, 10, 2) }), code("quota"));
  assert.equal(f.store.usage().assets, 1);
});

test("thumbnails render once, are cached, and fall back to the original", async (t) => {
  const f = await fixture(t);
  const large = await f.store.put({ bytes: pngBytes(2_000, 1_000, 1) });
  const small = await f.store.put({ bytes: pngBytes(100, 100, 2) });

  const first = await f.store.thumbnail(large.assetId, 256);
  const again = await f.store.thumbnail(large.assetId, 256);
  assert.equal(first.mediaType, "image/png");
  assert.deepEqual(Buffer.from(again.bytes), Buffer.from(first.bytes));
  assert.deepEqual(f.thumbs.calls, [256]);

  const tiny = await f.store.thumbnail(small.assetId, 256);
  assert.deepEqual(Buffer.from(tiny.bytes), Buffer.from((await f.store.read(small.assetId)).bytes));
  assert.deepEqual(f.thumbs.calls, [256], "an image within the edge is served as-is");

  f.thumbs.failNext();
  const fallback = await f.store.thumbnail(large.assetId, 512);
  assert.deepEqual(
    Buffer.from(fallback.bytes),
    Buffer.from((await f.store.read(large.assetId)).bytes),
  );
  await f.store.thumbnail(large.assetId, 512);
  assert.deepEqual(f.thumbs.calls, [256, 512, 512], "a failed render is not cached");
});

/**
 * Holds every blob unlink at a gate so a put can be issued in the window after
 * GC deleted the row but before it removed the file.
 */
function gateBlobUnlinks(t: TestContext) {
  const realRm = fsModule.rm;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reachedResolve = () => {};
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  fsModule.rm = (async (
    target: Parameters<typeof realRm>[0],
    options?: Parameters<typeof realRm>[1],
  ) => {
    if (String(target).includes(`${path.sep}blobs${path.sep}`)) {
      reachedResolve();
      await gate;
    }
    return realRm(target, options);
  }) as typeof realRm;
  syncBuiltinESMExports();
  t.after(() => {
    fsModule.rm = realRm;
    syncBuiltinESMExports();
  });
  return { reached, release };
}

async function ioTurns(count: number) {
  for (let turn = 0; turn < count; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("a put racing a collection of the same unheld digest stays readable (GC first)", async (t) => {
  const f = await fixture(t);
  const bytes = pngBytes(10, 10, 5);
  const loose = await f.store.put({ bytes });
  f.advance(2 * HOUR);
  const gate = gateBlobUnlinks(t);

  const collecting = f.store.collectGarbage();
  await gate.reached; // GC has dropped the row and is about to unlink the blob
  const putting = f.store.put({ bytes });
  // Without serialization the put would finish here, against the doomed blob.
  await Promise.race([putting, ioTurns(300)]);
  gate.release();
  const [swept, record] = await Promise.all([collecting, putting]);

  assert.deepEqual(swept, { deletedAssets: 1, freedBytes: bytes.byteLength });
  assert.deepEqual(record, { ...loose, createdAt: record.createdAt });
  assert.deepEqual(Buffer.from((await f.store.read(record.assetId)).bytes), Buffer.from(bytes));
  assert.deepEqual(f.store.get(record.assetId), record);
  assert.deepEqual(f.store.usage(), { assets: 1, bytes: bytes.byteLength });
  assert.deepEqual(await f.blobFiles(), [record.assetId]);
});

test("a put queued before a collection keeps the digest alive (put first)", async (t) => {
  const f = await fixture(t);
  const bytes = pngBytes(10, 10, 6);
  const loose = await f.store.put({ bytes });
  f.advance(2 * HOUR);

  const putting = f.store.put({ bytes });
  const collecting = f.store.collectGarbage();
  const [record, swept] = await Promise.all([putting, collecting]);

  assert.deepEqual(swept, { deletedAssets: 0, freedBytes: 0 });
  assert.deepEqual(record, loose);
  assert.deepEqual(Buffer.from((await f.store.read(record.assetId)).bytes), Buffer.from(bytes));
  assert.deepEqual(await f.blobFiles(), [record.assetId]);
});

test("concurrent puts of identical new bytes converge on one record and one blob", async (t) => {
  const f = await fixture(t);
  const bytes = pngBytes(12, 12, 9);
  const records = await Promise.all([1, 2, 3].map(() => f.store.put({ bytes })));
  assert.deepEqual(records[1], records[0]);
  assert.deepEqual(records[2], records[0]);
  assert.deepEqual(f.store.usage(), { assets: 1, bytes: bytes.byteLength });
  assert.deepEqual(await f.blobFiles(), [records[0]!.assetId]);
});

test("a failed put does not block later queued operations", async (t) => {
  const f = await fixture(t, { maxAssetBytes: 1_000 });
  const rejected = f.store.put({ bytes: new Uint8Array(1_001) });
  const accepted = f.store.put({ bytes: pngBytes(10, 10, 1) });
  await assert.rejects(rejected, code("too_large"));
  assert.equal((await accepted).width, 10);
  assert.deepEqual(await f.store.collectGarbage(), { deletedAssets: 0, freedBytes: 0 });
});

test("a blob unlinked after its row was found reads as not_found", async (t) => {
  const f = await fixture(t);
  const large = await f.store.put({ bytes: pngBytes(2_000, 1_000, 1) });
  const small = await f.store.put({ bytes: pngBytes(10, 10, 2) });
  for (const asset of [large, small]) {
    await fs.rm(path.join(f.root, "blobs", asset.assetId.slice(0, 2), asset.assetId));
  }
  await assert.rejects(f.store.read(large.assetId), code("not_found"));
  await assert.rejects(f.store.thumbnail(large.assetId, 256), code("not_found"));
  await assert.rejects(f.store.thumbnail(small.assetId, 256), code("not_found"));
});

test("close during an in-flight put never surfaces a native sqlite error", async (t) => {
  const f = await fixture(t);
  const putting = f.store.put({ bytes: pngBytes(10, 10, 3) });
  await ioTurns(2); // let the put reach its blob write before closing
  const closing = f.store.close();
  await putting.then(
    (record) => assert.match(record.assetId, /^[0-9a-f]{64}$/u),
    (error: unknown) =>
      assert.ok(error instanceof StudioAssetError && error.code === "unavailable", String(error)),
  );
  await closing;
  await assert.rejects(f.store.put({ bytes: pngBytes(10, 10, 4) }), code("unavailable"));
  assert.throws(() => f.store.usage(), code("unavailable"));
  await f.store.close(); // closing twice is a no-op
});

test("a failing ROLLBACK does not mask the original transaction error", async (t) => {
  const f = await fixture(t);
  const a = await f.store.put({ bytes: pngBytes(10, 10, 1) });
  // Make SQLite abort and roll back the transaction itself, so the store's own
  // ROLLBACK then fails with "no transaction is active".
  const side = new DatabaseSync(path.join(f.root, "assets-v1.sqlite"));
  t.after(() => side.close());
  side.exec(
    "CREATE TRIGGER abort_holds BEFORE INSERT ON holds BEGIN SELECT RAISE(ROLLBACK, 'holds are frozen'); END;",
  );
  assert.throws(
    () => f.store.retain({ kind: "design", id: "project-1" }, [a.assetId]),
    /holds are frozen/u,
  );
});

test("concurrent initialize calls share one open", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-studio-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let rootCalls = 0;
  const store = new StudioAssetStore({
    root: () => {
      rootCalls += 1;
      return root;
    },
    thumbnailer: fakeThumbnailer().thumbnailer,
  });
  await Promise.all([store.initialize(), store.initialize(), store.initialize()]);
  assert.equal(rootCalls, 1);
  const record = await store.put({ bytes: pngBytes(10, 10, 1) });
  assert.equal((await store.read(record.assetId)).bytes.byteLength, record.bytes);
  await store.close(); // one close is enough
  assert.throws(() => store.usage(), code("unavailable"));
});

async function rawStore(t: TestContext, onError?: (error: unknown) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-studio-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new StudioAssetStore({
    root: () => root,
    thumbnailer: fakeThumbnailer().thumbnailer,
    onError,
  });
  t.after(() => store.close());
  return { root, store };
}

test("status reports closed, open, then closed again after shutdown", async (t) => {
  const { store } = await rawStore(t);
  assert.equal(store.status(), "closed");
  await store.initialize();
  assert.equal(store.status(), "open");
  await store.close();
  assert.equal(store.status(), "closed");
});

test("a failed startup sweep is reported and the store stays usable", async (t) => {
  const errors: unknown[] = [];
  const { root, store } = await rawStore(t, (error) => errors.push(error));
  const sweepFailure = new Error("thumbs unreadable");
  const realReaddir = fsModule.readdir;
  fsModule.readdir = (async (...args: Parameters<typeof realReaddir>) => {
    if (String(args[0]) === path.join(root, "thumbs")) throw sweepFailure;
    return realReaddir(...args);
  }) as typeof realReaddir;
  syncBuiltinESMExports();
  t.after(() => {
    fsModule.readdir = realReaddir;
    syncBuiltinESMExports();
  });
  await store.initialize();
  assert.deepEqual(errors, [sweepFailure]);
  assert.equal(store.status(), "open");
  const record = await store.put({ bytes: pngBytes(10, 10, 5) });
  assert.equal((await store.read(record.assetId)).bytes.byteLength, record.bytes);
});

test("a database that cannot open leaves the store failed, and a later initialize retries", async (t) => {
  const { root, store } = await rawStore(t);
  // A directory where the database file belongs makes the open fail.
  const database = path.join(root, "assets-v1.sqlite");
  await fs.mkdir(database, { recursive: true });
  await assert.rejects(store.initialize());
  assert.equal(store.status(), "failed");
  assert.throws(() => store.usage(), code("unavailable"));
  await assert.rejects(store.put({ bytes: pngBytes(10, 10, 6) }), code("unavailable"));

  await fs.rm(database, { recursive: true });
  await store.initialize();
  assert.equal(store.status(), "open");
  const record = await store.put({ bytes: pngBytes(10, 10, 6) });
  assert.equal(store.get(record.assetId)?.assetId, record.assetId);
});
