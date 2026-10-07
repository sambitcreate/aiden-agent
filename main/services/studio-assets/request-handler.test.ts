import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { StudioAssetError } from "./contract.js";
import { StudioAssetGrants } from "./delivery-core.js";
import { createStudioAssetRequestHandler } from "./request-handler.js";
import { StudioAssetStore } from "./store.js";
import { fakeThumbnailer, pngBytes } from "./test-fixture.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-studio-protocol-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = 1_000_000;
  const store = new StudioAssetStore({
    root: () => root,
    thumbnailer: fakeThumbnailer().thumbnailer,
    now: () => now,
  });
  await store.initialize();
  t.after(() => store.close());
  const grants = new StudioAssetGrants();
  let destroyed = false;
  const listeners = new Set<() => void>();
  const owner = {
    id: 3,
    documentId: "3:1:main",
    isDestroyed: () => destroyed,
    onInvalidated: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    store,
    grants,
    owner,
    handle: createStudioAssetRequestHandler({ store, grants }),
    advance(ms: number) {
      now += ms;
    },
    navigate() {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

test("a granted original is served with safe headers", async (t) => {
  const f = await fixture(t);
  const bytes = pngBytes(64, 32, 1);
  const asset = await f.store.put({ bytes });
  const response = await f.handle(new Request(f.grants.issue(f.owner, asset.assetId, "original")));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(bytes));
});

test("thumbnail renditions serve PNG thumbnails", async (t) => {
  const f = await fixture(t);
  const asset = await f.store.put({ bytes: pngBytes(1_024, 768, 2) });
  const response = await f.handle(new Request(f.grants.issue(f.owner, asset.assetId, "thumb-256")));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
});

test("unknown, malformed and revoked URLs are not found", async (t) => {
  const f = await fixture(t);
  const asset = await f.store.put({ bytes: pngBytes(8, 8, 3) });
  const url = f.grants.issue(f.owner, asset.assetId, "original");
  for (const candidate of [`aiden-asset://grant/${"Z".repeat(43)}`, `${url}?download=1`, url.replace("grant", "other")]) {
    assert.equal((await f.handle(new Request(candidate))).status, 404, candidate);
  }
  f.navigate();
  assert.equal((await f.handle(new Request(url))).status, 404);
});

test("only GET and HEAD are served", async (t) => {
  const f = await fixture(t);
  const asset = await f.store.put({ bytes: pngBytes(8, 8, 4) });
  const url = f.grants.issue(f.owner, asset.assetId, "original");
  assert.equal((await f.handle(new Request(url, { method: "POST", body: "x" }))).status, 405);
  const head = await f.handle(new Request(url, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test("a collected asset is not found and a closed store is unavailable", async (t) => {
  const f = await fixture(t);
  const collected = await f.store.put({ bytes: pngBytes(8, 8, 5) });
  const collectedUrl = f.grants.issue(f.owner, collected.assetId, "original");
  f.advance(2 * 60 * 60 * 1000);
  assert.equal((await f.store.collectGarbage()).deletedAssets, 1);
  // The grant outlives the asset; the response says "gone", not "broken".
  assert.equal((await f.handle(new Request(collectedUrl))).status, 404);

  const kept = await f.store.put({ bytes: pngBytes(8, 8, 6) });
  const keptUrl = f.grants.issue(f.owner, kept.assetId, "original");
  await f.store.close();
  assert.equal((await f.handle(new Request(keptUrl))).status, 503);
});

test("unexpected store failures answer 500 without leaking internals", async () => {
  const grants = {
    resolve: () => ({ assetId: "a".repeat(64), rendition: "original" as const }),
  };
  const handle = createStudioAssetRequestHandler({
    grants,
    store: {
      read: async () => {
        throw new Error("EIO: /Users/someone/Library/Application Support/studio-assets/blobs/secret");
      },
      thumbnail: async () => {
        throw new StudioAssetError("invalid_image", "bad pixels");
      },
    },
  });
  const failed = await handle(new Request("aiden-asset://grant/" + "A".repeat(43)));
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /Users|secret|EIO/u);
});
