import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOnboardingCanComplete,
  legacyOnboardingOutcome,
  legacyOnboardingEvidenceProvider,
  onboardingEvidenceProvider,
  onboardingProgressState,
  onboardingProviderReady,
  reconcileOnboardingOutcome,
} from "./onboarding-state-core.js";
import type { Provider } from "./types.js";
import { shouldOpenOnboarding } from "../../renderer/shared/onboarding.js";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "openai",
    kind: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-test"],
    defaultModel: "gpt-test",
    needsKey: true,
    hasKey: true,
    ...overrides,
  };
}

test("provider readiness requires a chat model and the provider class's credential", () => {
  assert.equal(onboardingProviderReady(provider()), true);
  assert.equal(onboardingProviderReady(provider({ models: [] })), false);
  assert.equal(onboardingProviderReady(provider({ hasKey: false })), false);
  assert.equal(
    onboardingProviderReady(provider({ needsKey: false, hasKey: false, models: ["local"] })),
    true,
  );
});

test("an ambient or stored credential cannot skip validation after relaunch", () => {
  const ambient = provider({ id: "groq", label: "Groq", models: ["static-model"] });
  assert.equal(
    onboardingEvidenceProvider([ambient], {
      version: 2,
      outcome: "incomplete",
      lastSatisfiedStep: "profile",
    }),
    undefined,
  );
  assert.equal(
    onboardingEvidenceProvider([ambient], {
      version: 2,
      outcome: "incomplete",
      lastSatisfiedStep: "provider",
      selectedProviderId: "groq",
    })?.id,
    "groq",
  );
});

test("legacy completion reopens onboarding until current setup readiness is proven", () => {
  assert.equal(legacyOnboardingOutcome(false, false), "incomplete");
  assert.equal(legacyOnboardingOutcome(true, false), "incomplete");
  assert.equal(legacyOnboardingOutcome(true, true), "completed");
  assert.equal(shouldOpenOnboarding(legacyOnboardingOutcome(true, false)), true);
});

test("legacy migration retains a matching usable provider and model without trusting stale selection", () => {
  const configured = provider();
  const selected = legacyOnboardingEvidenceProvider(
    [configured],
    configured.id,
    configured.defaultModel,
  );

  assert.equal(selected?.id, configured.id);
  assert.equal(
    shouldOpenOnboarding(legacyOnboardingOutcome(true, selected !== undefined)),
    false,
  );
  assert.equal(
    legacyOnboardingEvidenceProvider([configured], configured.id, "removed-model"),
    undefined,
  );
  assert.equal(
    legacyOnboardingEvidenceProvider(
      [provider({ hasKey: false })],
      configured.id,
      configured.defaultModel,
    ),
    undefined,
  );
  assert.equal(
    legacyOnboardingEvidenceProvider([configured], undefined, configured.defaultModel),
    undefined,
  );
});

test("progress is versioned and completion is readiness-gated", () => {
  const ready = {
    profileReady: true,
    providerReady: true,
    selectedProviderId: "openai",
  };
  assert.deepEqual(onboardingProgressState("incomplete", ready), {
    version: 2,
    outcome: "incomplete",
    lastSatisfiedStep: "provider",
    selectedProviderId: "openai",
  });
  assert.deepEqual(onboardingProgressState("deferred", ready), {
    version: 2,
    outcome: "deferred",
    lastSatisfiedStep: "profile",
  });
  assert.doesNotThrow(() => assertOnboardingCanComplete(ready));
  assert.throws(
    () => assertOnboardingCanComplete({ ...ready, providerReady: false }),
    /usable model provider/u,
  );
});

test("completed state reopens when authoritative setup readiness is lost", () => {
  assert.equal(
    reconcileOnboardingOutcome("completed", { profileReady: true, providerReady: false }),
    "incomplete",
  );
  assert.equal(
    reconcileOnboardingOutcome("completed", { profileReady: true, providerReady: true }),
    "completed",
  );
  assert.equal(
    reconcileOnboardingOutcome("deferred", { profileReady: true, providerReady: true }),
    "deferred",
  );
});
