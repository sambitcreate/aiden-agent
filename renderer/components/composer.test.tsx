import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("composer focus tints the whole shell, not only the textarea", () => {
  const composer = source("./composer.tsx");
  const styles = source("../styles.css");
  assert.match(composer, /composer-shell/u);
  assert.match(
    composer,
    /className="max-h-48 border-0 bg-transparent px-1\.5 outline-none hover:border-transparent focus:border-transparent focus:bg-transparent"/u,
  );
  assert.match(
    styles,
    /\.composer-shell:focus-within\s*\{[\s\S]*color-mix\(in srgb, var\(--surface-popover\) 98%, var\(--text-primary\)\)/u,
  );
  assert.match(
    styles,
    /:root :where\(\*\):focus,\s*:root :where\(\*\):focus-visible\s*\{\s*outline: none !important;\s*\}/u,
  );
});
