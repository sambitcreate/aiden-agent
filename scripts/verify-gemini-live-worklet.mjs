import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const assetsDirectory = resolve(import.meta.dirname, "../build/renderer/assets");
const assets = await readdir(assetsDirectory);
const workletAsset = assets.find((name) => /^gemini-live-pcm-worklet-.*\.js$/u.test(name));

assert.ok(
  workletAsset,
  "Gemini Live AudioWorklet must be emitted as a same-origin production asset.",
);

for (const name of assets.filter((asset) => asset.endsWith(".js"))) {
  const source = await readFile(resolve(assetsDirectory, name), "utf8");
  assert.equal(
    source.includes("data:text/javascript"),
    false,
    `Production bundle ${name} must not inline an AudioWorklet as a CSP-blocked data URL.`,
  );
}
