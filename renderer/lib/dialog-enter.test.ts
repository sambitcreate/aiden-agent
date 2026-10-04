import assert from "node:assert/strict";
import test from "node:test";
import { shouldSubmitDialogOnEnter, type DialogEnterKey, type DialogEnterTarget } from "./dialog-enter.js";

const enter: DialogEnterKey = {
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  defaultPrevented: false,
};
const textInput: DialogEnterTarget = { tagName: "INPUT", type: "text", inForm: false };
const textarea: DialogEnterTarget = { tagName: "TEXTAREA", inForm: false };
const button: DialogEnterTarget = { tagName: "BUTTON", inForm: false };

test("plain Enter confirms from single-line text fields only", () => {
  assert.equal(shouldSubmitDialogOnEnter(enter, textInput), true);
  assert.equal(shouldSubmitDialogOnEnter(enter, { tagName: "input", type: "", inForm: false }), true);
  assert.equal(shouldSubmitDialogOnEnter(enter, { ...textInput, type: "url" }), true);
  // Multi-line text keeps Enter for new lines; buttons and toggles keep native activation.
  assert.equal(shouldSubmitDialogOnEnter(enter, textarea), false);
  assert.equal(shouldSubmitDialogOnEnter(enter, button), false);
  assert.equal(shouldSubmitDialogOnEnter(enter, { ...textInput, type: "checkbox" }), false);
});

test("Mod+Enter confirms from multi-line text and other controls", () => {
  assert.equal(shouldSubmitDialogOnEnter({ ...enter, metaKey: true }, textarea), true);
  assert.equal(shouldSubmitDialogOnEnter({ ...enter, ctrlKey: true }, textarea), true);
  assert.equal(shouldSubmitDialogOnEnter({ ...enter, metaKey: true }, button), true);
});

test("Enter is left to IME composition, comboboxes, forms, and handlers that claimed it", () => {
  assert.equal(shouldSubmitDialogOnEnter({ ...enter, isComposing: true }, textInput), false);
  assert.equal(shouldSubmitDialogOnEnter({ ...enter, defaultPrevented: true }, textInput), false);
  assert.equal(shouldSubmitDialogOnEnter(enter, { ...textInput, role: "combobox" }), false);
  assert.equal(shouldSubmitDialogOnEnter(enter, { ...textInput, inForm: true }), false);
  assert.equal(
    shouldSubmitDialogOnEnter({ ...enter, metaKey: true }, { ...textarea, inForm: true }),
    false,
  );
  assert.equal(shouldSubmitDialogOnEnter({ ...enter, shiftKey: true }, textInput), false);
  assert.equal(shouldSubmitDialogOnEnter({ ...enter, key: "a" }, textInput), false);
});
