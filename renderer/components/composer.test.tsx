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

test("chat surfaces share the responsive centered chat-column contract", () => {
  const composer = source("./composer.tsx");
  const messages = source("./message-list.tsx");
  const chatPane = source("../main/chat-pane.tsx");
  const styles = source("../styles.css");

  for (const surface of [composer, messages, chatPane]) {
    assert.match(surface, /aiden-dock-inset chat-content-column/u);
    assert.doesNotMatch(surface, /max-w-3xl/u);
  }

  assert.match(styles, /--chat-content-max-width:\s*52rem;/u);
  assert.match(
    styles,
    /\.chat-content-column\s*\{[\s\S]*width:\s*100%;[\s\S]*max-width:\s*var\(--chat-content-max-width\);[\s\S]*margin-inline:\s*auto;/u,
  );
  assert.match(
    styles,
    /\.aiden-dock-inset\s*\{\s*padding-inline:\s*var\(--aiden-dock-gutter\);\s*\}/u,
  );
});
