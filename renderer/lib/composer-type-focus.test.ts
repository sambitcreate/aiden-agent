import assert from "node:assert/strict";
import test from "node:test";
import {
  composerInsertTextFromKey,
  decideComposerTypeFocus,
  type ComposerTypeFocusContext,
} from "./composer-type-focus.js";

const writable: ComposerTypeFocusContext = {
  composerFocused: false,
  composerAvailable: true,
  composerWritable: true,
  editable: false,
  overlayOpen: false,
  reservedSurface: false,
  composing: false,
  activationControl: false,
};

const key = (value: string, extras: Partial<Parameters<typeof decideComposerTypeFocus>[0]> = {}) =>
  decideComposerTypeFocus(
    {
      key: value,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...extras,
    },
    writable,
  );

test("printable characters outside another field focus the composer and insert", () => {
  assert.deepEqual(key("h"), { action: "focus-and-insert", text: "h" });
  assert.deepEqual(key("/"), { action: "focus-and-insert", text: "/" });
  assert.deepEqual(key(" "), { action: "focus-and-insert", text: " " });
  assert.deepEqual(key("é"), { action: "focus-and-insert", text: "é" });
});

test("navigation, submit, and modifier chords never steal into the composer", () => {
  for (const value of ["Enter", "Tab", "Escape", "Backspace", "ArrowDown", "F5", "Dead", "Meta"]) {
    assert.deepEqual(key(value), { action: "ignore" }, value);
  }
  assert.deepEqual(key("k", { metaKey: true }), { action: "ignore" });
  assert.deepEqual(key("k", { ctrlKey: true }), { action: "ignore" });
  assert.deepEqual(key("k", { altKey: true }), { action: "ignore" });
  assert.deepEqual(key("k", { defaultPrevented: true }), { action: "ignore" });
  assert.deepEqual(key("k", { isComposing: true }), { action: "ignore" });
  assert.deepEqual(key("k", { keyCode: 229 }), { action: "ignore" });
});

test("Space stays with focused buttons while other printable keys still enter the composer", () => {
  assert.deepEqual(
    decideComposerTypeFocus(
      { key: " ", metaKey: false, ctrlKey: false, altKey: false },
      { ...writable, activationControl: true },
    ),
    { action: "ignore" },
  );
  assert.deepEqual(
    decideComposerTypeFocus(
      { key: "a", metaKey: false, ctrlKey: false, altKey: false },
      { ...writable, activationControl: true },
    ),
    { action: "focus-and-insert", text: "a" },
  );
});

test("AltGr printable characters can still type-to-focus", () => {
  assert.deepEqual(key("{", { ctrlKey: true, altKey: true }), {
    action: "focus-and-insert",
    text: "{",
  });
});

test("type-to-focus stays out of overlays, other editors, and an already focused composer", () => {
  assert.deepEqual(
    decideComposerTypeFocus({ key: "a", metaKey: false, ctrlKey: false, altKey: false }, {
      ...writable,
      composerFocused: true,
    }),
    { action: "ignore" },
  );
  assert.deepEqual(
    decideComposerTypeFocus({ key: "a", metaKey: false, ctrlKey: false, altKey: false }, {
      ...writable,
      editable: true,
    }),
    { action: "ignore" },
  );
  assert.deepEqual(
    decideComposerTypeFocus({ key: "a", metaKey: false, ctrlKey: false, altKey: false }, {
      ...writable,
      overlayOpen: true,
    }),
    { action: "ignore" },
  );
  assert.deepEqual(
    decideComposerTypeFocus({ key: "a", metaKey: false, ctrlKey: false, altKey: false }, {
      ...writable,
      reservedSurface: true,
    }),
    { action: "ignore" },
  );
  assert.deepEqual(
    decideComposerTypeFocus({ key: "a", metaKey: false, ctrlKey: false, altKey: false }, {
      ...writable,
      composerAvailable: false,
    }),
    { action: "ignore" },
  );
});

test("a read-only composer still receives focus so the user can see why typing is blocked", () => {
  assert.deepEqual(
    decideComposerTypeFocus({ key: "a", metaKey: false, ctrlKey: false, altKey: false }, {
      ...writable,
      composerWritable: false,
    }),
    { action: "focus" },
  );
});

test("function keys and empty insert text are rejected", () => {
  assert.equal(composerInsertTextFromKey("F12"), null);
  assert.equal(composerInsertTextFromKey("Enter"), null);
  assert.equal(composerInsertTextFromKey("a"), "a");
});
