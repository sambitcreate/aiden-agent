import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsApplicationEffects } from "./settings-application-effects-core.js";
import type { AppSettings } from "./types.js";

function subject() {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  const recordAsync = (name: string) => async () => {
    calls.push(name);
  };
  const apply = createSettingsApplicationEffects({
    invalidateSkills: record("invalidateSkills"),
    revokeBotSkills: record("revokeBotSkills"),
    cancelSkillWork: recordAsync("cancelSkillWork"),
    refreshCommands: recordAsync("refreshCommands"),
    reconfigureIdleUnload: recordAsync("reconfigureIdleUnload"),
    preloadLocalVoice: record("preloadLocalVoice"),
    stopCacheWarmers: record("stopCacheWarmers"),
    revokeComputerUseGrants: recordAsync("revokeComputerUseGrants"),
    stopLiveSessions: recordAsync("stopLiveSessions"),
    publishAppearance: record("publishAppearance"),
    publishControls: record("publishControls"),
  });
  return { apply: (patch: Partial<AppSettings>) => apply({} as AppSettings, patch), calls };
}

test("choosing an on-device model or provider loads it ahead of dictation", async () => {
  for (const patch of [{ localVoiceModel: "parakeet-v3" }, { voiceProvider: "local" as const }, { localVoicePreload: true }]) {
    const { apply, calls } = subject();
    await apply(patch);
    assert.ok(calls.includes("preloadLocalVoice"), JSON.stringify(patch));
  }
});

test("unrelated changes and turning Load in advance off load nothing", async () => {
  for (const patch of [{ localVoicePreload: false }, { voiceTrimSilence: false }, { localVoiceIdleUnloadMinutes: 5 }]) {
    const { apply, calls } = subject();
    await apply(patch);
    assert.equal(calls.includes("preloadLocalVoice"), false, JSON.stringify(patch));
  }
});

test("a new idle period restarts the unload countdown", async () => {
  const { apply, calls } = subject();
  await apply({ localVoiceIdleUnloadMinutes: 60 });
  assert.ok(calls.includes("reconfigureIdleUnload"));
});
