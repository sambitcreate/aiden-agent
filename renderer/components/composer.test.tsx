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

test("composer slash palette is an overlaid textarea-owned accessible listbox", () => {
  const composer = source("./composer.tsx");
  const palette = source("./composer-slash-palette.tsx");
  const styles = source("../styles.css");

  assert.match(composer, /aria-autocomplete=\{slashSession \? "list" : undefined\}/u);
  assert.match(
    composer,
    /aria-activedescendant=\{slashSession \? effectiveActiveSlashId : undefined\}/u,
  );
  assert.doesNotMatch(composer, /aria-expanded=/u);
  assert.match(composer, /if \(slashPaletteBlocked\) dismissSlash\(\)/u);
  assert.match(composer, /event\.key === "Escape"/u);
  assert.match(composer, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/u);
  assert.match(composer, /event\.key === "PageDown"/u);
  assert.match(composer, /event\.key === "Home"/u);
  assert.match(palette, /role="listbox"/u);
  assert.match(palette, /role="group"/u);
  assert.match(palette, /role="option"/u);
  assert.match(palette, /aria-live="polite"/u);
  assert.match(palette, /absolute inset-x-3 bottom-full/u);
  assert.match(palette, /onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/u);
  assert.match(palette, /motion-reduce:animate-none/u);
  assert.match(palette, /data-presence=\{presenceState\}/u);
  assert.match(styles, /@keyframes aiden-slash-palette-in/u);
  assert.match(styles, /@keyframes aiden-slash-palette-out/u);
  assert.match(styles, /aiden-slash-palette-out 100ms ease-in/u);
  const attemptIndex = composer.indexOf("const attempted = attemptSlashCommandAction");
  const completionIndex = composer.indexOf(
    "const attempt = asyncAction ? await attempted.completion : attempted",
  );
  const handledIndex = composer.indexOf("if (!attempt.handled)");
  const commitIndex = composer.indexOf("setText(nextText)");
  for (const index of [attemptIndex, completionIndex, handledIndex, commitIndex]) {
    assert.notEqual(index, -1, "The slash action commit contract must remain present.");
  }
  assert.ok(
    attemptIndex < completionIndex && completionIndex < handledIndex && handledIndex < commitIndex,
    "The draft token must only be consumed after successful sync or async action completion.",
  );
  assert.match(composer, /const attempt = asyncAction \? await attempted\.completion : attempted/u);
  assert.match(composer, /asyncAction &&\s*!slashActionCommitIsCurrent\(expectedCommit/u);
  assert.match(composer, /React\.useLayoutEffect\(\(\) => \{[\s\S]*slashPaletteBlockedRef/u);
  assert.match(composer, /slashTabAcceptsSelection\([\s\S]*slashActionPendingRef\.current/u);
});
