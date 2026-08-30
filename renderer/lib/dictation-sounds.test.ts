import assert from "node:assert/strict";
import test from "node:test";
import { cueOscillatorConfig } from "./dictation-sounds.js";

test("dictation cues stay short and quiet", () => {
  for (const kind of ["start", "stop", "success", "error"] as const) {
    const cue = cueOscillatorConfig(kind);
    assert.ok(cue.durationMs <= 120);
    assert.ok(cue.gain <= 0.08);
    assert.ok(cue.frequency > 200);
  }
});
