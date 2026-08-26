import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AMBIENT_MUSIC_CONFIG,
  parseAmbientMusicConfig,
} from "./ambient-music.js";

test("parses and normalizes the versioned Ambient Music settings", () => {
  const parsed = parseAmbientMusicConfig({
    version: 1,
    selectedModel: "mrt2_base",
    prompts: [
      { id: "pads", text: "  warm pads  ", weight: 2 / 3 },
      { id: "piano", text: "soft piano", weight: 1 / 3 },
    ],
    volumeDb: -24,
    variation: 0.3,
    drumless: true,
  });
  assert.deepEqual(parsed, {
    version: 1,
    selectedModel: "mrt2_base",
    prompts: [
      { id: "pads", text: "warm pads", weight: 2 / 3 },
      { id: "piano", text: "soft piano", weight: 1 / 3 },
    ],
    volumeDb: -24,
    variation: 0.3,
    drumless: true,
  });
});

test("rejects future versions, duplicate ids, empty mixes, and oversized UTF-8 prompts", () => {
  assert.equal(parseAmbientMusicConfig({ ...DEFAULT_AMBIENT_MUSIC_CONFIG, version: 2 }), undefined);
  assert.equal(parseAmbientMusicConfig({
    ...DEFAULT_AMBIENT_MUSIC_CONFIG,
    prompts: [
      { id: "same", text: "pads", weight: 0.5 },
      { id: "same", text: "piano", weight: 0.5 },
    ],
  }), undefined);
  assert.equal(parseAmbientMusicConfig({
    ...DEFAULT_AMBIENT_MUSIC_CONFIG,
    prompts: [{ id: "silent", text: "pads", weight: 0 }],
  }), undefined);
  assert.equal(parseAmbientMusicConfig({
    ...DEFAULT_AMBIENT_MUSIC_CONFIG,
    prompts: [{ id: "large", text: "🎵".repeat(51), weight: 1 }],
  }), undefined);
  assert.equal(parseAmbientMusicConfig({
    ...DEFAULT_AMBIENT_MUSIC_CONFIG,
    prompts: [{ id: "control", text: "pads\u0000piano", weight: 1 }],
  }), undefined);
});

test("the default config is safe, local-first, and uses Small", () => {
  assert.deepEqual(parseAmbientMusicConfig(DEFAULT_AMBIENT_MUSIC_CONFIG), DEFAULT_AMBIENT_MUSIC_CONFIG);
  assert.equal(DEFAULT_AMBIENT_MUSIC_CONFIG.selectedModel, "mrt2_small");
  assert.match(DEFAULT_AMBIENT_MUSIC_CONFIG.prompts[0].text, /no vocals/u);
});
