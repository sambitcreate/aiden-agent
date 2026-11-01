import assert from "node:assert/strict";
import test from "node:test";
import { DISABLED_APP_CAPABILITIES, parseAppCapabilities } from "./app-capabilities.js";

test("studio capabilities fail closed until main enables them with a literal true", () => {
  assert.equal(DISABLED_APP_CAPABILITIES.createImages, false);
  assert.equal(parseAppCapabilities({}).createImages, false);
  for (const value of ["true", 1, "1", {}, null]) {
    assert.equal(parseAppCapabilities({ createImages: value }).createImages, false, JSON.stringify(value));
  }
});

test("a retired Design Studio capability from an older main is dropped", () => {
  assert.deepEqual(parseAppCapabilities({ designStudio: true }), DISABLED_APP_CAPABILITIES);
});

test("each studio capability is independent of the others", () => {
  assert.deepEqual(parseAppCapabilities({ createImages: true, devices: true }), {
    ...DISABLED_APP_CAPABILITIES,
    createImages: true,
    devices: true,
  });
});

test("Bot computers fail closed and stand apart from Computer Use", () => {
  assert.equal(DISABLED_APP_CAPABILITIES.botComputers, false);
  for (const value of ["true", 1, {}, null, undefined]) {
    assert.equal(parseAppCapabilities({ botComputers: value, computerUse: true }).botComputers, false, JSON.stringify(value));
  }
  assert.deepEqual(parseAppCapabilities({ botComputers: true }), { ...DISABLED_APP_CAPABILITIES, botComputers: true });
});
