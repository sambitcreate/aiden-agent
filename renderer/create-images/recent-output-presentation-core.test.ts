import assert from "node:assert/strict";
import test from "node:test";
import {
  readCreateImagesRecentOutputCutoff,
  visibleCreateImagesRecentOutputs,
  writeCreateImagesRecentOutputCutoff,
} from "./recent-output-presentation-core.js";

test("clearing recent outputs is a reversible device presentation cutoff", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const cutoff = Date.parse("2026-08-21T12:00:00.000Z");
  writeCreateImagesRecentOutputCutoff(storage, cutoff);
  assert.equal(readCreateImagesRecentOutputCutoff(storage), cutoff);
  assert.deepEqual(
    visibleCreateImagesRecentOutputs(
      [
        { id: "old", createdAt: "2026-08-21T11:00:00.000Z" },
        { id: "new", createdAt: "2026-08-21T13:00:00.000Z" },
      ],
      cutoff,
    ).map((item) => item.id),
    ["new"],
  );
  writeCreateImagesRecentOutputCutoff(storage, undefined);
  assert.equal(readCreateImagesRecentOutputCutoff(storage), undefined);
});
