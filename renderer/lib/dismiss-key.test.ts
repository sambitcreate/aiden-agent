import assert from "node:assert/strict";
import { test } from "node:test";
import { isComposingKey, isDismissKey, isEscapeKey } from "./dismiss-key";

const key = (init: Partial<Parameters<typeof isDismissKey>[0]> = {}) => ({
  key: "Escape",
  keyCode: 27,
  defaultPrevented: false,
  ...init,
});

test("a plain Escape dismisses", () => {
  assert.equal(isDismissKey(key()), true);
  assert.equal(isEscapeKey(key()), true);
});

test("Escape that ends an input method's composition never dismisses", () => {
  for (const composing of [
    key({ isComposing: true }),
    key({ keyCode: 229 }),
    // React's synthetic event keeps the flag on the native event.
    key({ nativeEvent: { isComposing: true } }),
  ]) {
    assert.equal(isComposingKey(composing), true);
    assert.equal(isDismissKey(composing), false);
    assert.equal(isEscapeKey(composing), false);
  }
});

test("an Escape something nearer the focus handled is still Escape, but no longer dismisses", () => {
  const handled = key({ defaultPrevented: true });
  assert.equal(isEscapeKey(handled), true);
  assert.equal(isDismissKey(handled), false);
});

test("other keys are neither", () => {
  for (const other of ["Esc", "Enter", "Tab", "Process"]) {
    assert.equal(isEscapeKey(key({ key: other })), false);
    assert.equal(isDismissKey(key({ key: other })), false);
  }
});
