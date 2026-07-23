import assert from "node:assert/strict";
import test from "node:test";

import { shouldEnableAppUpdates } from "./app-updater-core.js";

test("auto updates require a packaged macOS app with embedded feed metadata", () => {
  assert.equal(
    shouldEnableAppUpdates({ isPackaged: true, platform: "darwin", updateConfigExists: true }),
    true,
  );
  assert.equal(
    shouldEnableAppUpdates({ isPackaged: false, platform: "darwin", updateConfigExists: true }),
    false,
  );
  assert.equal(
    shouldEnableAppUpdates({ isPackaged: true, platform: "darwin", updateConfigExists: false }),
    false,
  );
  assert.equal(
    shouldEnableAppUpdates({ isPackaged: true, platform: "linux", updateConfigExists: true }),
    false,
  );
});
