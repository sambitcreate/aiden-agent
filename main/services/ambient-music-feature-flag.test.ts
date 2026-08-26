import assert from "node:assert/strict";
import test from "node:test";

import {
  AMBIENT_MUSIC_FEATURE_FLAG,
  ambientMusicEnabled,
} from "./ambient-music-feature-flag.js";

test("Ambient Music is default-on with an exact reversible local rollback", () => {
  assert.equal(AMBIENT_MUSIC_FEATURE_FLAG, "AIDEN_AMBIENT_MUSIC_ENABLED");
  assert.equal(ambientMusicEnabled({}), true);
  assert.equal(ambientMusicEnabled({ AIDEN_AMBIENT_MUSIC_ENABLED: "1" }), true);
  assert.equal(ambientMusicEnabled({ AIDEN_AMBIENT_MUSIC_ENABLED: "false" }), true);
  assert.equal(ambientMusicEnabled({ AIDEN_AMBIENT_MUSIC_ENABLED: " 0 " }), false);
});
