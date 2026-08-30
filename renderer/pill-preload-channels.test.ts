import assert from "node:assert/strict";
import test from "node:test";
import { PILL_INVOKE_CHANNELS, PILL_NOTIFICATION_CHANNELS } from "./pill-preload-channels.js";

test("pill preload exposes only capture, transcription, settings read, and dictation lifecycle", () => {
  assert.deepEqual([...PILL_INVOKE_CHANNELS].sort(), [
    "dictation:cancel",
    "dictation:error",
    "dictation:progress",
    "dictation:ready",
    "dictation:result",
    "dictation:stop",
    "settings:get",
    "settings:getAppearance",
    "voice:streamCancel",
    "voice:streamFinish",
    "voice:streamPush",
    "voice:streamStart",
    "voice:transcribe",
    "voice:transcribeCancel",
    "voice:transcribeLocal",
    "voice:transcribeLocalCancel",
  ]);
  assert.deepEqual(
    [...PILL_NOTIFICATION_CHANNELS],
    ["dictation:state", "settings:appearance-changed", "voice:stream-text"],
  );
  for (const forbidden of ["providers:setKey", "mcp:setPresetKey", "settings:set", "git:push"]) {
    assert.equal(PILL_INVOKE_CHANNELS.has(forbidden), false);
  }
});
