export const ONBOARDING_COMPLETE_STORAGE_KEY = "aiden:onboarding:v1:complete";

export const ONBOARDING_STATE_VERSION = 2 as const;

export type OnboardingOutcome = "incomplete" | "deferred" | "completed";
export type OnboardingSatisfiedStep = "none" | "profile" | "provider" | "tour";

export interface OnboardingState {
  version: typeof ONBOARDING_STATE_VERSION;
  outcome: OnboardingOutcome;
  lastSatisfiedStep: OnboardingSatisfiedStep;
  selectedProviderId?: string;
}

export interface OnboardingSnapshot extends OnboardingState {
  profileReady: boolean;
  providerReady: boolean;
}

const outcomes = new Set<OnboardingOutcome>(["incomplete", "deferred", "completed"]);
const steps = new Set<OnboardingSatisfiedStep>(["none", "profile", "provider", "tour"]);

export function parseOnboardingState(value: unknown): OnboardingState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== ONBOARDING_STATE_VERSION ||
    typeof candidate.outcome !== "string" ||
    !outcomes.has(candidate.outcome as OnboardingOutcome) ||
    typeof candidate.lastSatisfiedStep !== "string" ||
    !steps.has(candidate.lastSatisfiedStep as OnboardingSatisfiedStep) ||
    (candidate.selectedProviderId !== undefined &&
      (typeof candidate.selectedProviderId !== "string" ||
        candidate.selectedProviderId.length === 0 ||
        candidate.selectedProviderId.length > 128))
  ) {
    return null;
  }
  return {
    version: ONBOARDING_STATE_VERSION,
    outcome: candidate.outcome as OnboardingOutcome,
    lastSatisfiedStep: candidate.lastSatisfiedStep as OnboardingSatisfiedStep,
    ...(typeof candidate.selectedProviderId === "string"
      ? { selectedProviderId: candidate.selectedProviderId }
      : {}),
  };
}

export function onboardingStepIndex(snapshot: OnboardingSnapshot): number {
  if (!snapshot.profileReady) return 0;
  if (!snapshot.providerReady) return 1;
  return 2;
}
