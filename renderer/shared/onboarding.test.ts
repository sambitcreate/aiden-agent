import assert from "node:assert/strict";
import test from "node:test";
import { onboardingStepIndex, parseOnboardingState } from "./onboarding.js";

test("onboarding state accepts only the current bounded non-secret contract", () => {
  assert.deepEqual(
    parseOnboardingState({
      version: 2,
      outcome: "deferred",
      lastSatisfiedStep: "profile",
      selectedProviderId: "openai",
    }),
    {
      version: 2,
      outcome: "deferred",
      lastSatisfiedStep: "profile",
      selectedProviderId: "openai",
    },
  );
  assert.equal(parseOnboardingState({ version: 1, outcome: "completed" }), null);
  assert.equal(
    parseOnboardingState({
      version: 2,
      outcome: "completed",
      lastSatisfiedStep: "tour",
      selectedProviderId: "x".repeat(129),
    }),
    null,
  );
});

test("resume position is derived from authoritative readiness", () => {
  const base = {
    version: 2 as const,
    outcome: "incomplete" as const,
    lastSatisfiedStep: "none" as const,
  };
  assert.equal(onboardingStepIndex({ ...base, profileReady: false, providerReady: false }), 0);
  assert.equal(onboardingStepIndex({ ...base, profileReady: true, providerReady: false }), 1);
  assert.equal(onboardingStepIndex({ ...base, profileReady: true, providerReady: true }), 2);
});
