import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./about-settings.tsx", import.meta.url), "utf8");

test("the About onboarding action stays text-only until it is opening", () => {
  assert.doesNotMatch(source, /Sparkles/u);
  assert.match(source, /showingOnboarding \? <Loader2 className="animate-spin" \/> : null/u);
  assert.match(source, /showingOnboarding \? "Opening…" : "Show onboarding"/u);
});

test("About uses main update eligibility for AppImage controls and distro release links", () => {
  assert.match(source, /showUpdateControls\s+\? updateDescription\(updateSnapshot, capabilities\.platform\)/u);
  assert.match(source, /\{!showUpdateControls \? \(/u);
  assert.match(source, /const showUpdateControls = capabilities\.platform === "darwin" \|\| capabilities\.appUpdates/u);
  assert.match(source, /Install updates through your package manager/u);
  assert.match(source, /href=\{RELEASES_URL\}/u);
});

test("Linux update messages avoid macOS signing claims", () => {
  assert.match(source, /platform === "linux"\s+\? "Aiden checks automatically and downloads AppImage updates/u);
  assert.match(source, /platform === "linux"\s+\? "Checking the Aiden Agent update feed…"/u);
  assert.match(source, /platform === "linux"\s+\? "Aiden couldn’t reach the update feed\./u);
  assert.match(source, /capabilities\.platform === "linux"\s+\? "Automatic updates require a production AppImage installation\."/u);
});
