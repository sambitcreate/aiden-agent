import assert from "node:assert/strict";
import test from "node:test";
import {
  PREFERRED_EDITOR_STORAGE_KEY,
  persistPreferredEditorId,
  readPreferredEditorId,
  resolvePreferredEditorId,
} from "./editor-preference.js";

test("uses the stored editor when it is still installed", () => {
  const editors = [{ id: "cursor" }, { id: "finder" }];
  assert.equal(resolvePreferredEditorId(editors, "finder"), "finder");
});

test("falls back to the first installed editor when the preference disappeared", () => {
  const editors = [{ id: "vscode" }, { id: "finder" }];
  assert.equal(resolvePreferredEditorId(editors, "cursor"), "vscode");
  assert.equal(resolvePreferredEditorId([{ id: "finder" }], "cursor"), "finder");
  assert.equal(resolvePreferredEditorId([], "cursor"), null);
});

test("reads and writes the global preference key", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };

  persistPreferredEditorId("zed", storage);
  assert.equal(values.get(PREFERRED_EDITOR_STORAGE_KEY), "zed");
  assert.equal(readPreferredEditorId(storage), "zed");
});
