import assert from "node:assert/strict";
import test from "node:test";
import {
  checkAccessibilityPermission,
  requestAccessibilityPermission,
} from "./accessibility-permission-core.js";

test("Accessibility checks expose granted and permission-needed states", async () => {
  assert.deepEqual(await checkAccessibilityPermission(async () => true), {
    status: "granted",
  });
  assert.deepEqual(await checkAccessibilityPermission(async () => false), {
    status: "needed",
  });
});

test("native Accessibility failures never expose raw IPC wrapper text", async () => {
  const check = await checkAccessibilityPermission(async () => {
    throw new Error("Error invoking remote method 'aiden:accessibility:status'");
  });
  const request = await requestAccessibilityPermission(async () => {
    throw new Error("Error invoking remote method 'aiden:accessibility:request'");
  });
  assert.equal(check.status, "error");
  assert.equal(request.status, "error");
  assert.doesNotMatch(check.status === "error" ? check.message : "", /remote method/u);
  assert.doesNotMatch(request.status === "error" ? request.message : "", /remote method/u);
});

test("an asynchronous native prompt remains permission-needed until macOS reports trust", async () => {
  assert.deepEqual(await requestAccessibilityPermission(async () => false), {
    status: "needed",
  });
});
