import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { INPUT_MODALITY_ATTRIBUTE, installInputModality } from "./input-modality.js";

function setup() {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const uninstall = installInputModality(doc);
  const modality = () => doc.documentElement.getAttribute(INPUT_MODALITY_ATTRIBUTE);
  const key = (key: string, init: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}) =>
    doc.body.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, ...init }) as unknown as Event);
  const press = () => doc.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event);
  return { window, modality, key, press, uninstall };
}

test("a click hides keyboard rings until a navigation key is pressed", () => {
  const { window, modality, key, press } = setup();
  assert.equal(modality(), null, "rings stay on until the first input");
  press();
  assert.equal(modality(), "pointer");
  key("ArrowDown");
  assert.equal(modality(), "keyboard");
  press();
  key("Tab", { shiftKey: true });
  assert.equal(modality(), "keyboard", "Shift+Tab is navigation");
  window.happyDOM.close();
});

test("modifier keys and shortcut chords keep the pointer modality", () => {
  const { window, modality, key, press } = setup();
  press();
  key("Meta", { metaKey: true });
  key("Shift", { shiftKey: true });
  key("k", { metaKey: true });
  key("c", { ctrlKey: true });
  assert.equal(modality(), "pointer");
  window.happyDOM.close();
});

test("uninstalling stops tracking", () => {
  const { window, modality, key, press, uninstall } = setup();
  press();
  uninstall();
  key("Tab");
  assert.equal(modality(), "pointer");
  window.happyDOM.close();
});
