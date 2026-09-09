import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("normalized provider icons are encoded at 1x so the display validator keeps them", () => {
  const source = readFileSync(new URL("./provider-artwork.ts", import.meta.url), "utf8");
  assert.match(source, /const PIXEL_SCALE = 1 as const/u);
  assert.match(source, /nativeImage\.createFromBuffer\(source\.bytes, \{ scaleFactor: PIXEL_SCALE \}\)/u);
  assert.match(
    source,
    /nativeImage\.createFromDataURL\(\s*`data:image\/svg\+xml;base64,\$\{Buffer\.from\(source\.safeSvg!, "utf8"\)\.toString\("base64"\)\}`,?\s*\)/u,
  );
  assert.match(source, /image\.getSize\(PIXEL_SCALE\)/u);
  assert.match(source, /normalized\.toPNG\(\{ scaleFactor: PIXEL_SCALE \}\)/u);
  assert.match(source, /if \(!normalizeProviderArtwork\(artwork\)\)/u);
  assert.match(
    source,
    /persistStoredProviderArtwork\(value, \(input\) => normalizeProviderArtworkInput\(input\)\)/u,
  );
});

test("provider saves persist recovered artwork instead of dropping oversize icons", () => {
  const source = readFileSync(new URL("../handlers/providers.ts", import.meta.url), "utf8");
  assert.match(source, /artwork: persistableProviderArtwork\(p\.artwork\)/u);
  assert.doesNotMatch(source, /artwork:\s*normalizeProviderArtwork\(p\.artwork\)/u);
});
