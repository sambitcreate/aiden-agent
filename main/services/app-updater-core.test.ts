import assert from "node:assert/strict";
import test from "node:test";

import { shouldEnableAppUpdates } from "./app-updater-core.js";

test("auto updates require a packaged macOS app with embedded feed metadata", () => {
  assert.equal(
    shouldEnableAppUpdates({
      isPackaged: true,
      platform: "darwin",
      runtimeProfile: "production",
      updateConfigExists: true,
    }),
    true,
  );
  assert.equal(
    shouldEnableAppUpdates({
      isPackaged: false,
      platform: "darwin",
      runtimeProfile: "production",
      updateConfigExists: true,
    }),
    false,
  );
  assert.equal(
    shouldEnableAppUpdates({
      isPackaged: true,
      platform: "darwin",
      runtimeProfile: "production",
      updateConfigExists: false,
    }),
    false,
  );
  assert.equal(
    shouldEnableAppUpdates({
      isPackaged: true,
      platform: "linux",
      runtimeProfile: "production",
      updateConfigExists: true,
    }),
    false,
  );
});

test("development profiles never contact the production update feed", () => {
  assert.equal(
    shouldEnableAppUpdates({
      isPackaged: true,
      platform: "darwin",
      runtimeProfile: "development",
      updateConfigExists: true,
    }),
    false,
  );
});
