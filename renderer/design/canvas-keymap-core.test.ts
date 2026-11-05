import assert from "node:assert/strict";
import test from "node:test";
import { resolveCanvasKey, type CanvasKeyEvent } from "../canvas/canvas-keymap-core";
import { resolveDesignCanvasKey } from "./canvas-keymap-core";

const key = (code: string, overrides: Partial<CanvasKeyEvent> = {}): CanvasKeyEvent => ({
  key: code.replace(/^Key|^Digit/u, "").toLowerCase(),
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  ...overrides,
});
const mac = { editable: false, platform: "darwin" } as const;
const other = { editable: false, platform: "other" } as const;

test("Command chords undo, redo and duplicate on a Mac", () => {
  assert.deepEqual(resolveDesignCanvasKey(key("KeyZ", { metaKey: true }), mac), { type: "undo" });
  assert.deepEqual(resolveDesignCanvasKey(key("KeyZ", { metaKey: true, shiftKey: true }), mac), { type: "redo" });
  assert.deepEqual(resolveDesignCanvasKey(key("KeyD", { metaKey: true }), mac), { type: "duplicate" });
  assert.equal(resolveDesignCanvasKey(key("KeyZ", { ctrlKey: true }), mac), null, "Control is not Command on a Mac");
  assert.equal(resolveDesignCanvasKey(key("KeyZ", { metaKey: true, altKey: true }), mac), null);
});

test("Control replaces Command elsewhere", () => {
  assert.deepEqual(resolveDesignCanvasKey(key("KeyZ", { ctrlKey: true }), other), { type: "undo" });
  assert.deepEqual(resolveDesignCanvasKey(key("KeyZ", { ctrlKey: true, shiftKey: true }), other), { type: "redo" });
  assert.deepEqual(resolveDesignCanvasKey(key("KeyD", { ctrlKey: true }), other), { type: "duplicate" });
  assert.equal(resolveDesignCanvasKey(key("KeyZ", { metaKey: true }), other), null);
});

test("unmodified keys delete, fit the selection, escape and enter", () => {
  assert.deepEqual(resolveDesignCanvasKey(key("Backspace", { key: "Backspace" }), mac), { type: "delete" });
  assert.deepEqual(resolveDesignCanvasKey(key("Delete", { key: "Delete" }), other), { type: "delete" });
  assert.deepEqual(resolveDesignCanvasKey(key("Digit2", { shiftKey: true, key: "@" }), mac), { type: "fitSelection" });
  assert.deepEqual(resolveDesignCanvasKey(key("Escape", { key: "Escape" }), mac), { type: "escape" });
  assert.deepEqual(resolveDesignCanvasKey(key("Enter", { key: "Enter" }), mac), { type: "enter" });
  assert.deepEqual(resolveDesignCanvasKey(key("NumpadEnter", { key: "Enter" }), other), { type: "enter" });
  assert.equal(resolveDesignCanvasKey(key("Enter", { key: "Enter", shiftKey: true }), mac), null);
  assert.equal(resolveDesignCanvasKey(key("Enter", { key: "Enter", repeat: true }), mac), null);
  assert.equal(resolveDesignCanvasKey(key("Backspace", { key: "Backspace", metaKey: true }), mac), null);
});

test("F2 renames the selected frame and N adds a note, but not with a modifier or held down", () => {
  assert.deepEqual(resolveDesignCanvasKey(key("F2", { key: "F2" }), mac), { type: "rename" });
  assert.deepEqual(resolveDesignCanvasKey(key("KeyN"), other), { type: "addNote" });
  assert.equal(resolveDesignCanvasKey(key("KeyN", { shiftKey: true, key: "N" }), mac), null);
  assert.equal(resolveDesignCanvasKey(key("KeyN", { repeat: true }), mac), null);
  assert.equal(resolveDesignCanvasKey(key("KeyN", { metaKey: true }), mac), null, "Command-N stays the app's new chat");
  assert.equal(resolveDesignCanvasKey(key("KeyN"), { editable: true, platform: "darwin" }), null, "typing n in a note");
});

test("inside a text field every design key is left to the field, so Command-Z undoes typing", () => {
  const editable = { editable: true, platform: "darwin" } as const;
  for (const event of [
    key("KeyZ", { metaKey: true }),
    key("KeyZ", { metaKey: true, shiftKey: true }),
    key("KeyD", { metaKey: true }),
    key("Backspace", { key: "Backspace" }),
    key("Delete", { key: "Delete" }),
    key("Digit2", { shiftKey: true, key: "@" }),
    key("Escape", { key: "Escape" }),
    key("KeyV"),
  ]) {
    assert.equal(resolveDesignCanvasKey(event, editable), null, event.code);
  }
});

test("while composing text nothing resolves", () => {
  assert.equal(resolveDesignCanvasKey(key("KeyZ", { metaKey: true, isComposing: true }), mac), null);
  assert.equal(resolveDesignCanvasKey(key("Backspace", { key: "Backspace", isComposing: true }), mac), null);
});

test("the shared canvas keys still resolve as they do on every canvas", () => {
  const shared = [
    key("KeyV"),
    key("KeyH"),
    key("Equal", { key: "=" }),
    key("Minus", { key: "-" }),
    key("Digit0", { shiftKey: true, key: ")" }),
    key("Digit1", { shiftKey: true, key: "!" }),
    key("KeyM"),
  ];
  for (const event of shared) {
    const expected = resolveCanvasKey(event, { editable: false });
    assert.notEqual(expected, null, event.code);
    assert.deepEqual(resolveDesignCanvasKey(event, mac), expected, event.code);
  }
});
