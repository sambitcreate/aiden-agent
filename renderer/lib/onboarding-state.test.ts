import assert from "node:assert/strict";
import test from "node:test";
import {
  markOnboardingComplete,
  ONBOARDING_COMPLETE_STORAGE_KEY,
  shouldShowOnboarding,
} from "./onboarding-state.js";

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(ONBOARDING_COMPLETE_STORAGE_KEY, initial);
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

test("onboarding is shown until its completion marker is set", () => {
  const values = storage();
  assert.equal(shouldShowOnboarding(values), true);

  markOnboardingComplete(values);
  assert.equal(shouldShowOnboarding(values), false);
});

test("only the exact current completion marker skips onboarding", () => {
  assert.equal(shouldShowOnboarding(storage("false")), true);
  assert.equal(shouldShowOnboarding(storage("1")), true);
  assert.equal(shouldShowOnboarding(storage("true")), false);
});
