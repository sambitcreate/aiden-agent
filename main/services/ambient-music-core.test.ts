import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAmbientMusicPlaybackProjection,
  shouldApplyAmbientMusicPlayback,
  validateAmbientMusicPromptMix,
  validateAmbientMusicVolume,
  validateAmbientMusicWeights,
} from "./ambient-music-core.js";

test("normalizes a bounded Ambient Music prompt mix", () => {
  assert.deepEqual(
    validateAmbientMusicPromptMix(["  soft piano  ", "rain"], [2 / 3, 1 / 3]),
    { prompts: ["soft piano", "rain"], weights: [2 / 3, 1 / 3] },
  );
  assert.throws(() => validateAmbientMusicPromptMix(["\u0000"], [1]), /safe text/);
  assert.throws(() => validateAmbientMusicPromptMix(new Array(7).fill("p"), new Array(7).fill(1 / 7)), /one to six/);
});

test("rejects non-finite or out-of-contract controls", () => {
  assert.throws(() => validateAmbientMusicWeights([Number.NaN]), /finite/);
  assert.throws(() => validateAmbientMusicWeights([0, 0]), /positive/);
  assert.throws(() => validateAmbientMusicVolume(1), /between -60 dB and 0 dB/);
  assert.equal(validateAmbientMusicVolume(-18), -18);
});

test("applies only authoritative playback projections", () => {
  const projection = parseAmbientMusicPlaybackProjection({ state: "paused", revision: 4 });
  assert.equal(shouldApplyAmbientMusicPlayback(3, projection), true);
  assert.equal(shouldApplyAmbientMusicPlayback(5, projection), false);
  assert.throws(() => parseAmbientMusicPlaybackProjection({ state: "loading", revision: 1 }), /invalid playback/);
});
