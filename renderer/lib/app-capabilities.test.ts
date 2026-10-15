import assert from "node:assert/strict";
import test from "node:test";
import { DISABLED_APP_CAPABILITIES, parseAppCapabilities } from "./app-capabilities.js";

test("studio capabilities fail closed until main enables them with a literal true", () => {
  assert.equal(DISABLED_APP_CAPABILITIES.designStudio, false);
  assert.equal(DISABLED_APP_CAPABILITIES.createImages, false);
  assert.equal(parseAppCapabilities({}).designStudio, false);
  assert.equal(parseAppCapabilities({}).createImages, false);
  for (const value of ["true", 1, "1", {}, null]) {
    const parsed = parseAppCapabilities({ designStudio: value, createImages: value });
    assert.equal(parsed.designStudio, false, JSON.stringify(value));
    assert.equal(parsed.createImages, false, JSON.stringify(value));
  }
});

test("each studio capability is independent of the others", () => {
  assert.deepEqual(parseAppCapabilities({ designStudio: true }), {
    ...DISABLED_APP_CAPABILITIES,
    designStudio: true,
  });
  assert.deepEqual(parseAppCapabilities({ createImages: true, devices: true }), {
    ...DISABLED_APP_CAPABILITIES,
    createImages: true,
    devices: true,
  });
});
