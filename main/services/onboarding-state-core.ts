import type { Provider } from "./types.js";
import {
  ONBOARDING_STATE_VERSION,
  type OnboardingOutcome,
  type OnboardingState,
} from "../../renderer/shared/onboarding.js";

export interface OnboardingReadiness {
  profileReady: boolean;
  providerReady: boolean;
  selectedProviderId?: string;
}

export function onboardingProviderReady(provider: Provider): boolean {
  return provider.models.length > 0 && (provider.needsKey ? provider.hasKey === true : true);
}

/** Structural auth alone (including ambient env keys) is not first-run evidence. */
export function onboardingEvidenceProvider(
  providers: readonly Provider[],
  state: OnboardingState | null,
): Provider | undefined {
  const providerStepSatisfied =
    state?.lastSatisfiedStep === "provider" || state?.lastSatisfiedStep === "tour";
  if (!providerStepSatisfied || !state.selectedProviderId) return undefined;
  return providers.find(
    (provider) => provider.id === state.selectedProviderId && onboardingProviderReady(provider),
  );
}

/** One-time migration evidence from the model selection used by the legacy app. */
export function legacyOnboardingEvidenceProvider(
  providers: readonly Provider[],
  lastProviderId: string | undefined,
  lastModel: string | undefined,
): Provider | undefined {
  if (!lastProviderId || !lastModel) return undefined;
  return providers.find(
    (provider) =>
      provider.id === lastProviderId &&
      provider.models.includes(lastModel) &&
      onboardingProviderReady(provider),
  );
}

export function legacyOnboardingOutcome(
  legacyComplete: boolean,
  setupReady: boolean,
): OnboardingOutcome {
  return legacyComplete && setupReady ? "completed" : "incomplete";
}

export function onboardingProgressState(
  outcome: OnboardingOutcome,
  ready: OnboardingReadiness,
): OnboardingState {
  if (outcome === "deferred") {
    return {
      version: ONBOARDING_STATE_VERSION,
      outcome,
      lastSatisfiedStep: ready.profileReady ? "profile" : "none",
    };
  }
  return {
    version: ONBOARDING_STATE_VERSION,
    outcome,
    lastSatisfiedStep: !ready.profileReady ? "none" : ready.providerReady ? "provider" : "profile",
    ...(ready.selectedProviderId ? { selectedProviderId: ready.selectedProviderId } : {}),
  };
}

export function assertOnboardingCanComplete(ready: OnboardingReadiness): void {
  if (!ready.profileReady || !ready.providerReady) {
    throw new Error("Finish your profile and connect a usable model provider first.");
  }
}

export function reconcileOnboardingOutcome(
  outcome: OnboardingOutcome,
  ready: OnboardingReadiness,
): OnboardingOutcome {
  return outcome === "completed" && (!ready.profileReady || !ready.providerReady)
    ? "incomplete"
    : outcome;
}
