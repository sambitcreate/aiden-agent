import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../components/command-palette.tsx", import.meta.url), "utf8");

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing ${start}`);
  assert.notEqual(endIndex, -1, `Missing ${end}`);
  return source.slice(startIndex, endIndex);
}

test("delayed model selection cannot close a later palette session", () => {
  const action = between("const selectModel", "const refreshProviders");
  const closeIndex = action.indexOf("close();");
  const firstAwaitIndex = action.indexOf("await providersApi.list()");
  assert.ok(closeIndex >= 0 && closeIndex < firstAwaitIndex);
  assert.equal(action.match(/\bclose\(\);/gu)?.length, 1);
  assert.match(action, /selectionRevision !== readModelSelectionRevision\(\)/u);
});

test("delayed appearance persistence cannot close a later palette session", () => {
  const action = between("const setAppearance", "return (");
  const closeIndex = action.indexOf("close();");
  const firstAwaitIndex = action.indexOf("await settingsApi.get()");
  assert.ok(closeIndex >= 0 && closeIndex < firstAwaitIndex);
  assert.equal(action.match(/\bclose\(\);/gu)?.length, 1);
  assert.ok(
    (action.match(/if \(!isCurrent\(\)\) return;/gu)?.length ?? 0) >= 6,
    "success and rollback continuations must both retain intent ownership",
  );
});

test("current model and appearance values are exposed to assistive technology", () => {
  assert.match(source, /aria-current=\{selected \? "true" : undefined\}/u);
  assert.match(source, /aria-current=\{appearanceMode === item\.mode \? "true" : undefined\}/u);
  assert.ok((source.match(/<span className="sr-only">Current<\/span>/gu)?.length ?? 0) >= 2);
});

test("dynamic command registration invalidates palette availability", () => {
  const commandSystem = readFileSync(new URL("./command-system.tsx", import.meta.url), "utf8");
  assert.match(commandSystem, /const \[handlerRevision, setHandlerRevision\]/u);
  assert.ok((commandSystem.match(/setHandlerRevision\(\(.*?\) => .*? \+ 1\)/gu)?.length ?? 0) >= 2);
  assert.match(commandSystem, /handlerRevision,/u);
});

test("command palette uses spacing instead of separator rules", () => {
  assert.doesNotMatch(source, /CommandSeparator/u);
  assert.doesNotMatch(source, /border-b border-separator/u);
  assert.doesNotMatch(source, /border-t border-separator/u);
  assert.match(source, /showSeparator=\{false\}/u);
  assert.match(source, /cmdk-item\]\[data-selected=true\].*bg-control/u);
  assert.doesNotMatch(source, /↑↓ Navigate|↩ Run|Local app actions/u);
});
