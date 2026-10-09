import {
  Blocks,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Lock,
  LoaderCircle,
  Network,
  UserRound,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ProviderIcon } from "./provider-icon";
import { ProviderEditor } from "./settings/provider-editor";
import { BuiltinProviderEditor } from "./settings/builtin-provider-editor";
import { CodexProviderSettings } from "./settings/codex-provider-settings";
import { OnboardingOpenAiLogin } from "./onboarding-openai-login";
import { Button, Dialog, Field, Input, Text, toast } from "./ui";
import { appApi, botsApi, profileApi, providersApi } from "../lib/ipc";
import {
  clearLegacyOnboardingCompletion,
  markOnboardingComplete,
  shouldShowOnboarding,
} from "../lib/onboarding-state";
import {
  discoveredDefaultModel,
  fieldsAfterProviderChoiceChange,
  makeOnboardingProvider,
  visibleOnboardingFeatures,
  type OnboardingProviderChoice,
} from "../lib/onboarding-provider";
import {
  canConfigureOnboardingBuiltinProvider,
  getOnboardingMoreProviders,
  isOnboardingBuiltinProviderReady,
  onboardingBuiltinProviderSetupLabel,
  onboardingChatGptSelection,
} from "../lib/pi-provider-display";
import { queryKeys, useCodexProviderStatus, useProviders } from "../lib/queries";
import { persistModelSelection } from "../lib/use-model-selection";
import type { Provider } from "../lib/types";
import {
  onboardingStepIndex,
  shouldOpenOnboarding,
  type OnboardingSnapshot,
} from "../shared/onboarding";
import { useAppCapabilities } from "../lib/app-capabilities";
import { OnboardingBotsStep } from "./onboarding-bots-step";
import { OnboardingFeatureGallery, onboardingFeatures } from "./onboarding-feature-gallery";

type Step = "profile" | "provider" | "bots" | "tour";
const steps: Step[] = ["profile", "provider", "bots", "tour"];
const stepLabels: Readonly<Record<Step, string>> = {
  profile: "Your profile",
  provider: "Model provider",
  bots: "Your first Bot",
  tour: "Ready to go",
};

/** "Meet Your First Bot" appears only with the Bots capability and no Bots yet. */
function onboardingFlowSteps(botsStepVisible: boolean): Step[] {
  return botsStepVisible ? steps : steps.filter((item) => item !== "bots");
}

const APP_ICON_URL = new URL("../../resources/app-icon.png", import.meta.url).href;

const providerChoices: Array<{
  id: OnboardingProviderChoice;
  title: string;
  description: string;
  iconProviderId?: string;
  requiresKey?: boolean;
}> = [
  {
    id: "openai-key",
    title: "OpenAI API key",
    description: "Connect with your own API key.",
    iconProviderId: "openai",
    requiresKey: true,
  },
  {
    id: "openai-signin",
    title: "ChatGPT",
    description: "Connect through browser sign-in.",
    iconProviderId: "openai-codex",
  },
  {
    id: "anthropic",
    title: "Anthropic API key",
    description: "Connect with your Anthropic API key.",
    iconProviderId: "anthropic",
    requiresKey: true,
  },
  {
    id: "lmstudio",
    title: "LM Studio",
    description: "Use models running in LM Studio.",
    iconProviderId: "lmstudio",
  },
  {
    id: "ollama",
    title: "Ollama",
    description: "Use models running in Ollama.",
    iconProviderId: "ollama",
  },
  {
    id: "custom",
    title: "Other Custom Provider",
    description: "Connect your endpoint, then set its capabilities and effort selector in Model options.",
  },
  {
    id: "tailscale",
    title: "Tailscale custom model",
    description: "Connect a private server. Set its capabilities and effort selector in Model options.",
    iconProviderId: "tailscale",
  },
];

function OnboardingDialogShell({ children }: React.PropsWithChildren) {
  return (
    <DialogPrimitive.Root open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-60 bg-background" />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          data-onboarding-active="true"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          className="fixed inset-0 z-60 grid place-items-center bg-background px-4 pb-4 pt-11 outline-none max-[520px]:px-3 max-[520px]:pb-3"
        >
          <DialogPrimitive.Title className="sr-only">Set up Aiden</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Add your profile and a model connection, then review Aiden's core features.
          </DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function OnboardingFlow({
  onOpenBotChat,
}: {
  /** Opens a Bot's chat; called once onboarding finishes after Start Chat. */
  onOpenBotChat?(botId: string): void;
} = {}) {
  const queryClient = useQueryClient();
  const capabilities = useAppCapabilities();
  const visibleFeatureBentos = React.useMemo(
    () => visibleOnboardingFeatures(onboardingFeatures, { bots: capabilities.bots, computerUse: capabilities.computerUse, platform: capabilities.platform }),
    [capabilities.bots, capabilities.computerUse, capabilities.platform],
  );
  const providers = useProviders();
  const codexStatus = useCodexProviderStatus();
  // Main-owned state is authoritative. Block the workbench until it has been
  // checked so a stale legacy renderer marker cannot expose a bypass window.
  const [open, setOpen] = React.useState(true);
  const [stateReady, setStateReady] = React.useState(false);
  const [onboardingLoadError, setOnboardingLoadError] = React.useState<string | null>(null);
  const [index, setIndex] = React.useState(0);
  const [botsStepVisible, setBotsStepVisible] = React.useState(false);
  const capabilitiesRef = React.useRef(capabilities);
  capabilitiesRef.current = capabilities;
  const [name, setName] = React.useState("");
  const [choice, setChoice] = React.useState<OnboardingProviderChoice | null>("openai-signin");
  const [builtinChoiceId, setBuiltinChoiceId] = React.useState<string | null>(null);
  const [showMoreProviders, setShowMoreProviders] = React.useState(false);
  const [settingUpProvider, setSettingUpProvider] = React.useState<Provider | null>(null);
  const [customProvider, setCustomProvider] = React.useState<Provider | null>(null);
  const [apiKeyDialogChoice, setApiKeyDialogChoice] = React.useState<
    "openai-key" | "anthropic" | null
  >(null);
  const [apiKey, setApiKey] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [discovering, setDiscovering] = React.useState(false);
  const [providerError, setProviderError] = React.useState<string | null>(null);
  const [providerSkipped, setProviderSkipped] = React.useState(false);
  const onboardingSnapshotRef = React.useRef<OnboardingSnapshot | null>(null);
  const readyProviderIdRef = React.useRef<string | null>(null);
  const savingRef = React.useRef(false);
  const scrollContainerRef = React.useRef<HTMLElement>(null);
  const profileInitializedRef = React.useRef(false);
  const loadGenerationRef = React.useRef(0);

  const loadOnboarding = React.useCallback(
    async (reopen = false) => {
      const generation = loadGenerationRef.current + 1;
      loadGenerationRef.current = generation;
      setStateReady(false);
      setOnboardingLoadError(null);
      try {
        const snapshot = reopen
          ? await appApi.setOnboardingOutcome("incomplete")
          : await appApi.getOnboardingState(!shouldShowOnboarding());
        if (loadGenerationRef.current !== generation) return;
        onboardingSnapshotRef.current = snapshot;
        readyProviderIdRef.current = snapshot.selectedProviderId ?? null;
        setProviderSkipped(false);
        // Only a first run that is still open can reach the Bots step; completed
        // launches never read the Bot store here.
        const botsVisible =
          shouldOpenOnboarding(snapshot.outcome) &&
          capabilitiesRef.current.bots &&
          (await botsApi.list().then(
            (bots) => bots.length === 0,
            () => false,
          ));
        if (loadGenerationRef.current !== generation) return;
        const reached = onboardingStepIndex(snapshot);
        const resumeStep: Step =
          reached === 0
            ? "profile"
            : reached === 1
              ? "provider"
              : snapshot.lastSatisfiedStep === "provider" && botsVisible
                ? "bots"
                : "tour";
        setBotsStepVisible(botsVisible);
        setIndex(onboardingFlowSteps(botsVisible).indexOf(resumeStep));
        setOpen(shouldOpenOnboarding(snapshot.outcome));
        if (snapshot.profileReady && !profileInitializedRef.current) {
          const current = await profileApi.get();
          profileInitializedRef.current = true;
          setName(current.name);
          queryClient.setQueryData(queryKeys.profile, current);
        }
        setStateReady(true);
        if (reopen) clearLegacyOnboardingCompletion();
      } catch (error) {
        if (loadGenerationRef.current !== generation) return;
        setOnboardingLoadError(
          error instanceof Error ? error.message : "Aiden couldn't load onboarding progress.",
        );
        setOpen(true);
      }
    },
    [queryClient],
  );

  React.useEffect(() => {
    void loadOnboarding();
    const reopen = () => void loadOnboarding(true);
    window.addEventListener("aiden:show-onboarding", reopen);
    return () => window.removeEventListener("aiden:show-onboarding", reopen);
  }, [loadOnboarding]);

  React.useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "auto" });
    const frame = requestAnimationFrame(() => {
      scrollContainerRef.current?.querySelector<HTMLElement>("h2")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [index, open]);

  /** The starter Bot Start Chat made; its chat opens when onboarding finishes. */
  const startedBotIdRef = React.useRef<string | null>(null);

  if (!open) return null;
  const visibleSteps = onboardingFlowSteps(botsStepVisible);
  const step = visibleSteps[index];
  const afterProviderIndex = visibleSteps.indexOf(botsStepVisible ? "bots" : "tour");
  const selected = providerChoices.find((item) => item.id === choice);
  const moreProviders = getOnboardingMoreProviders(providers.data ?? []);
  const selectedBuiltinProvider = moreProviders.find((provider) => provider.id === builtinChoiceId);
  const openAiLoginProvider = providers.data?.find((provider) => provider.id === "openai" && provider.isBuiltin);
  const hasProviderChoice = Boolean(selected || selectedBuiltinProvider);
  const chatGptSelection = onboardingChatGptSelection(openAiLoginProvider, codexStatus.data);
  const nextBlockedReason =
    stateReady && step === "provider" && choice === "openai-signin" && !chatGptSelection
      ? "Sign in with ChatGPT to continue, or choose another connection."
      : undefined;
  const canContinue = !stateReady
    ? false
    : step === "profile"
      ? name.trim().length > 0
      : step === "provider"
        ? choice === "openai-signin"
          ? Boolean(chatGptSelection)
          : hasProviderChoice
        : true;

  const selectProviderChoice = (nextChoice: OnboardingProviderChoice | null) => {
    const nextFields = fieldsAfterProviderChoiceChange(choice, nextChoice, { apiKey, baseUrl });
    setApiKey(nextFields.apiKey);
    setBaseUrl(nextFields.baseUrl);
    setChoice(nextChoice);
    setProviderError(null);
  };

  const completeProviderStep = async (providerId: string) => {
    const snapshot = await appApi.setOnboardingProgress("provider", providerId);
    onboardingSnapshotRef.current = snapshot;
    readyProviderIdRef.current = providerId;
    setProviderSkipped(false);
    setIndex(afterProviderIndex);
  };

  const finishBotsStep = async (startedBotId?: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const snapshot = await appApi.setOnboardingProgress("bots");
      onboardingSnapshotRef.current = snapshot;
      startedBotIdRef.current = startedBotId ?? null;
      setIndex(visibleSteps.indexOf("tour"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden couldn't save onboarding progress.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const validateHostedApiKey = async () => {
    const hostedChoice = apiKeyDialogChoice;
    if (!hostedChoice || savingRef.current) return;
    const key = apiKey.trim();
    if (!key) {
      setProviderError("Paste an API key before continuing.");
      return;
    }
    const providerId = hostedChoice === "openai-key" ? "openai" : "anthropic";
    savingRef.current = true;
    setSaving(true);
    setDiscovering(true);
    setProviderError(null);
    try {
      const validation = await providersApi.validateOnboardingApiKey(providerId, key);
      const saved = validation.provider;
      queryClient.setQueryData<Provider[]>(queryKeys.providers, (current) => {
        const without = (current ?? []).filter((item) => item.id !== saved.id);
        return [...without, saved];
      });
      const model = saved.defaultModel ?? saved.models[0];
      if (!model) throw new Error("Credentials were accepted, but no chat models are available.");
      persistModelSelection(saved.id, model);
      setApiKeyDialogChoice(null);
      setApiKey("");
      setProviderSkipped(false);
      await completeProviderStep(saved.id);
      if (validation.catalogWarning) toast.warning(validation.catalogWarning);
      else toast.success(`${saved.label} credentials accepted.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't validate that API key.";
      setProviderError(message);
    } finally {
      setDiscovering(false);
      savingRef.current = false;
      setSaving(false);
    }
  };

  const skipProvider = () => {
    if (!stateReady || savingRef.current) return;
    selectProviderChoice(null);
    setBuiltinChoiceId(null);
    setApiKeyDialogChoice(null);
    setShowMoreProviders(false);
    setProviderSkipped(true);
    readyProviderIdRef.current = null;
    setIndex(afterProviderIndex);
  };

  const openCustomProvider = () =>
    setCustomProvider(
      (current) =>
        current ?? {
          id: `custom:${crypto.randomUUID()}`,
          kind: "openai",
          label: "Custom Provider",
          baseUrl: "",
          models: [],
          needsKey: true,
          hasKey: false,
          deployment: "hosted",
        },
    );

  const next = async () => {
    if (!canContinue || savingRef.current) return;
    if (step === "profile") {
      savingRef.current = true;
      setSaving(true);
      try {
        const saved = await profileApi.setName(name);
        profileInitializedRef.current = true;
        queryClient.setQueryData(queryKeys.profile, saved);
        const snapshot = await appApi.setOnboardingProgress("profile");
        onboardingSnapshotRef.current = snapshot;
        setIndex(1);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't save your profile name.");
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
      return;
    }
    if (step === "provider") {
      if (selectedBuiltinProvider) {
        if (isOnboardingBuiltinProviderReady(selectedBuiltinProvider)) {
          const model = selectedBuiltinProvider.defaultModel ?? selectedBuiltinProvider.models[0];
          persistModelSelection(selectedBuiltinProvider.id, model);
          await completeProviderStep(selectedBuiltinProvider.id);
        } else {
          setSettingUpProvider(selectedBuiltinProvider);
        }
        return;
      }
      if (!choice || !selected) {
        toast.error("Choose a model provider before continuing.");
        return;
      }
      if (choice === "openai-signin") {
        if (!chatGptSelection) {
          setProviderError("Complete ChatGPT sign-in before continuing.");
          return;
        }
        persistModelSelection(chatGptSelection.providerId, chatGptSelection.model);
        await completeProviderStep(chatGptSelection.providerId);
        return;
      }
      if (choice === "custom") {
        openCustomProvider();
        return;
      }
      if (choice === "tailscale" && !baseUrl.trim()) {
        toast.error("Enter the Tailscale model server URL before continuing.");
        return;
      }
      if (choice === "openai-key" || choice === "anthropic") {
        setApiKeyDialogChoice(choice);
        return;
      }
      savingRef.current = true;
      setSaving(true);
      setProviderError(null);
      try {
        const isLocalRuntime = choice === "lmstudio" || choice === "ollama";
        const needsEndpointDiscovery = isLocalRuntime || choice === "tailscale";
        // Resolve reserved local identities from a fresh main-process snapshot.
        // The query cache may still be loading or stale when the user clicks Next.
        const currentProviders = isLocalRuntime
          ? await providersApi.list()
          : (providers.data ?? []);
        if (isLocalRuntime) {
          queryClient.setQueryData(queryKeys.providers, currentProviders);
        }
        let providerToSave = makeOnboardingProvider(choice, baseUrl.trim(), currentProviders);
        if (providerToSave && needsEndpointDiscovery) {
          let discovery: Awaited<ReturnType<typeof providersApi.test>>;
          try {
            setDiscovering(true);
            discovery = await providersApi.test(providerToSave);
          } catch (error) {
            const message = `Couldn't reach ${selected.title}: ${error instanceof Error ? error.message : String(error)}`;
            setProviderError(message);
            return;
          } finally {
            setDiscovering(false);
          }
          const defaultModel = discoveredDefaultModel(providerToSave, discovery);
          if (!defaultModel) {
            const message =
              "Endpoint reached, but no chat models were found. Load one in the server, then try again.";
            setProviderError(message);
            return;
          }
          providerToSave = {
            ...providerToSave,
            models: discovery.models,
            modelMetadata: discovery.modelMetadata,
            defaultModel,
          };
        }
        if (providerToSave) {
          const saved = await providersApi.save(
            providerToSave,
            selected.requiresKey ? apiKey.trim() : undefined,
          );
          queryClient.setQueryData<Provider[]>(queryKeys.providers, (current) => {
            const without = (current ?? []).filter((item) => item.id !== saved.id);
            return [...without, saved];
          });
          persistModelSelection(saved.id, saved.defaultModel ?? providerToSave.defaultModel!);
          await completeProviderStep(saved.id);
          toast.success(`${saved.label} added.`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Couldn't add that provider.";
        setProviderError(message);
      } finally {
        setDiscovering(false);
        savingRef.current = false;
        setSaving(false);
      }
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const selectedProviderId = providerSkipped
        ? undefined
        : (readyProviderIdRef.current ?? onboardingSnapshotRef.current?.selectedProviderId);
      const snapshot = await appApi.setOnboardingOutcome(
        providerSkipped || !selectedProviderId ? "deferred" : "completed",
        selectedProviderId,
      );
      onboardingSnapshotRef.current = snapshot;
      markOnboardingComplete();
      setOpen(false);
      const startedBotId = startedBotIdRef.current;
      startedBotIdRef.current = null;
      if (startedBotId) onOpenBotChat?.(startedBotId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden couldn't finish onboarding.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <OnboardingDialogShell>
      <section
        aria-busy={saving || undefined}
        aria-label="Set up Aiden"
        className="relative grid h-[min(600px,calc(100vh-60px))] min-h-0 w-[min(860px,calc(100vw-32px))] grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-dialog bg-popover shadow-onboarding max-[760px]:h-full max-[760px]:w-full max-[760px]:grid-cols-1"
      >
        <div className="drag-region absolute left-0 right-0 top-0 h-10" />
        <aside className="border-r border-separator bg-sidebar px-5 pb-5 pt-7 max-[760px]:hidden">
          <div className="flex h-full flex-col justify-between">
            <div>
              <img
                alt=""
                aria-hidden="true"
                draggable={false}
                src={APP_ICON_URL}
                className="size-14"
              />
              <Text as="h1" variant="heading1" className="mt-5 block text-heading2">
                Set up Aiden
              </Text>
              <Text as="p" variant="small" color="secondary" className="mt-2 block leading-5">
                Add your profile and one model connection. You can change either later in Settings.
              </Text>
            </div>
            <ol className="space-y-2" aria-label="Setup progress">
              {visibleSteps.map((item, itemIndex) => (
                <li
                  key={item}
                  aria-current={itemIndex === index ? "step" : undefined}
                  className={`flex items-center gap-2 ${itemIndex <= index ? "text-primary" : "text-tertiary"}`}
                >
                  <span
                    className={`grid size-5 shrink-0 place-items-center rounded-full text-mini font-semibold ${itemIndex <= index ? "bg-accent text-accent-foreground" : "bg-control"}`}
                  >
                    {itemIndex < index ? <Check className="size-3" /> : itemIndex + 1}
                  </span>
                  <Text variant="small-strong" color={itemIndex <= index ? "primary" : "tertiary"}>
                    {stepLabels[item]}
                  </Text>
                </li>
              ))}
            </ol>
          </div>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-col">
          <header className="drag-region flex h-14 shrink-0 items-center justify-between gap-4 border-b border-separator px-6 max-[520px]:px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <img
                alt=""
                aria-hidden="true"
                draggable={false}
                src={APP_ICON_URL}
                className="hidden size-8 max-[760px]:block"
              />
              <Text variant="small-strong" color="secondary">
                Step {index + 1} of {visibleSteps.length}
              </Text>
            </div>
            {step === "provider" ? (
              <Button
                className="no-drag relative z-10 h-7 px-2"
                size="small"
                variant="transparent"
                disabled={!stateReady || saving}
                onClick={skipProvider}
              >
                Skip provider
              </Button>
            ) : null}
          </header>

          <main
            ref={scrollContainerRef}
            data-onboarding-scroll
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 max-[520px]:px-4"
          >
            {onboardingLoadError ? (
              <div role="alert" className="mb-4 rounded-card bg-status-red-surface p-3">
                <Text variant="small" color="status-red">
                  {onboardingLoadError}
                </Text>
                <Button
                  className="mt-2"
                  size="small"
                  variant="filled"
                  onClick={() => void loadOnboarding()}
                >
                  Try again
                </Button>
              </div>
            ) : null}
            {!stateReady && !onboardingLoadError ? (
              <div className="grid min-h-48 place-items-center" role="status" aria-live="polite">
                <div className="flex items-center gap-2 text-secondary">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  <Text variant="small" color="secondary">
                    Checking setup…
                  </Text>
                </div>
              </div>
            ) : null}
            {stateReady && step === "profile" ? (
              <div className="max-w-md">
                <div className="flex items-start gap-3">
                  <UserRound className="mt-0.5 size-5 shrink-0 text-accent" />
                  <div>
                    <Text
                      as="h2"
                      tabIndex={-1}
                      variant="heading1"
                      className="block text-heading2 outline-none"
                    >
                      What should Aiden call you?
                    </Text>
                    <Text as="p" variant="small" color="secondary" className="mt-1.5 block">
                      This personalizes your profile and model context on this device.
                    </Text>
                  </div>
                </div>
                <label className="mt-6 block">
                  <Text variant="small-strong">Name</Text>
                  <Input
                    className="mt-2 h-10 border-transparent bg-input hover:border-transparent focus:border-transparent"
                    disabled={saving}
                    value={name}
                    maxLength={80}
                    placeholder="Your name"
                    onChange={(event) => setName(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void next();
                    }}
                  />
                </label>
                <div className="mt-4 flex items-center gap-2 text-secondary">
                  <Lock className="size-4 text-accent" />
                  <Text variant="small" color="secondary">
                    Stored privately on this device.
                  </Text>
                </div>
              </div>
            ) : null}

            {stateReady && step === "provider" ? (
              <div>
                <div className="flex items-start gap-3">
                  <Network className="mt-0.5 size-5 shrink-0 text-accent" />
                  <div>
                    <Text
                      as="h2"
                      tabIndex={-1}
                      variant="heading1"
                      className="block text-heading2 outline-none"
                    >
                      Connect your AI
                    </Text>
                    <Text as="p" variant="small" color="secondary" className="mt-1.5 block">
                      Choose one connection to get started.
                    </Text>
                  </div>
                </div>
                <Text as="p" variant="small" color="secondary" className="mt-3 max-w-2xl leading-5" data-onboarding-tts-privacy>
                  Read aloud is separate and off by default. Configure it later in Settings → Text to Speech.
                  Pressing the speaker sends the latest response text to Google, even for local-model replies;
                  Google charges may apply. Paired phones and tablets use this same desktop setup;
                  they cannot enable or configure Read aloud themselves. This setup screen does not send speech requests.
                </Text>
                <Text as="p" variant="small" color="secondary" className="mt-3 max-w-2xl leading-5">
                  Settings → Memory also offers optional prompt cache warming. It is off by default;
                  enabling it allows paid refresh requests during active desktop chats when estimated savings justify the cost.
                </Text>
                <div className="mt-4 grid grid-cols-2 gap-2 max-[560px]:grid-cols-1">
                  {providerChoices
                    .filter((item) =>
                      ["openai-signin", "lmstudio", "ollama", "custom"].includes(item.id),
                    )
                    .map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        disabled={saving}
                        aria-pressed={choice === item.id}
                        className={`flex min-h-[68px] items-start gap-2.5 rounded-control px-3 py-2.5 text-left outline-none transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${choice === item.id ? "bg-list-selection" : "bg-well hover:bg-control"}`}
                        onClick={() => {
                          selectProviderChoice(item.id);
                          setBuiltinChoiceId(null);
                          setProviderSkipped(false);
                          if (item.id === "custom") openCustomProvider();
                          if (item.id === "openai-key" || item.id === "anthropic") {
                            setApiKeyDialogChoice(item.id);
                          }
                        }}
                      >
                        <span className="grid size-8 shrink-0 place-items-center text-primary">
                          {item.iconProviderId ? (
                            <ProviderIcon
                              providerId={item.iconProviderId}
                              providerLabel={item.title}
                              className="size-5"
                            />
                          ) : (
                            <Network className="size-5" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <Text variant="small-strong" className="block">
                            {item.title}
                          </Text>
                          <Text
                            variant="small"
                            color="secondary"
                            className="mt-0.5 block leading-4"
                          >
                            {item.description}
                          </Text>
                        </span>
                        <Check
                          aria-hidden="true"
                          className={`mt-0.5 size-4 shrink-0 text-accent ${choice === item.id ? "opacity-100" : "opacity-0"}`}
                        />
                      </button>
                    ))}
                </div>
                {choice === "openai-signin" ? (
                  <div className="mt-3">
                    <OnboardingOpenAiLogin
                      available={openAiLoginProvider?.authMethods?.some((method) => method.type === "oauth" && method.canLogin) === true}
                      disabled={saving}
                      onConnect={() => {
                        if (openAiLoginProvider) setSettingUpProvider(openAiLoginProvider);
                      }}
                    />
                    <details className="mt-3">
                      <summary className="cursor-pointer rounded-control text-small text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring">
                        Existing Codex connection
                      </summary>
                      <CodexProviderSettings layer="onboarding" />
                    </details>
                  </div>
                ) : null}
                <button
                  data-onboarding-more-provider-trigger
                  type="button"
                  disabled={saving}
                  aria-controls="onboarding-more-providers"
                  aria-expanded={showMoreProviders}
                  className="mt-2 flex min-h-12 w-full items-center gap-2.5 rounded-control border border-transparent bg-well px-3 py-2 text-left outline-none transition-colors duration-150 hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
                  onClick={() => setShowMoreProviders((visible) => !visible)}
                >
                  <span className="grid size-8 shrink-0 place-items-center text-secondary">
                    <Blocks className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <Text variant="small-strong" className="block">
                      Other ways
                    </Text>
                    <Text variant="small" color="secondary" className="mt-0.5 block leading-4">
                      {providers.isLoading
                        ? "Loading provider catalog…"
                        : selectedBuiltinProvider
                          ? `${selectedBuiltinProvider.label} selected`
                          : "API keys and more AI services"}
                    </Text>
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className={`size-4 shrink-0 text-tertiary transition-transform duration-150 ${showMoreProviders ? "rotate-180" : ""}`}
                  />
                </button>

                {showMoreProviders ? (
                  <div
                    id="onboarding-more-providers"
                    data-onboarding-more-providers
                    className="mt-2 rounded-card bg-well p-2"
                  >
                    <div className="grid grid-cols-2 gap-1.5 max-[560px]:grid-cols-1">
                      {providerChoices
                        .filter((item) =>
                          ["openai-key", "anthropic", "tailscale"].includes(item.id),
                        )
                        .map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            disabled={saving}
                            aria-pressed={choice === item.id}
                            className={`flex min-h-14 items-center gap-2.5 rounded-control border border-transparent px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50 ${choice === item.id ? "bg-list-selection" : "bg-transparent hover:bg-control"}`}
                            onClick={() => {
                              selectProviderChoice(item.id);
                              setBuiltinChoiceId(null);
                              setProviderSkipped(false);
                              if (item.id === "openai-key" || item.id === "anthropic") {
                                setApiKeyDialogChoice(item.id);
                              }
                            }}
                          >
                            <span className="grid size-8 shrink-0 place-items-center rounded-control bg-popover text-primary shadow-control">
                              {item.iconProviderId ? (
                                <ProviderIcon
                                  providerId={item.iconProviderId}
                                  providerLabel={item.title}
                                  className="size-4.5"
                                />
                              ) : (
                                <Network className="size-4.5" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <Text variant="small-strong" truncate className="block">
                                {item.title}
                              </Text>
                              <Text
                                variant="small"
                                color="tertiary"
                                truncate
                                className="mt-0.5 block"
                              >
                                {item.description}
                              </Text>
                            </span>
                            <Check
                              aria-hidden="true"
                              className={`size-4 shrink-0 text-accent ${choice === item.id ? "opacity-100" : "opacity-0"}`}
                            />
                          </button>
                        ))}
                    </div>
                    {providers.isLoading && moreProviders.length === 0 ? (
                      <Text variant="small" color="secondary" className="block px-2 py-3">
                        Loading provider catalog…
                      </Text>
                    ) : providers.isError && moreProviders.length === 0 ? (
                      <div
                        role="alert"
                        className="flex items-center justify-between gap-3 px-2 py-2"
                      >
                        <Text variant="small" color="secondary">
                          More providers could not be loaded.
                        </Text>
                        <Button
                          variant="filled"
                          size="small"
                          onClick={() => void providers.refetch()}
                        >
                          Try again
                        </Button>
                      </div>
                    ) : moreProviders.length === 0 ? (
                      <Text variant="small" color="secondary" className="block px-2 py-3">
                        No additional providers are available.
                      </Text>
                    ) : (
                      <div className="grid grid-cols-2 gap-1.5 max-[560px]:grid-cols-1">
                        {moreProviders.map((provider) => {
                          const canChoose = canConfigureOnboardingBuiltinProvider(provider);
                          const isSelected = builtinChoiceId === provider.id;
                          return (
                            <button
                              key={provider.id}
                              type="button"
                              disabled={!canChoose || saving}
                              aria-pressed={isSelected}
                              className={`flex min-h-14 items-center gap-2.5 rounded-control border border-transparent px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50 ${isSelected ? "bg-list-selection" : "bg-transparent hover:bg-control"}`}
                              onClick={() => {
                                selectProviderChoice(null);
                                setBuiltinChoiceId(provider.id);
                                setProviderSkipped(false);
                                if (!isOnboardingBuiltinProviderReady(provider)) {
                                  setSettingUpProvider(provider);
                                }
                              }}
                            >
                              <span className="grid size-8 shrink-0 place-items-center rounded-control bg-popover text-primary shadow-control">
                                <ProviderIcon
                                  providerId={provider.id}
                                  providerLabel={provider.label}
                                  className="size-4.5"
                                />
                              </span>
                              <span className="min-w-0 flex-1">
                                <Text variant="small-strong" truncate className="block">
                                  {provider.label}
                                </Text>
                                <Text
                                  variant="small"
                                  color="tertiary"
                                  truncate
                                  className="mt-0.5 block"
                                >
                                  {onboardingBuiltinProviderSetupLabel(provider)}
                                </Text>
                              </span>
                              <Check
                                aria-hidden="true"
                                className={`size-4 shrink-0 text-accent ${isSelected ? "opacity-100" : "opacity-0"}`}
                              />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}
                <div className="mt-4 grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
                  {choice === "tailscale" ? (
                    <label>
                      <Text variant="small-strong">Model URL</Text>
                      <Input
                        className="mt-2 border-transparent bg-input hover:border-transparent focus:border-transparent"
                        disabled={saving}
                        value={baseUrl}
                        placeholder={"http://model.tailnet.ts.net:11434/v1"}
                        onChange={(event) => setBaseUrl(event.currentTarget.value)}
                      />
                    </label>
                  ) : null}
                </div>
                {providerError ? (
                  <Text role="alert" variant="small" color="red" className="mt-3 block">
                    {providerError}
                  </Text>
                ) : null}
              </div>
            ) : null}

            {stateReady && step === "bots" ? (
              <OnboardingBotsStep
                onStarted={(bot) => void finishBotsStep(bot.id)}
                onSkip={() => void finishBotsStep()}
              />
            ) : null}

            {stateReady && step === "tour" ? (
              <div>
                {providerSkipped ? (
                  <div className="mb-4 rounded-card bg-well px-4 py-3">
                    <Text variant="small-strong" className="block">
                      Provider setup skipped
                    </Text>
                    <Text variant="small" color="secondary" className="mt-1 block">
                      Add one anytime from Settings → Providers.
                    </Text>
                  </div>
                ) : null}
                <div className="flex items-start gap-3">
                  <Check className="mt-0.5 size-5 shrink-0 text-accent" />
                  <div>
                    <Text
                      as="h2"
                      tabIndex={-1}
                      variant="heading1"
                      className="block text-heading2 outline-none"
                    >
                      Everything Aiden brings together
                    </Text>
                    <Text as="p" variant="small" color="secondary" className="mt-1.5 block">
                      Explore all {visibleFeatureBentos.length} shipped features. Scroll, then hover or
                      focus a tile to learn more.
                    </Text>
                    <Text as="p" variant="small" color="tertiary" className="mt-1 block">
                      Phone and tablet access starts off. After setup, choose Connect a device in
                      Settings → Connections; Aiden must stay running, and Tailscale is
                      optional.
                    </Text>
                  </div>
                </div>
                <OnboardingFeatureGallery features={visibleFeatureBentos} platform={capabilities.platform} />
              </div>
            ) : null}
          </main>

          <footer
            data-onboarding-footer
            className="flex shrink-0 items-center justify-between border-t border-separator px-6 py-4 max-[520px]:px-4"
          >
            <Button
              variant="transparent"
              disabled={!stateReady || index === 0 || saving}
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
            >
              <ChevronLeft /> Back
            </Button>
            <div className="flex min-w-0 items-center gap-3">
              {nextBlockedReason ? (
                <Text
                  id="onboarding-next-blocked-reason"
                  variant="small"
                  color="secondary"
                  className="min-w-0 text-right max-[520px]:hidden"
                >
                  {nextBlockedReason}
                </Text>
              ) : null}
              {step !== "bots" ? (
                <Button
                  variant="accent"
                  pressFeedback
                  disabled={!stateReady || !canContinue || saving}
                  aria-describedby={nextBlockedReason ? "onboarding-next-blocked-reason" : undefined}
                  onClick={() => void next()}
                >
                  {discovering
                    ? choice === "openai-key" || choice === "anthropic"
                      ? "Validating key…"
                      : "Discovering models…"
                    : saving && step === "provider"
                      ? "Adding provider…"
                      : step === "tour"
                        ? "Start using Aiden"
                        : "Next"}{" "}
                  <ChevronRight />
                </Button>
              ) : null}
            </div>
          </footer>
        </div>
      </section>
      {customProvider ? (
        <ProviderEditor
          provider={customProvider}
          open
          layer="onboarding"
          requireReady
          onOpenChange={(open) => {
            if (!open) setCustomProvider(null);
          }}
          onSaved={async () => {
            const refreshed = await providersApi.list();
            queryClient.setQueryData(queryKeys.providers, refreshed);
            const ready = refreshed.find((provider) => provider.id === customProvider.id);
            const model = ready?.defaultModel;
            if (!ready || !model || !ready.models.includes(model))
              throw new Error("Choose an available default model before continuing.");
            await completeProviderStep(ready.id);
            persistModelSelection(ready.id, model);
          }}
        />
      ) : null}
      {settingUpProvider ? (
        <BuiltinProviderEditor
          provider={settingUpProvider}
          open
          layer="onboarding"
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setSettingUpProvider(null);
          }}
          onSaved={() => {
            void (async () => {
              const refreshed = await providersApi.list();
              queryClient.setQueryData(queryKeys.providers, refreshed);
              const ready = refreshed.find(
                (provider) =>
                  provider.id === settingUpProvider.id &&
                  isOnboardingBuiltinProviderReady(provider),
              );
              if (!ready) {
                setProviderError(
                  `${settingUpProvider.label} is configured but does not have an available chat model yet.`,
                );
                return;
              }
              const model = ready.defaultModel ?? ready.models[0];
              persistModelSelection(ready.id, model);
              await completeProviderStep(ready.id);
              setSettingUpProvider(null);
            })().catch((error: unknown) => {
              setProviderError(
                error instanceof Error ? error.message : "Couldn't verify that provider.",
              );
            });
          }}
        />
      ) : null}
      <Dialog
        open={apiKeyDialogChoice !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !saving) {
            setApiKeyDialogChoice(null);
            setApiKey("");
            setProviderError(null);
          }
        }}
        layer="onboarding"
        title={`Connect ${apiKeyDialogChoice === "openai-key" ? "OpenAI" : "Anthropic"}`}
        description="Paste your API key to verify the connection. Validation does not send a chat message, and the key is stored encrypted on this device."
        confirmLabel={discovering ? "Validating…" : "Validate & continue"}
        confirmDisabled={!apiKey.trim()}
        dismissDisabled={saving}
        busy={saving}
        onConfirm={validateHostedApiKey}
      >
        <Field
          label="API key"
          description="You can replace or remove this key later in Settings → Providers."
          orientation="vertical"
          className="rounded-card bg-well p-4 after:hidden"
        >
          <Input
            autoFocus
            type="password"
            autoComplete="off"
            aria-invalid={providerError ? true : undefined}
            className="border-transparent bg-input hover:border-transparent focus:border-transparent"
            disabled={saving}
            value={apiKey}
            placeholder="Paste your API key"
            onChange={(event) => {
              setApiKey(event.currentTarget.value);
              setProviderError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void validateHostedApiKey();
            }}
          />
          {providerError ? (
            <Text role="alert" variant="small" color="red" className="block">
              {providerError}
            </Text>
          ) : null}
        </Field>
      </Dialog>
    </OnboardingDialogShell>
  );
}
