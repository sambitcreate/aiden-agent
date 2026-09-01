import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./about-settings.tsx", import.meta.url), "utf8");

test("the About onboarding action stays text-only until it is opening", () => {
  assert.doesNotMatch(source, /Sparkles/u);
  assert.match(source, /showingOnboarding \? <Loader2 className="animate-spin" \/> : null/u);
  assert.match(source, /showingOnboarding \? "Opening…" : "Show onboarding"/u);
});
