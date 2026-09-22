import assert from "node:assert/strict";
import test from "node:test";
import {
  registerCreateImagesNavigationGuard,
  requestCreateImagesNavigation,
} from "./navigation-guard.js";

test("Create Images route navigation waits for the active autosave guard", async () => {
  let calls = 0;
  const unregister = registerCreateImagesNavigationGuard(async () => {
    calls += 1;
    return { allowed: false, message: "Resolve the save conflict." };
  });
  assert.deepEqual(await requestCreateImagesNavigation(), {
    allowed: false,
    message: "Resolve the save conflict.",
  });
  assert.equal(calls, 1);
  unregister();
  assert.deepEqual(await requestCreateImagesNavigation(), { allowed: true });
});
