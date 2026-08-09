import { ONBOARDING_COMPLETE_STORAGE_KEY } from "../shared/onboarding.js";

export { ONBOARDING_COMPLETE_STORAGE_KEY } from "../shared/onboarding.js";

type OnboardingStorage = Pick<Storage, "getItem" | "setItem">;

export function shouldShowOnboarding(storage: OnboardingStorage = localStorage): boolean {
  return storage.getItem(ONBOARDING_COMPLETE_STORAGE_KEY) !== "true";
}

export function markOnboardingComplete(storage: OnboardingStorage = localStorage): void {
  storage.setItem(ONBOARDING_COMPLETE_STORAGE_KEY, "true");
}
