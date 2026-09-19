import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { filterPaletteResult, paletteResult, reconcilePaletteResult, staticPaletteResult } from "./command-palette-results";

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

test("metadata updates preserve the selected record even when results reorder", () => {
  const first = paletteResult("chat:first", ["Repeated title", "2026"]);
  const second = paletteResult("chat:second", ["Repeated title", "2026"]);
  const renamed = paletteResult("chat:second", ["Repeated title renamed", "2035"]);
  assert.notEqual(first.value, second.value);
  assert.notEqual(second.value, renamed.value);
  assert.equal(reconcilePaletteResult(second.value, [renamed, first], "Repeated"), renamed.value);
  assert.equal(reconcilePaletteResult(second.value, [renamed, first], ""), renamed.value);
  assert.equal(filterPaletteResult(renamed.value, "chat:second", renamed.keywords), 0);
});

test("a selected result excluded by rename or removal falls back to a visible match", () => {
  const previous = paletteResult("chat:second", ["apple"]);
  const renamed = paletteResult("chat:second", ["zebra"]);
  const remaining = paletteResult("chat:first", ["apple"]);
  assert.equal(reconcilePaletteResult(previous.value, [renamed, remaining], "apple"), remaining.value);
  assert.equal(reconcilePaletteResult(previous.value, [remaining], "apple"), remaining.value);
  assert.equal(reconcilePaletteResult(previous.value, [renamed], "apple"), "");
  assert.equal(reconcilePaletteResult("Search chats", [renamed], ""), renamed.value);
});

test("provider and model metadata updates preserve selection through the record ID", () => {
  for (const identity of ["model:second::model", "provider:second", "unavailable-provider:second"]) {
    const previous = paletteResult(identity, ["Old label", "model"]);
    const updated = paletteResult(identity, ["New label", "model"]);
    assert.equal(reconcilePaletteResult(previous.value, [updated], "model"), updated.value);
    assert.equal(filterPaletteResult(updated.value, "Old label", updated.keywords), 0);
    assert.ok(filterPaletteResult(updated.value, "New label", updated.keywords) > 0);
  }
});

test("mode transitions reconcile both stale static and dynamic selections", () => {
  const root = staticPaletteResult("Toggle sidebar");
  const newChat = staticPaletteResult("New chat conversation");
  const model = paletteResult("model:provider::model", ["Model", "Provider"]);
  const refresh = staticPaletteResult("Refresh provider model catalogs update");
  const appearance = staticPaletteResult("Follow macOS appearance theme appearance");
  const destination = staticPaletteResult("Keyboard shortcuts keyboard bindings");
  for (const entry of [newChat, model, refresh, appearance, destination]) {
    assert.equal(reconcilePaletteResult(root.value, [entry], ""), entry.value);
    assert.equal(reconcilePaletteResult(entry.value, [root], ""), root.value);
    assert.equal(reconcilePaletteResult(entry.value, [entry], ""), entry.value);
  }
  assert.equal(reconcilePaletteResult("", [root], ""), root.value);
});

test("selection excludes disabled or hidden results and respects force-mounted retry actions", () => {
  const disabled = staticPaletteResult("Refresh providers", { disabled: true });
  const root = staticPaletteResult("Toggle sidebar");
  const retry = staticPaletteResult("Retry loading models", { forceMount: true });
  const loading = staticPaletteResult("Loading models", { disabled: true, forceMount: true });
  assert.equal(reconcilePaletteResult(disabled.value, [disabled, root], ""), root.value);
  assert.equal(reconcilePaletteResult(root.value, [disabled], ""), "");
  assert.equal(reconcilePaletteResult(root.value, [root], "zzq-no-match"), "");
  assert.equal(reconcilePaletteResult(root.value, [], ""), "");
  assert.equal(reconcilePaletteResult(root.value, [loading], "zzq-no-match"), "");
  assert.equal(reconcilePaletteResult(root.value, [retry], "zzq-no-match"), retry.value);
  assert.equal(reconcilePaletteResult(root.value, [disabled, loading, retry], ""), retry.value);
});

test("ordinary enabled matches take precedence over selected forced retries", () => {
  const retry = staticPaletteResult("Retry loading providers", { forceMount: true });
  const refresh = staticPaletteResult("Refresh provider model catalogs update");
  const provider = paletteResult("provider:one", ["Local provider"]);
  const loading = staticPaletteResult("Loading providers", { disabled: true, forceMount: true });
  const results = [retry, loading, refresh, provider];
  assert.equal(reconcilePaletteResult(retry.value, results, "Refresh"), refresh.value);
  assert.equal(reconcilePaletteResult(retry.value, results, "Local"), provider.value);
  assert.equal(reconcilePaletteResult(retry.value, results, ""), refresh.value);
  assert.equal(reconcilePaletteResult(retry.value, results, "Retry"), retry.value);
  assert.equal(reconcilePaletteResult(refresh.value, results, "zzq-no-match"), retry.value);
  assert.equal(reconcilePaletteResult(retry.value, [retry, { ...refresh, disabled: true }], "Refresh"), retry.value);
  assert.equal(reconcilePaletteResult(retry.value, [loading, { ...refresh, disabled: true }], "Refresh"), "");
  // Within ordinary matches, preserve a selected record through metadata changes.
  const renamed = paletteResult(provider.identity, ["Local provider renamed"]);
  assert.equal(reconcilePaletteResult(provider.value, [retry, refresh, renamed], "provider"), renamed.value);
});

test("every mode uses retries only when ordinary enabled matches are absent", () => {
  for (const [mode, ordinary, hasRetry] of [
    ["root", staticPaletteResult("Toggle sidebar"), false],
    ["chats", staticPaletteResult("New chat conversation"), true],
    ["models", paletteResult("model:one", ["Local model"]), true],
    ["providers", staticPaletteResult("Refresh provider catalogs"), true],
    ["settings", staticPaletteResult("Use dark appearance"), false],
  ] as const) {
    const retry = staticPaletteResult(`Retry loading ${mode}`, { forceMount: true });
    const loading = staticPaletteResult(`Loading ${mode}`, { forceMount: true, disabled: true });
    const fallback = hasRetry ? [retry] : [];
    const results = [...fallback, loading, ordinary];
    assert.equal(reconcilePaletteResult(retry.value, results, ordinary.keywords[0]), ordinary.value, mode);
    assert.equal(reconcilePaletteResult(retry.value, results, ""), ordinary.value, mode);
    assert.equal(reconcilePaletteResult(ordinary.value, results, "zzq-no-match"), hasRetry ? retry.value : "", mode);
    assert.equal(reconcilePaletteResult(ordinary.value, [...fallback, loading, { ...ordinary, disabled: true }], ""), hasRetry ? retry.value : "", mode);
    assert.equal(reconcilePaletteResult(retry.value, [loading], ""), "", mode);
  }
});
