import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_ASSET_STORE_LIMITS } from "./asset-store-core.js";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("untrusted image codecs run in a disposable sandboxed renderer", () => {
  const adapter = source("./electron-asset-images.ts");
  const decoder = source("./electron-asset-image-utility.ts");
  const preload = source("../../../renderer/preload-create-images-image-decoder.ts");
  const build = source("../../../scripts/build-electron.mjs");

  assert.doesNotMatch(adapter, /nativeImage/u);
  assert.match(decoder, /new BrowserWindow/u);
  assert.match(decoder, /sandbox: true/u);
  assert.match(decoder, /contextIsolation: true/u);
  assert.match(decoder, /nodeIntegration: false/u);
  assert.match(decoder, /default-src 'none'/u);
  assert.match(decoder, /readRegularFile\(request\.filePath, maxInputBytes\)/u);
  assert.match(preload, /createImageBitmap/u);
  assert.match(preload, /OffscreenCanvas/u);
  assert.match(preload, /operation === "normalize"/u);
  assert.match(preload, /bitmap\.width \* bitmap\.height > request\.maxPixels/u);
  assert.match(preload, /convertToBlob\(\{ type: "image\/png" \}\)/u);
  assert.match(decoder, /operation: "normalize" \| "thumbnail" \| "validate"/u);
  assert.match(decoder, /maxPixels/u);
  assert.match(build, /preload-create-images-image-decoder\.ts/u);
  assert.equal(DEFAULT_ASSET_STORE_LIMITS.maxPixels, 16_000_000);
});

test("asset reads allocate through a maxBytes plus one descriptor loop", () => {
  const assetStore = source("./asset-store-core.ts");
  const helper = assetStore.match(
    /async function readBoundedRegularFile[\s\S]*?\n\}\n\nasync function syncDirectory/u,
  )?.[0];
  assert.ok(helper);
  assert.match(helper, /maxBytes \+ 1 - total/u);
  assert.match(helper, /if \(total > maxBytes\)/u);
  assert.doesNotMatch(helper, /handle\.readFile/u);
});
