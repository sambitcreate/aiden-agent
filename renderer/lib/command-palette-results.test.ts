import assert from "node:assert/strict";
import test from "node:test";
import { paletteResult, rankPaletteResults, reconcilePaletteResult } from "./command-palette-results";

const row = (identity: string, title: string, keywords: string[] = []) => ({
  result: paletteResult(identity, title, keywords),
});

test("rows rank by match and keep their highlight; forced rows stay unhighlighted", () => {
  const retry = { result: paletteResult("retry", "Models could not be loaded", [], { forceMount: true }) };
  const shown = rankPaletteResults(
    [row("a", "Open folder…"), retry, row("b", "Folder settings"), row("c", "Clone", ["folder"])],
    "folder",
  );
  assert.deepEqual(shown.map(({ result }) => result.identity), ["retry", "b", "a", "c"]);
  assert.deepEqual(shown.map(({ ranges }) => ranges), [
    [],
    [{ start: 0, end: 6 }],
    [{ start: 5, end: 11 }],
    [],
  ]);
});

test("selection survives a rename and reordering through the stable identity", () => {
  const first = paletteResult("chat:first", "Repeated title");
  const renamed = paletteResult("chat:second", "Repeated title renamed");
  assert.equal(reconcilePaletteResult("chat:second", [first, renamed]), "chat:second");
});

test("a selection that disappears falls back to the first visible row", () => {
  const remaining = paletteResult("chat:first", "apple");
  const other = paletteResult("chat:third", "apple pie");
  assert.equal(reconcilePaletteResult("chat:second", [remaining, other]), "chat:first");
  assert.equal(reconcilePaletteResult("chat:second", []), "");
});

test("disabled rows are never selected and retries only when nothing else is enabled", () => {
  const disabled = paletteResult("refresh", "Refresh providers", [], { disabled: true });
  const provider = paletteResult("provider:one", "Local provider");
  const retry = paletteResult("retry", "Retry loading providers", [], { forceMount: true });
  const loading = paletteResult("loading", "Loading providers", [], { disabled: true, forceMount: true });
  assert.equal(reconcilePaletteResult("refresh", [disabled, provider]), "provider:one");
  assert.equal(reconcilePaletteResult("retry", [retry, disabled, provider]), "provider:one");
  assert.equal(reconcilePaletteResult("provider:one", [retry, loading, disabled]), "retry");
  assert.equal(reconcilePaletteResult("retry", [loading, disabled]), "");
});
