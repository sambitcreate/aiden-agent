import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./tts-settings.tsx", import.meta.url), "utf8");

test("settings previews use the gesture-primed player controller, not generation-only IPC", () => {
  assert.match(source, /useReadAloud\(undefined\)/u);
  assert.match(source, /previewController\.preview\(\)/u);
  assert.match(source, /previewController\.stop\(\)/u);
  assert.match(source, /Stop preview/u);
  assert.doesNotMatch(source, /ttsApi\s*\.preview\(/u);
});

test("settings retain shared controls, bounded blur-save notes and error recovery", () => {
  assert.doesNotMatch(source, /<select|settings-select|<h1/u);
  assert.match(source, /<SelectTrigger[\s\S]*?aria-label="Speech model"/u);
  assert.match(source, /aria-label="Dedicated Google API key"/u);
  assert.match(source, /maxLength=\{TTS_LIMITS\.deliveryNoteMaxChars\}/u);
  assert.match(source, /onChange=\{\(event\) => setDeliveryNote\(event.target.value\)\}/u);
  assert.match(source, /onBlur=/u);
  assert.match(source, /Could not clear generated audio/u);
  assert.match(source, /role="alert"/u);
});
