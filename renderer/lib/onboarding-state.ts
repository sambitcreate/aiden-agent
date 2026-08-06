export const ONBOARDING_COMPLETE_STORAGE_KEY = "aiden:onboarding:v1:complete";

type OnboardingStorage = Pick<Storage, "getItem" | "setItem">;

export function shouldShowOnboarding(storage: OnboardingStorage = localStorage): boolean {
  return storage.getItem(ONBOARDING_COMPLETE_STORAGE_KEY) !== "true";
}

export function markOnboardingComplete(storage: OnboardingStorage = localStorage): void {
  storage.setItem(ONBOARDING_COMPLETE_STORAGE_KEY, "true");
}
