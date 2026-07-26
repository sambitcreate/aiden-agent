// Source assertions over the Aiden dock's motion, in the style of
// streaming-motion-contract.test.ts: the animation lives in CSS, so the CSS is
// what the test reads.

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

test("the panel rises into place as it fades in", () => {
  const keyframes = between(
    source("../styles.css"),
    "@keyframes aiden-assistant-dock-in",
    "@keyframes aiden-assistant-dock-out",
  );
  assert.match(keyframes, /opacity:\s*0/u);
  assert.match(keyframes, /opacity:\s*1/u);
  // Positive Y start = below its resting place, so it travels upward. The dock
  // is bottom-anchored; a negative offset here would drop it in from above.
  assert.match(keyframes, /translateY\(8px\)/u);
  assert.match(keyframes, /translateY\(0\)/u);
});

test("the panel settles downward as it fades out", () => {
  const keyframes = between(
    source("../styles.css"),
    "@keyframes aiden-assistant-dock-out",
    "@keyframes aiden-assistant-bubble-in",
  );
  assert.match(keyframes, /translateY\(0\)/u);
  assert.match(keyframes, /translateY\(6px\)/u);
  assert.match(keyframes, /opacity:\s*0/u);
});

test("both directions are gated on the app's reduce-motion switch", () => {
  const styles = source("../styles.css");
  assert.match(
    styles,
    /:root\[data-reduce-motion="false"\] \.assistant-dock-panel\[data-state="open"\]/u,
  );
  assert.match(
    styles,
    /:root\[data-reduce-motion="false"\] \.assistant-dock-panel\[data-state="closed"\]/u,
  );
});

test("the panel's exit timeout matches the CSS it waits on", () => {
  const styles = source("../styles.css");
  const rule = between(
    styles,
    ':root[data-reduce-motion="false"] .assistant-dock-panel[data-state="closed"]',
    "}",
  );
  const cssDuration = /(\d+)ms/u.exec(rule)?.[1];
  const dock = source("../components/assistant/assistant-dock.tsx");
  const jsDuration = /const PANEL_EXIT_MS = (\d+);/u.exec(dock)?.[1];
  assert.ok(cssDuration, "no duration in the closed-state rule");
  // Unmounting early truncates the exit; unmounting late leaves a dead panel
  // sitting over the composer. The two values have to move together.
  assert.equal(jsDuration, cssDuration);
});

test("the dock keeps the panel mounted while it animates out", () => {
  const dock = source("../components/assistant/assistant-dock.tsx");
  assert.match(dock, /setTimeout\(\(\) => setPresent\(false\), PANEL_EXIT_MS\)/u);
  // Reduce Motion must skip the wait entirely rather than hold a static panel.
  assert.match(dock, /dataset\.reduceMotion === "true"/u);
});
