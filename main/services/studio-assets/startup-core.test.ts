import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { StudioAssetGrants } from "./delivery-core.js";
import { installStudioAssetProtocol, startStudioAssets } from "./startup-core.js";
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
    owner: {
      id: 1,
      documentId: "1:1:main",
      isDestroyed: () => false,
      onInvalidated: () => () => undefined,
    },
    parent,
    root,
    store,
    grants,
    handlers,
    errors,
    rootResolved: () => rootResolved,
    install: (enabled: boolean) =>
      installStudioAssetProtocol({
        enabled,
        store,
        grants,
        registerProtocol: (handler) => handlers.push(handler),
      }),
    start: (enabled: boolean) =>
      startStudioAssets({ enabled, store, onError: (error) => errors.push(error) }),
  };
}

test("with the studio flags off nothing is registered and no files are created", async (t) => {
  const f = await setup(t);
  assert.equal(f.install(false), false);
  assert.equal(await f.start(false), false);
  assert.equal(f.handlers.length, 0);
  assert.equal(f.rootResolved(), false);
  assert.deepEqual(await fs.readdir(f.parent), []);
  // Shutdown of a never-opened store is a no-op.
  await f.store.close();
});

test("the handler installs before the store opens and serves granted assets once it has", async (t) => {
  const f = await setup(t);
  // Installed synchronously at window creation, ahead of the reconcile chain:
  // no store file yet, and a request without a grant fails closed.
  assert.equal(f.install(true), true);
  assert.equal(f.handlers.length, 1);
  assert.equal(f.rootResolved(), false);
  const early = await f.handlers[0]!(new Request(`aiden-asset://grant/${"A".repeat(43)}`));
  assert.equal(early.status, 404);

  assert.equal(await f.start(true), true);
  const db = await fs.stat(path.join(f.root, "assets-v1.sqlite"));
  assert.ok(db.isFile());
  // The same early handler now reads the opened store.
  const asset = await f.store.put({ bytes: pngBytes(8, 8, 9) });
  const original = await f.handlers[0]!(new Request(f.grants.issue(f.owner, asset.assetId, "original")));
  assert.equal(original.status, 200);
  assert.equal(original.headers.get("content-type"), "image/png");
  const thumb = await f.handlers[0]!(new Request(f.grants.issue(f.owner, asset.assetId, "thumb-512")));
  assert.equal(thumb.status, 200);
  assert.ok((await thumb.arrayBuffer()).byteLength > 0);
});

test("when the store cannot open the installed handler answers 503", async (t) => {
  const f = await setup(t);
  f.install(true);
  // A file where the store root belongs makes the directory creation fail.
  await fs.writeFile(f.root, "not a directory");
  assert.equal(await f.start(true), false);
  assert.equal(f.errors.length, 1);
  assert.equal(f.store.status(), "failed");
  const url = f.grants.issue(f.owner, "a".repeat(64), "original");
  const response = await f.handlers[0]!(new Request(url));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
