import assert from "node:assert/strict";
import test from "node:test";
import { acceleratorPrimaryMacKeyCode } from "./dictation-keycode.js";

test("maps the default dictation accelerator to the D key code", () => {
  assert.equal(acceleratorPrimaryMacKeyCode("Command+Shift+D"), 0x02);
});

test("ignores modifiers-only accelerators and unknown keys", () => {
  assert.equal(acceleratorPrimaryMacKeyCode("Command+Shift"), null);
  assert.equal(acceleratorPrimaryMacKeyCode("Command+F13"), null);
  assert.equal(acceleratorPrimaryMacKeyCode(null), null);
});
