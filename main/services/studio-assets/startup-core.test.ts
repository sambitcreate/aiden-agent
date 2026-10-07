import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { StudioAssetGrants } from "./delivery-core.js";
import { startStudioAssets } from "./startup-core.js";
import { StudioAssetStore } from "./store.js";
import { fakeThumbnailer, pngBytes } from "./test-fixture.js";

async function setup(t: TestContext) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-studio-startup-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "studio-assets");
  let rootResolved = false;
  const store = new StudioAssetStore({
    root: () => {
      rootResolved = true;
      return root;
    },
    thumbnailer: fakeThumbnailer().thumbnailer,
  });
  t.after(() => store.close());
  const grants = new StudioAssetGrants();
  const handlers: Array<(request: Request) => Promise<Response>> = [];
  const errors: unknown[] = [];
  return {
    parent,
    root,
    store,
    grants,
    handlers,
    errors,
    rootResolved: () => rootResolved,
    start: (enabled: boolean, over: Partial<Parameters<typeof startStudioAssets>[0]> = {}) =>
      startStudioAssets({
        enabled,
        store,
        grants,
        registerProtocol: (handler) => handlers.push(handler),
        onError: (error) => errors.push(error),
        ...over,
      }),
  };
}

test("with the studio flags off nothing is registered and no files are created", async (t) => {
  const f = await setup(t);
  assert.equal(await f.start(false), false);
  assert.equal(f.handlers.length, 0);
  assert.equal(f.rootResolved(), false);
  assert.deepEqual(await fs.readdir(f.parent), []);
  // Shutdown of a never-opened store is a no-op.
  await f.store.close();
});

test("with a studio flag on the store opens, then the handler serves granted assets", async (t) => {
  const f = await setup(t);
  assert.equal(await f.start(true), true);
  assert.equal(f.handlers.length, 1);
  const db = await fs.stat(path.join(f.root, "assets-v1.sqlite"));
  assert.ok(db.isFile());
  // The installed handler serves from the store and grants it was wired with.
  const asset = await f.store.put({ bytes: pngBytes(8, 8, 9) });
  const owner = {
    id: 1,
    documentId: "1:1:main",
    isDestroyed: () => false,
    onInvalidated: () => () => undefined,
  };
  const response = await f.handlers[0]!(new Request(f.grants.issue(owner, asset.assetId, "original")));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
});

test("the handler is still installed when the store cannot open, and answers 503", async (t) => {
  const f = await setup(t);
  // A file where the store root belongs makes the directory creation fail.
  await fs.writeFile(f.root, "not a directory");
  const started = await f.start(true);
  assert.equal(started, false);
  assert.equal(f.errors.length, 1);
  assert.equal(f.store.status(), "failed");
  assert.equal(f.handlers.length, 1);
  const owner = {
    id: 1,
    documentId: "1:1:main",
    isDestroyed: () => false,
    onInvalidated: () => () => undefined,
  };
  const url = f.grants.issue(owner, "a".repeat(64), "original");
  const response = await f.handlers[0]!(new Request(url));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
