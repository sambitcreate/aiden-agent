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

test("design mode fails closed until main enables it with a literal true", () => {
  assert.equal(DISABLED_APP_CAPABILITIES.designMode, false);
  assert.equal(parseAppCapabilities({}).designMode, false);
  for (const value of ["true", 1, "1", {}, null]) {
    assert.equal(parseAppCapabilities({ designMode: value }).designMode, false, JSON.stringify(value));
  }
  assert.deepEqual(parseAppCapabilities({ designMode: true }), { ...DISABLED_APP_CAPABILITIES, designMode: true });
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

test("the app icon badge fails closed until main reports a literal true", () => {
  assert.equal(DISABLED_APP_CAPABILITIES.badgeCount, false);
  for (const value of ["true", 1, {}, null, undefined]) {
    assert.equal(parseAppCapabilities({ badgeCount: value, dockIcon: true }).badgeCount, false, JSON.stringify(value));
  }
  assert.deepEqual(parseAppCapabilities({ badgeCount: true }), { ...DISABLED_APP_CAPABILITIES, badgeCount: true });
});
