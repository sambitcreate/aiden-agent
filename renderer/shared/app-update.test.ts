import assert from "node:assert/strict";
import test from "node:test";

import {
  IDLE_APP_UPDATE_SNAPSHOT,
  normalizeAppUpdateVersion,
  parseAppUpdateSnapshot,
} from "./app-update.js";

test("accepts a bounded downloaded update version", () => {
  assert.equal(normalizeAppUpdateVersion(" 0.27.25 "), "0.27.25");
  assert.deepEqual(parseAppUpdateSnapshot({ status: "ready", version: "0.27.25" }), {
    status: "ready",
    version: "0.27.25",
  });
});

test("fails closed for malformed or non-ready update snapshots", () => {
  assert.deepEqual(parseAppUpdateSnapshot(null), IDLE_APP_UPDATE_SNAPSHOT);
  assert.deepEqual(
    parseAppUpdateSnapshot({ status: "ready", version: "0.27.25\nRestart now" }),
    IDLE_APP_UPDATE_SNAPSHOT,
  );
  assert.deepEqual(
    parseAppUpdateSnapshot({ status: "ready", version: "\n0.27.25" }),
    IDLE_APP_UPDATE_SNAPSHOT,
  );
  assert.deepEqual(
    parseAppUpdateSnapshot({ status: "downloading", version: "0.27.25" }),
    IDLE_APP_UPDATE_SNAPSHOT,
  );
});
