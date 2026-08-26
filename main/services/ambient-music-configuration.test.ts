import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AMBIENT_MUSIC_CONFIG,
  type AmbientMusicFeatureSnapshot,
} from "../../renderer/shared/ambient-music.js";
import { applyAmbientMusicConfiguration } from "./ambient-music-configuration.js";
import type { AppSettings } from "./types.js";

const snapshot: AmbientMusicFeatureSnapshot = {
  revision: 4,
  supported: true,
  helper: "ready",
  playback: "paused",
  loadedModel: "mrt2_small",
  selectedModel: "mrt2_small",
  promptReady: true,
  models: [],
  storage: { sharedBytes: 0, locationLabel: "Aiden application data" },
};

function settingsHarness(initial: AppSettings) {
  let value = structuredClone(initial);
  const writes: Array<AppSettings["ambientMusic"]> = [];
  return {
    writes,
    value: () => value,
    port: {
      async getSettings() { return structuredClone(value); },
      async setSettings(patch: Partial<AppSettings>) {
        value = { ...value, ...patch };
        writes.push(value.ambientMusic);
        return structuredClone(value);
      },
    },
  };
}

test("an authoritative apply saves exactly the configuration used by the runtime", async () => {
  const settings = settingsHarness({});
  const applied: unknown[] = [];
  const result = await applyAmbientMusicConfiguration({
    async applyConfiguration(config, playAfter) {
      applied.push(config, playAfter);
      return snapshot;
    },
  }, settings.port, DEFAULT_AMBIENT_MUSIC_CONFIG, true);
  assert.deepEqual(applied, [DEFAULT_AMBIENT_MUSIC_CONFIG, true]);
  assert.deepEqual(result.config, DEFAULT_AMBIENT_MUSIC_CONFIG);
  assert.deepEqual(settings.value().ambientMusic, DEFAULT_AMBIENT_MUSIC_CONFIG);
});

test("a failed runtime apply restores the previous saved configuration", async () => {
  const previous = { ...DEFAULT_AMBIENT_MUSIC_CONFIG, volumeDb: -30 };
  const settings = settingsHarness({ ambientMusic: previous });
  await assert.rejects(
    applyAmbientMusicConfiguration({
      async applyConfiguration() { throw new Error("prompt encoder failed"); },
    }, settings.port, DEFAULT_AMBIENT_MUSIC_CONFIG, false),
    /prompt encoder failed/,
  );
  assert.deepEqual(settings.writes, [DEFAULT_AMBIENT_MUSIC_CONFIG, previous]);
  assert.deepEqual(settings.value().ambientMusic, previous);
});
