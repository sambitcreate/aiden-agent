import assert from "node:assert/strict";
import test from "node:test";
import { fitCreateImagesNodeToMediaAspect } from "./node-dimensions-core.js";

test("fits node dimensions to media aspect while preserving the current width", () => {
  assert.deepEqual(fitCreateImagesNodeToMediaAspect({ width: 400, height: 400 }, 1600, 900), {
    width: 400,
    height: 225,
  });
});

test("bounds extreme media aspects and rejects invalid metadata", () => {
  assert.deepEqual(fitCreateImagesNodeToMediaAspect(undefined, 10_000, 100), {
    width: 1_200,
    height: 120,
  });
  assert.deepEqual(fitCreateImagesNodeToMediaAspect({ width: 200, height: 200 }, 100, 10_000), {
    width: 180,
    height: 1_600,
  });
  assert.equal(fitCreateImagesNodeToMediaAspect(undefined, 0, 100), undefined);
});
