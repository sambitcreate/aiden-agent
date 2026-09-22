import { configStore } from "./config-store.js";
import { listConfiguredProviders } from "./provider-list-main.js";
import {
  ONBOARDING_STATE_VERSION,
  parseOnboardingState,
  type OnboardingOutcome,
  type OnboardingSnapshot,
  type OnboardingState,
} from "../../renderer/shared/onboarding.js";
import {
  assertOnboardingCanComplete,
  legacyOnboardingOutcome,
  legacyOnboardingEvidenceProvider,
  onboardingEvidenceProvider,
  onboardingProgressState,
  onboardingProviderReady,
  reconcileOnboardingOutcome,
} from "./onboarding-state-core.js";

async function readiness(allowLegacyEvidence = false): Promise<{
  profileReady: boolean;
  providerReady: boolean;
  selectedProviderId?: string;
}> {
  const [providers, settings] = await Promise.all([
    listConfiguredProviders(),
    configStore.getSettings(),
  ]);
  const progress = parseOnboardingState(settings.onboarding);
  // Outside one-time migration, static Pi catalogs and ambient credentials are
  // not validation evidence. Migration may retain the exact provider/model the
  // legacy app last used when it is still structurally ready today.
  const selected = onboardingEvidenceProvider(providers, progress) ??
    (allowLegacyEvidence && progress === null
      ? legacyOnboardingEvidenceProvider(
          providers,
          settings.lastProviderId,
          settings.lastModel,
        )
      : undefined);
  return {
    profileReady:
      progress?.lastSatisfiedStep !== undefined &&
      progress.lastSatisfiedStep !== "none" &&
      typeof settings.profileName === "string" &&
      settings.profileName.trim().length > 0,
    providerReady: selected !== undefined,
    ...(selected ? { selectedProviderId: selected.id } : {}),
  };
}

async function persist(
  state: OnboardingState,
  isCurrent: () => boolean = () => true,
): Promise<OnboardingState> {
  if (!isCurrent()) throw new Error("The onboarding window is no longer active.");
  const settings = await configStore.setSettings({ onboarding: state });
  const saved = parseOnboardingState(settings.onboarding);
  if (!saved) throw new Error("Aiden couldn't save onboarding progress.");
  return saved;
}

export async function getOnboardingSnapshot(
  legacyComplete = false,
  isCurrent: () => boolean = () => true,
): Promise<OnboardingSnapshot> {
  const [settings, ready] = await Promise.all([
    configStore.getSettings(),
    readiness(legacyComplete),
  ]);
  let state = parseOnboardingState(settings.onboarding);
  if (!state) {
    // Preserve existing installs without trusting the legacy renderer marker by
    // itself. A matching main-owned legacy provider/model selection may retain
    // completion; otherwise the unproven setup reopens as incomplete. Only an
    // explicit provider skip may create a deferred outcome.
    const migratedReady = {
      ...ready,
      profileReady:
        legacyComplete &&
        typeof settings.profileName === "string" &&
        settings.profileName.trim().length > 0,
    };
    state = await persist(
      onboardingProgressState(
        legacyOnboardingOutcome(
          legacyComplete,
          migratedReady.profileReady && migratedReady.providerReady,
        ),
        migratedReady,
      ),
      isCurrent,
    );
    return {
      ...state,
      profileReady: migratedReady.profileReady,
      providerReady: migratedReady.providerReady,
    };
  }
  const reconciledOutcome = reconcileOnboardingOutcome(state.outcome, ready);
  if (reconciledOutcome !== state.outcome) {
    state = await persist(onboardingProgressState(reconciledOutcome, ready), isCurrent);
  }
  return { ...state, profileReady: ready.profileReady, providerReady: ready.providerReady };
}

export async function setOnboardingProgress(
  step: "profile" | "provider",
  selectedProviderId?: string,
  isCurrent: () => boolean = () => true,
): Promise<OnboardingSnapshot> {
  const settings = await configStore.getSettings();
  const current = parseOnboardingState(settings.onboarding);
  const profileConfigured =
    typeof settings.profileName === "string" && settings.profileName.trim().length > 0;
  if (!profileConfigured) throw new Error("Choose a profile name before continuing.");
  if (step === "provider" && (!current || current.lastSatisfiedStep === "none")) {
    throw new Error("Finish the profile step before connecting a model provider.");
  }
  const ready = await readiness();
  if (step === "provider") {
    if (!selectedProviderId) throw new Error("A ready provider must be selected.");
    const providers = await listConfiguredProviders();
    if (
      !providers.some(
        (provider) => provider.id === selectedProviderId && onboardingProviderReady(provider),
      )
    ) {
      throw new Error("The selected model provider is not ready.");
    }
  }
  const state = await persist({
    version: ONBOARDING_STATE_VERSION,
    outcome: "incomplete",
    lastSatisfiedStep:
      step === "provider" ||
      current?.lastSatisfiedStep === "provider" ||
      current?.lastSatisfiedStep === "tour"
        ? "provider"
        : "profile",
    ...((selectedProviderId ?? current?.selectedProviderId)
      ? { selectedProviderId: selectedProviderId ?? current?.selectedProviderId }
      : {}),
  }, isCurrent);
  return {
    ...state,
    profileReady: true,
    providerReady: step === "provider" ? true : ready.providerReady,
  };
}

export async function setOnboardingOutcome(
  outcome: OnboardingOutcome,
  selectedProviderId?: string,
  isCurrent: () => boolean = () => true,
): Promise<OnboardingSnapshot> {
  if (outcome === "incomplete") {
    const ready = await readiness();
    const state = await persist(onboardingProgressState("incomplete", ready), isCurrent);
    return { ...state, profileReady: ready.profileReady, providerReady: ready.providerReady };
  }

  const ready = await readiness();
  if (outcome === "deferred" && !ready.profileReady) {
    throw new Error("Choose a profile name before skipping provider setup.");
  }
  if (outcome === "completed") assertOnboardingCanComplete(ready);
  if (
    outcome === "completed" &&
    selectedProviderId &&
    selectedProviderId !== ready.selectedProviderId
  ) {
    const providers = await listConfiguredProviders();
    if (
      !providers.some(
        (provider) => provider.id === selectedProviderId && onboardingProviderReady(provider),
      )
    ) {
      throw new Error("The selected model provider is not ready.");
    }
  }
  const state = await persist(
    {
      ...onboardingProgressState(outcome, ready),
      ...(outcome === "completed" && selectedProviderId ? { selectedProviderId } : {}),
      ...(outcome === "completed" ? { lastSatisfiedStep: "tour" as const } : {}),
    },
    isCurrent,
  );
  return {
    ...state,
    profileReady: ready.profileReady,
    providerReady: outcome === "completed" ? ready.providerReady : false,
  };
}
