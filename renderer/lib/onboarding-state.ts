import { ONBOARDING_COMPLETE_STORAGE_KEY } from "../shared/onboarding.js";

export { ONBOARDING_COMPLETE_STORAGE_KEY } from "../shared/onboarding.js";

type OnboardingReadStorage = Pick<Storage, "getItem">;
type OnboardingWriteStorage = Pick<Storage, "setItem">;
type OnboardingRemoveStorage = Pick<Storage, "removeItem">;

export function shouldShowOnboarding(storage: OnboardingReadStorage = localStorage): boolean {
  return storage.getItem(ONBOARDING_COMPLETE_STORAGE_KEY) !== "true";
}

export function markOnboardingComplete(storage: OnboardingWriteStorage = localStorage): void {
  storage.setItem(ONBOARDING_COMPLETE_STORAGE_KEY, "true");
}

/** Compatibility cleanup for the retired renderer-owned completion marker. */
export function clearLegacyOnboardingCompletion(
  storage: OnboardingRemoveStorage = localStorage,
): void {
  storage.removeItem(ONBOARDING_COMPLETE_STORAGE_KEY);
}
