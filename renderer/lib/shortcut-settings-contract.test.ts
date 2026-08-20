import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../components/settings/shortcut-settings.tsx", import.meta.url),
  "utf8",
);

test("moving focus away cancels the active shortcut recorder", () => {
  assert.match(source, /onBlur=\{\(\) => \{\s*if \(recording\) onCancelRecord\(\)/u);
});

test("unmounting the settings page asks main to release recorder suspension", () => {
  assert.match(
    source,
    /React\.useEffect\(\s*\(\) => \(\) => \{\s*void shortcutApi\.setRecording\(false\)/u,
  );
});

test("feature-gated Create Images shortcuts stay out of Settings while disabled", () => {
  assert.match(source, /const \{ createImages \} = useAppCapabilities\(\)/u);
  assert.match(source, /command\.id !== "images\.open" \|\| createImages/u);
});
