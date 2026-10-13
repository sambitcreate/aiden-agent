import assert from "node:assert/strict";
import test from "node:test";
import {
  imageScanElapsedLabel,
  imageScanPeriodMs,
  placeholderAspectRatio,
} from "./placeholder-spec.js";

test("the scan slows and the caption changes once a job passes a minute", () => {
  assert.equal(imageScanPeriodMs(0), 2_800);
  assert.equal(imageScanPeriodMs(59_999), 2_800);
  assert.equal(imageScanPeriodMs(60_000), 5_200);
  assert.equal(imageScanElapsedLabel(0), "Generating · 0s");
  assert.equal(imageScanElapsedLabel(59_999), "Generating · 59s");
  assert.equal(imageScanElapsedLabel(60_000), "Still generating · 1m 00s");
  assert.equal(imageScanElapsedLabel(72_400), "Still generating · 1m 12s");
  assert.equal(imageScanElapsedLabel(-5), "Generating · 0s", "clock skew never shows a negative time");
});

test("the placeholder shape is the call's ratio, or square", () => {
  assert.equal(placeholderAspectRatio("9:16"), "9:16");
  for (const value of [undefined, "", "21:9", "16x9", 1.5, null]) assert.equal(placeholderAspectRatio(value), "1:1");
});
