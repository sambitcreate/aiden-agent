import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalShouldTakeFocus,
  composerInsertTextFromKey,
  decideComposerTypeFocus,
  escapeStopsGeneration,
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
  assert.deepEqual(
    decideComposerTypeFocus(
      { key: "@", metaKey: false, ctrlKey: true, altKey: true, altGraph: true },
      { ...writable, macOS: true },
    ),
    { action: "focus-and-insert", text: "@" },
  );
});

test("Control+Option chords on macOS stay with the command system", () => {
  assert.deepEqual(
    decideComposerTypeFocus(
      { key: "k", metaKey: false, ctrlKey: true, altKey: true },
      { ...writable, macOS: true },
    ),
    { action: "ignore" },
  );
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

test("a new approval takes focus only when the user is not typing or in an overlay", () => {
  assert.equal(approvalShouldTakeFocus({ typing: false, overlayOpen: false }), true);
  // Mid-typing in the composer: a Space or Enter must not land on Deny.
  assert.equal(approvalShouldTakeFocus({ typing: true, overlayOpen: false }), false);
  assert.equal(approvalShouldTakeFocus({ typing: false, overlayOpen: true }), false);
});

test("Escape stops a running response only from an empty composer", () => {
  const running = { key: "Escape", canStop: true, draftEmpty: true };
  assert.equal(escapeStopsGeneration(running), true);
  // A draft is in progress: Escape must not throw away the running response.
  assert.equal(escapeStopsGeneration({ ...running, draftEmpty: false }), false);
  // Nothing to stop, or Stop is not available yet.
  assert.equal(escapeStopsGeneration({ ...running, canStop: false }), false);
  // A palette or menu already consumed Escape, or IME composition is cancelling.
  assert.equal(escapeStopsGeneration({ ...running, defaultPrevented: true }), false);
  assert.equal(escapeStopsGeneration({ ...running, isComposing: true }), false);
  // Holding the key must not keep firing Stop.
  assert.equal(escapeStopsGeneration({ ...running, repeat: true }), false);
  assert.equal(escapeStopsGeneration({ ...running, key: "Enter" }), false);
});
