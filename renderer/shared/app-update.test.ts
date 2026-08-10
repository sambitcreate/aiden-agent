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

test("accepts bounded checking, download progress, and recoverable error states", () => {
  assert.deepEqual(parseAppUpdateSnapshot({ status: "checking", version: null }), {
    status: "checking",
    version: null,
  });
  assert.deepEqual(
    parseAppUpdateSnapshot({
      status: "downloading",
      version: "0.28.32",
      percent: 48.25,
      transferred: 96_500_000,
      total: 200_000_000,
    }),
    {
      status: "downloading",
      version: "0.28.32",
      percent: 48.25,
      transferred: 96_500_000,
      total: 200_000_000,
    },
  );
  assert.deepEqual(
    parseAppUpdateSnapshot({
      status: "error",
      version: "0.28.32",
      error: "download-failed",
    }),
    {
      status: "error",
      version: "0.28.32",
      error: "download-failed",
    },
  );
});

test("drops hostile or inconsistent progress values without dropping a valid download", () => {
  assert.deepEqual(
    parseAppUpdateSnapshot({
      status: "downloading",
      version: "0.28.32",
      percent: 101,
      transferred: 201,
      total: 200,
    }),
    {
      status: "downloading",
      version: "0.28.32",
      percent: null,
      transferred: null,
      total: null,
    },
  );
  assert.deepEqual(
    parseAppUpdateSnapshot({
      status: "downloading",
      version: "0.28.32",
      percent: Number.NaN,
      transferred: Number.MAX_SAFE_INTEGER + 1,
      total: Infinity,
    }),
    {
      status: "downloading",
      version: "0.28.32",
      percent: null,
      transferred: null,
      total: null,
    },
  );
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
    parseAppUpdateSnapshot({ status: "downloading", version: null }),
    IDLE_APP_UPDATE_SNAPSHOT,
  );
  assert.deepEqual(
    parseAppUpdateSnapshot({ status: "error", version: "0.27.25", error: "raw stack" }),
    IDLE_APP_UPDATE_SNAPSHOT,
  );
  assert.equal(normalizeAppUpdateVersion("Aiden Agent 0.27.25"), null);
  assert.equal(normalizeAppUpdateVersion("0.27.025"), null);
  assert.equal(normalizeAppUpdateVersion("0.27.25\u202e"), null);
});
