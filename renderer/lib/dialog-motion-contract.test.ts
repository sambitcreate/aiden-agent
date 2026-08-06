import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing ${start}`);
  assert.notEqual(endIndex, -1, `Missing ${end}`);
  return value.slice(startIndex, endIndex);
}

test("dialogs fade and scale from ninety percent without changing their position", () => {
  const styles = source("../styles.css");
  const entrance = between(styles, "@keyframes aiden-dialog-in", "@keyframes aiden-dialog-out");
  const exit = between(styles, "@keyframes aiden-dialog-out", "@keyframes aiden-overlay-in");

  assert.match(entrance, /opacity:\s*0/u);
  assert.match(entrance, /opacity:\s*1/u);
  assert.match(entrance, /scale:\s*0\.9/u);
  assert.match(entrance, /scale:\s*1/u);
  assert.doesNotMatch(entrance, /\b(?:transform|translate)\s*:/u);

  assert.match(exit, /opacity:\s*0/u);
  assert.match(exit, /scale:\s*0\.9/u);
  assert.doesNotMatch(exit, /\b(?:transform|translate)\s*:/u);
});

test("every application-modal overlay stays transparent and unblurred", () => {
  const sharedUi = source("../components/ui.tsx");
  const commandPalette = source("../components/command-palette.tsx");
  const sharedOverlays = [
    ...sharedUi.matchAll(/<(?:DialogPrimitive|AlertDialogPrimitive)\.Overlay[\s\S]*?\/>/gu),
  ].map((match) => match[0]);
  const commandPaletteOverlays = [
    ...commandPalette.matchAll(/<DialogPrimitive\.Overlay[\s\S]*?\/>/gu),
  ].map((match) => match[0]);

  assert.equal(sharedOverlays.length, 2);
  assert.equal(commandPaletteOverlays.length, 1);
  assert.match(sharedUi, /layer === "onboarding" \? "z-\[70\]" : "z-50"/u);
  for (const overlay of [...sharedOverlays, ...commandPaletteOverlays]) {
    assert.match(overlay, /bg-transparent/u);
    assert.doesNotMatch(overlay, /backdrop-blur|bg-black\//u);
  }

  for (const component of [sharedUi, commandPalette]) {
    assert.doesNotMatch(
      component,
      /data-slot="dialog-overlay"[\s\S]{0,160}(?:backdrop-blur|bg-black\/)/u,
    );
  }
});

test("strong elevation stays modal-only while Environment keeps the original dialog shadow", () => {
  const styles = source("../styles.css");
  const sharedUi = source("../components/ui.tsx");
  const commandPalette = source("../components/command-palette.tsx");
  const environment = source("../components/environment-panel.tsx");

  assert.match(
    styles,
    /:root\[data-reduce-motion="false"\] \[data-slot="dialog-content"\]\[data-state="open"\] \{\s*animation: aiden-dialog-in 10ms cubic-bezier\(0, 0, 0\.2, 1\);/u,
  );
  assert.match(
    styles,
    /--elevation-dialog:\s*0 0 0 0\.5px rgb\(0 0 0 \/ 0\.14\), 0 16px 32px -8px rgb\(0 0 0 \/ 0\.3\)/u,
  );
  assert.match(
    styles,
    /--elevation-dialog:\s*0 0 0 0\.5px rgb\(255 255 255 \/ 0\.14\), 0 16px 32px -8px rgb\(0 0 0 \/ 0\.72\)/u,
  );
  assert.match(
    styles,
    /--elevation-modal:\s*0 0 0 0\.5px rgb\(0 0 0 \/ 0\.16\), 0 20px 44px -10px rgb\(0 0 0 \/ 0\.38\)/u,
  );
  assert.match(
    styles,
    /--elevation-modal:\s*0 0 0 0\.5px rgb\(255 255 255 \/ 0\.16\), 0 22px 48px -10px rgb\(0 0 0 \/ 0\.78\)/u,
  );
  assert.equal(sharedUi.match(/shadow-modal/gu)?.length, 2);
  assert.equal(commandPalette.match(/shadow-modal/gu)?.length, 1);
  assert.match(environment, /environment-summary-card[\s\S]{0,300}shadow-dialog/u);
  assert.doesNotMatch(environment, /environment-summary-card[\s\S]{0,300}shadow-modal/u);
  assert.match(
    styles,
    /:root\[data-reduce-motion="false"\] \[data-slot="dialog-content"\]\[data-state="open"\]/u,
  );
  assert.match(
    styles,
    /:root\[data-reduce-motion="false"\] \[data-slot="dialog-content"\]\[data-state="closed"\]/u,
  );
});
