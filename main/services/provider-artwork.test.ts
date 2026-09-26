import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("normalized provider icons are validated and oversize stored artwork can be recovered", () => {
  const source = readFileSync(new URL("./provider-artwork.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /nativeImage\.createFromDataURL\(\s*`data:image\/svg\+xml;base64,\$\{Buffer\.from\(source\.safeSvg!, "utf8"\)\.toString\("base64"\)\}`,?\s*\)/u,
  );
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
