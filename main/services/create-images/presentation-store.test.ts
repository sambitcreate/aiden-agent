import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CreateImagesPresentationStore } from "./presentation-store.js";

const firstAsset = "a".repeat(64);
const secondAsset = "b".repeat(64);

test("gallery presentation hiding survives restart and never stores image data", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-presentation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CreateImagesPresentationStore(root);
  assert.deepEqual(await store.setAssetHidden("workflow-1", secondAsset, true), [secondAsset]);
  assert.deepEqual(await store.setAssetHidden("workflow-1", firstAsset, true), [firstAsset, secondAsset]);
  assert.deepEqual(await new CreateImagesPresentationStore(root).hiddenAssetIds("workflow-1"), [
    firstAsset,
    secondAsset,
  ]);
  const persisted = await fs.readFile(path.join(root, "presentation.json"), "utf8");
  assert.doesNotMatch(persisted, /data:image|prompt|path|credential/u);
  assert.deepEqual(await store.setAssetHidden("workflow-1", firstAsset, false), [secondAsset]);
});

test("corrupt presentation data fails closed without touching the source file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-presentation-corrupt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "presentation.json");
  await fs.writeFile(file, "not-json", "utf8");
  const store = new CreateImagesPresentationStore(root);
  assert.deepEqual(await store.hiddenAssetIds("workflow-1"), []);
  assert.equal(await fs.readFile(file, "utf8"), "not-json");
});
