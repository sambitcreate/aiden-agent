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

test("text-entry focus uses fill without an accent border or ring", () => {
  const ui = source("../components/ui.tsx");
  const input = between(ui, "export const Input =", "type TextareaProps");
  const textarea = between(ui, "export const Textarea =", "type TextProps");

  for (const control of [input, textarea]) {
    assert.match(control, /focus:bg-input/u);
    assert.doesNotMatch(control, /focus(?:-visible)?:border-focus-ring/u);
    assert.doesNotMatch(control, /focus(?:-visible)?:ring-/u);
  }
});

test("search and shortcut text-entry wrappers do not recolor their border on focus", () => {
  for (const relativePath of [
    "../components/ui.tsx",
    "../main/settings-view.tsx",
    "../components/settings/web-search-settings.tsx",
    "../components/settings/shortcut-settings.tsx",
  ]) {
    assert.doesNotMatch(source(relativePath), /focus-within:border-focus-ring/u, relativePath);
  }
});

test("Appearance text fields retain their resting border while focused", () => {
  const styles = source("../styles.css");
  const colorControlFocus = between(styles, ".appearance-color-control:focus-within {", "}");
  const numberControlFocus = between(
    styles,
    ".appearance-number-control input:focus-visible {",
    "}",
  );

  for (const control of [colorControlFocus, numberControlFocus]) {
    assert.match(control, /background: var\(--surface-input\)/u);
    assert.doesNotMatch(control, /border|outline|box-shadow/u);
  }
});
