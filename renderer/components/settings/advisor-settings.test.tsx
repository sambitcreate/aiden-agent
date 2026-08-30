import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./advisor-settings.tsx", import.meta.url), "utf8");
const modelData = readFileSync(new URL("./model-data-settings.tsx", import.meta.url), "utf8");

test("Model settings exposes an off-by-default advisor selector with explicit save", () => {
  assert.match(modelData, /<AdvisorSettings \/>/u);
  assert.match(source, /Second-opinion reviewer/u);
  assert.match(source, /checked=\{enabled\}/u);
  assert.match(source, /aria-label="Advisor provider"/u);
  assert.match(source, /aria-label="Advisor model"/u);
  assert.match(source, /aria-label="Advisor reasoning effort"/u);
  assert.match(source, /advisorApi\.set\(draft\)/u);
  assert.match(source, /configuration\?\.disabledForExecutors \?\? \[\]/u);
  assert.match(source, /Save Advisor/u);
  assert.match(source, /\(!enabled && providers\.length === 0\)/u);
  assert.match(source, /providerUnavailable && configuration\?\.selection/u);
  assert.match(source, /modelUnavailable && configuration\?\.selection/u);
  assert.match(source, /<Badge color="red">Unavailable<\/Badge>/u);
});

test("Advisor UI discloses its bounded privacy and billing behavior", () => {
  assert.match(source, /at\s+most one/u);
  assert.match(source, /surviving user, tool-result, tool-inventory, and supported-image evidence/u);
  assert.match(source, /omits hidden reasoning/u);
  assert.match(source, /never attaches its provider credentials/u);
  assert.match(source, /redacts high-confidence credential strings in text/u);
  assert.match(source, /forwarded content can still contain sensitive data/u);
  assert.match(source, /reviewer gets no tools/u);
  assert.match(source, /separate provider request/u);
  assert.match(source, /background, Telegram, Bot, and child-agent runs/u);
  assert.doesNotMatch(source, /onboarding/u);
});
