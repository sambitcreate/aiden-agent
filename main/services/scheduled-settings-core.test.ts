import assert from "node:assert/strict";
import test from "node:test";
import { scheduledSettingsPatch } from "./scheduled-settings-core.js";

test("an unrelated scheduler edit produces a sparse settings patch", () => {
  assert.deepEqual(
    scheduledSettingsPatch({ enabled: true }, (timezone) => timezone),
    { scheduledTasksEnabled: true },
  );
});

test("unknown future scheduler enum values are never projected back as undefined", () => {
  assert.deepEqual(
    scheduledSettingsPatch(
      { enabled: false, defaultMode: "future-mode", defaultPermission: "future-permission" },
      (timezone) => timezone,
    ),
    { scheduledTasksEnabled: false },
  );
});

test("default MCP access is accepted only as an explicit boolean", () => {
  assert.deepEqual(
    scheduledSettingsPatch(
      { defaultMcpEnabled: true, defaultNotify: false },
      (timezone) => timezone,
    ),
    {
      scheduledDefaultMcpEnabled: true,
      scheduledDefaultNotify: false,
    },
  );
  assert.deepEqual(
    scheduledSettingsPatch({ defaultMcpEnabled: "true" }, (timezone) => timezone),
    {},
  );
});
