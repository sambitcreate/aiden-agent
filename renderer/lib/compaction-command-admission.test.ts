import assert from "node:assert/strict";
import test from "node:test";
import { claimCompactionCommand } from "./compaction-command-admission";

test("compaction admission is synchronously single-flight and rejects a restored hold", () => {
  const busyRef = { current: false };

  assert.equal(claimCompactionCommand(busyRef, false, false), true);
  // A second activation in the same React render still sees the claimed ref.
  assert.equal(claimCompactionCommand(busyRef, false, false), false);
  assert.equal(busyRef.current, true);

  busyRef.current = false;
  assert.equal(claimCompactionCommand(busyRef, false, true), false);
  assert.equal(busyRef.current, false);
});
