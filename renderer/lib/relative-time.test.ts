import assert from "node:assert/strict";
import test from "node:test";
import { formatRelativeTime } from "./relative-time";

const now = Date.parse("2026-10-12T12:00:00Z");
const label = (value: number, unit: Intl.RelativeTimeFormatUnit) =>
  new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, unit);

test("relative labels pick the unit by distance, in the past and the future", () => {
  assert.equal(formatRelativeTime(now - 30_000, now), label(-30, "second"));
  assert.equal(formatRelativeTime(now + 5 * 60_000, now), label(5, "minute"));
  assert.equal(formatRelativeTime(now - 2 * 3_600_000, now), label(-2, "hour"));
  assert.equal(formatRelativeTime(now - 3 * 86_400_000, now), label(-3, "day"));
});

test("unit boundaries switch at 90 seconds, 90 minutes and 36 hours", () => {
  assert.equal(formatRelativeTime(now - 89_000, now), label(-89, "second"));
  assert.equal(formatRelativeTime(now - 95_000, now), label(-2, "minute"));
  assert.equal(formatRelativeTime(now - 89 * 60_000, now), label(-89, "minute"));
  assert.equal(formatRelativeTime(now - 95 * 60_000, now), label(-2, "hour"));
  assert.equal(formatRelativeTime(now - 35 * 3_600_000, now), label(-35, "hour"));
  assert.equal(formatRelativeTime(now - 37 * 3_600_000, now), label(-2, "day"));
});
