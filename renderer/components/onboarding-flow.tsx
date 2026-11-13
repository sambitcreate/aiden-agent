import {
  LoaderCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Lock,
  Network,
  UserRound,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ProviderEditor } from "./settings/provider-editor";
import { BuiltinProviderEditor } from "./settings/builtin-provider-editor";
import { CodexProviderSettings } from "./settings/codex-provider-settings";
import { Button, Input, Text, toast } from "./ui";
import { UsageDataNotice, UsageDataOnboardingRow } from "./usage-data";
import { analyticsApi, appApi, botsApi, profileApi, providersApi, settingsApi } from "../lib/ipc";
import { useBrowserSurfaceBlocker } from "../lib/link-opener";
import {
  clearLegacyOnboardingCompletion,
  markOnboardingComplete,
  shouldShowOnboarding,
} from "../lib/onboarding-state";
import { localProviderDraft, visibleOnboardingFeatures } from "../lib/onboarding-provider";
import { GuidedProviderChooser, type ConnectionRoute } from "./guided-provider-chooser";
import { ProviderKeyDialog } from "./provider-key-dialog";
import { GeminiVoiceSetupDialog } from "./settings/gemini-voice-setup-dialog";
import { ProviderModelVisibility } from "./settings/provider-model-visibility";
import { LocalProviderDialog } from "./local-provider-dialog";
import { availableChatModel } from "../lib/provider-chat-readiness";
import { queryKeys, useCodexProviderStatus, useProviders, useSettings } from "../lib/queries";
import { persistModelSelection } from "../lib/use-model-selection";
import type { Provider, GeminiUsageScope } from "../lib/types";
import {
  onboardingStepIndex,
  shouldOpenOnboarding,
  type OnboardingSnapshot,
} from "../shared/onboarding";
import { useAppCapabilities } from "../lib/app-capabilities";
import { focusRegionWhenShown } from "../lib/focus-regions";
import { acceptFirstBotAccess, OnboardingBotsStep, type FirstBotAccess } from "./onboarding-bots-step";
import { OnboardingFeatureGallery, onboardingFeatures } from "./onboarding-feature-gallery";

const visibleSteps = ["profile", "provider", "tour"] as const;
const stepLabels = { profile: "Your name", provider: "Connect AI", tour: "Finish setup" };
const APP_ICON_URL = new URL("../../resources/app-icon.png", import.meta.url).href;

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
    () =>
      visibleOnboardingFeatures(onboardingFeatures, {
        bots: capabilities.bots,
        botComputers: capabilities.botComputers,
        computerUse: capabilities.computerUse,
        designMode: capabilities.designMode,
        platform: capabilities.platform,
      }),
    [capabilities.bots, capabilities.botComputers, capabilities.computerUse, capabilities.designMode, capabilities.platform],
  );
  const providers = useProviders();
  const settings = useSettings();
  const attempt = React.useRef(0);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const continueRef = React.useRef<HTMLButtonElement>(null);
  const returnFocus = () => triggerRef.current?.isConnected ? triggerRef.current : continueRef.current;
  const codexStatus = useCodexProviderStatus();
  // Main-owned state is authoritative. Block the workbench until it has been
  // checked so a stale legacy renderer marker cannot expose a bypass window.
  const [open, setOpen] = React.useState(true);
  const [stateReady, setStateReady] = React.useState(false);
  const [onboardingLoadError, setOnboardingLoadError] = React.useState<string | null>(null);
  const [index, setIndex] = React.useState(0);
  // The first Bot's step; its hand-off stays on show after the step is saved.
  const [firstBotShown, setFirstBotShown] = React.useState(false);
  // Finish waits while the first Bot is being made, so its chat can open.
  const [creatingBot, setCreatingBot] = React.useState(false);
  const capabilitiesRef = React.useRef(capabilities);
  capabilitiesRef.current = capabilities;
  const [name, setName] = React.useState("");
  const [route, setRoute] = React.useState<ConnectionRoute | null>(null);
  const [customProvider, setCustomProvider] = React.useState<Provider | null>(null);
  const [connected, setConnected] = React.useState<{ id: string; label: string; model: string } | null>(null);
  const [googleScope, setGoogleScope] = React.useState<GeminiUsageScope | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [providerError, setProviderError] = React.useState<string | null>(null);
  const [providerSkipped, setProviderSkipped] = React.useState(false);
  const onboardingSnapshotRef = React.useRef<OnboardingSnapshot | null>(null);
  const readyProviderIdRef = React.useRef<string | null>(null);
  const savingRef = React.useRef(false);
  const [usageShownEnabled, setUsageShownEnabled] = React.useState(false);
  const scrollContainerRef = React.useRef<HTMLElement>(null);
  const profileInitializedRef = React.useRef(false);
  const loadGenerationRef = React.useRef(0);
  // The one-time usage-data notice is for people who finished onboarding
  // before it existed. A new install sees the row on the last step instead.
  const [usageNoticeEligible, setUsageNoticeEligible] = React.useState(false);

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
        attempt.current++;
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
        setFirstBotShown(botsVisible && snapshot.lastSatisfiedStep !== "bots");
        setIndex(onboardingStepIndex(snapshot));
        setProviderSkipped(!snapshot.selectedProviderId && snapshot.lastSatisfiedStep === "bots");
        setConnected(null);
        setRoute(null);
        setCustomProvider(null);
        setProviderError(null);
        startedBotIdRef.current = null;
        setOpen(shouldOpenOnboarding(snapshot.outcome));
        setUsageNoticeEligible(!reopen && !shouldOpenOnboarding(snapshot.outcome));
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

  /** The first Bot onboarding made; its chat opens when onboarding finishes. */
  const startedBotIdRef = React.useRef<string | null>(null);
  /** How the first Bot may act; accepted only when the person presses Start using Aiden. */
  const firstBotAccessRef = React.useRef<FirstBotAccess | null>(null);

  // While this overlay is drawn over the app, links behind it (e.g. in a
  // provider editor) must go straight to the system browser, never prompt or
  // open a tab hidden behind the overlay.
  useBrowserSurfaceBlocker(open);

  if (!open) return usageNoticeEligible ? <UsageDataNotice /> : null;
  const step = visibleSteps[index];
  const canContinue = stateReady && (step === "profile" ? name.trim().length > 0 : step === "provider" ? Boolean(connected) : true);
  const routeAttempt = attempt.current;
  const confirmConnection = async (p: Pick<Provider, "id" | "label" | "defaultModel" | "models" | "needsKey" | "hasKey">) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
    const currentSettings = await settingsApi.get();
    if (routeAttempt !== attempt.current) return;
    const model = availableChatModel(p, currentSettings);
    if (!model)
      throw new Error("This connection has no available chat model. Check model visibility and chat access in Settings → Providers.");
    setProviderSkipped(false);
    setProviderError(null);
    setConnected({ id: p.id, label: p.label, model });
  };

  const confirmExisting = async (provider: Provider) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try { await confirmConnection(provider); }
    catch (cause) { setProviderError(cause instanceof Error ? cause.message : "Couldn’t use this connection."); }
    finally { savingRef.current = false; setSaving(false); }
  };

  const finishBotsStep = async (startedBotId?: string, access?: FirstBotAccess) => {
    if (savingRef.current) return;
    startedBotIdRef.current = startedBotId ?? null;
    firstBotAccessRef.current = access ?? null;
    savingRef.current = true;
    setSaving(true);
    try {
      onboardingSnapshotRef.current = await appApi.setOnboardingProgress("bots");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t save the Bot setup step.");
    } finally { savingRef.current = false; setSaving(false); }
  };

  const skipProvider = () => {
    if (!stateReady || savingRef.current) return;
    attempt.current++;
    setRoute(null);
    setConnected(null);
    setProviderSkipped(true);
    readyProviderIdRef.current = null;
    setIndex(2);
  };

  const chooseConnection = (nextRoute: ConnectionRoute, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    attempt.current++;
    setProviderError(null);
    if (nextRoute.kind === "endpoint") {
      const tailnet = nextRoute.template === "tailnet";
      const existing = tailnet ? providers.data?.find(p => p.id === "custom:onboarding-tailscale" && !p.isBuiltin) : undefined;
      setCustomProvider(existing ?? {
        id: tailnet ? "custom:onboarding-tailscale" : `custom:${crypto.randomUUID()}`, label: tailnet ? "Tailscale model server" : "Custom Provider", kind: "openai",
        baseUrl: "", needsKey: !tailnet, hasKey: false, models: [], deployment: tailnet ? "local" : "hosted",
      });
    }
    setRoute(nextRoute);
  };
  const builtin = route?.kind === "builtin" ? route.provider : null;
  const keyId = route?.kind === "builtin" && route.method === "api_key" &&
    (builtin?.id === "anthropic" || builtin?.id === "openai") ? builtin.id : null;
  const codexProvider = codexStatus.data?.configured && codexStatus.data.needsAttention === false
    ? { id: "openai-codex", label: "ChatGPT / Codex", kind: "openai" as const, baseUrl: "",
        models: codexStatus.data.models.map(m => m.id), needsKey: true, hasKey: true }
    : null;
  const existingConnections = (providers.data ?? []).filter(p => p.id !== "openai-codex" && (!p.isBuiltin || p.hasKey || p.canLogout));
  const needsGoogleChatAccess = (provider: Provider) =>
    provider.id === "google" && provider.hasKey && settings.data?.geminiUsageScope === "transcription_only";
  const repairConnection = (provider: Provider, trigger: HTMLButtonElement) => {
    if (needsGoogleChatAccess(provider)) {
      triggerRef.current = trigger;
      setGoogleScope("transcription_only");
    } else if (provider.isBuiltin) {
      chooseConnection({ kind: "builtin", provider }, trigger);
    } else {
      triggerRef.current = trigger;
      setCustomProvider(provider);
    }
  };
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
      if (!connected) return;
      savingRef.current = true;
      setSaving(true);
      try {
        onboardingSnapshotRef.current = await appApi.setOnboardingProgress("provider", connected.id);
        readyProviderIdRef.current = connected.id;
        persistModelSelection(connected.id, connected.model);
        setIndex(2);
      } catch (cause) {
        setProviderError(cause instanceof Error ? cause.message : "Couldn’t save the connection. Choose it again to retry.");
        setConnected(null);
      } finally {
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
      if (usageShownEnabled) await analyticsApi.markNoticeShown("ok").catch(() => undefined);
      const snapshot = await appApi.setOnboardingOutcome(
        providerSkipped || !selectedProviderId ? "deferred" : "completed",
        selectedProviderId,
      );
      onboardingSnapshotRef.current = snapshot;
      markOnboardingComplete();
      setOpen(false);
      const startedBotId = startedBotIdRef.current;
      const firstBotAccess = firstBotAccessRef.current;
      startedBotIdRef.current = null;
      firstBotAccessRef.current = null;
      if (startedBotId) {
        onOpenBotChat?.(startedBotId);
        // This press is the person's go-ahead for the Full access the step described.
        if (firstBotAccess) {
          void acceptFirstBotAccess(startedBotId, firstBotAccess).catch((error: unknown) =>
            toast.error(error instanceof Error ? error.message : "Your Bot couldn’t start yet."),
          );
        }
      }
      // Ready to type: the message box takes focus once it's on screen.
      focusRegionWhenShown("composer");
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
                    className={`grid size-5 shrink-0 place-items-center rounded-full text-mini font-semibold ${itemIndex <= index ? "bg-fill-accent text-fill-accent-foreground" : "bg-control"}`}
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
            {step === "provider" && !connected ? (
              <Button
                className="no-drag relative z-10 h-7 px-2"
                size="small"
                variant="transparent"
                disabled={!stateReady || saving}
                onClick={skipProvider}
              >
                Set up later
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
                  <UserRound className="mt-0.5 size-5 shrink-0 text-accent-text" />
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
                  <Lock className="size-4 text-accent-text" />
                  <Text variant="small" color="secondary">
                    Stored privately on this device.
                  </Text>
                </div>
              </div>
            ) : null}

            {stateReady && step === "provider" ? (
              <div>
                <div className="flex items-start gap-3">
                  <Network className="mt-0.5 size-5 shrink-0 text-accent-text" />
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
                      Choose something you already use.
                    </Text>
                  </div>
                </div>
                <div className="mt-4 grid gap-3">
                  {connected ? <div role="status" className="settings-card p-4">
                    <Text variant="strong">{connected.label} is ready for chat</Text>
                    <Text as="p" variant="small" color="secondary">{connected.model}</Text>
                    <Button size="small" variant="transparent" disabled={saving} onClick={() => { setRoute(null); setConnected(null); }}>Choose another connection</Button>
                  </div> : <>
                    {providers.isLoading ? <Text role="status">Loading providers…</Text> : providers.isError ?
                      <div role="alert">Couldn’t load providers. <Button onClick={() => void providers.refetch()}>Try again</Button></div> : <>
                      {settings.data && existingConnections.map(p => availableChatModel(p, settings.data) ?
                        <Button key={p.id} variant="filled" disabled={saving} onClick={() => void confirmExisting(p)}>Use this connection: {p.label}</Button> :
                        <Button key={p.id} variant="filled" disabled={saving} onClick={e => repairConnection(p, e.currentTarget)}>
                          {needsGoogleChatAccess(p) ? "Review chat access" : "Finish connection"}: {p.label}
                        </Button>)}
                      {codexProvider && availableChatModel(codexProvider, settings.data) &&
                        <Button variant="filled" disabled={saving} onClick={() => void confirmExisting(codexProvider)}>Use this connection: ChatGPT / Codex</Button>}
                      <GuidedProviderChooser providers={providers.data ?? []} disabled={saving} onChoose={chooseConnection} onBack={() => { attempt.current++; setRoute(null); setProviderError(null); }} />
                    </>}
                    {route?.kind === "codex" && <div className="grid gap-2">
                      <CodexProviderSettings layer="onboarding" />
                      {codexProvider && !availableChatModel(codexProvider, settings.data) && <details className="settings-card p-3">
                        <summary>Advanced model visibility</summary><ProviderModelVisibility provider={codexProvider} />
                      </details>}
                    </div>}
                  </>}
                </div>
                {providerError ? (
                  <Text role="alert" variant="small" color="red" className="mt-3 block">
                    {providerError}
                  </Text>
                ) : null}
              </div>
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
                  <Check className="mt-0.5 size-5 shrink-0 text-accent-text" />
                  <div>
                    <Text
                      as="h2"
                      tabIndex={-1}
                      variant="heading1"
                      className="block text-heading2 outline-none"
                    >
                      Finish setup
                    </Text>
                  </div>
                </div>
                <UsageDataOnboardingRow onDisplay={setUsageShownEnabled} />
                {firstBotShown ? <OnboardingBotsStep onBusyChange={setCreatingBot} onReady={(bot, access) => void finishBotsStep(bot.id, access)} /> : null}
                <details className="settings-card mt-3 px-4 py-3">
                  <summary className="cursor-pointer text-small-strong">Explore Aiden’s features</summary>
                  <OnboardingFeatureGallery features={visibleFeatureBentos} platform={capabilities.platform} />
                </details>
                <details className="settings-card mt-3 px-4 py-3">
                  <summary className="cursor-pointer text-small-strong">Other features and privacy</summary>
                    <Text as="p" variant="small" color="tertiary" className="mt-1 block">
                      Phone and tablet access starts off. After setup, choose Connect a device in
                      Settings → Connections; Aiden must stay running, and Tailscale is
                      optional. Paired computers can switch between verified local-network and Tailscale
                      routes. If delivery is uncertain, review the saved request before choosing Retry.
                    </Text>
                <Text as="p" variant="small" color="secondary" className="mt-3 max-w-2xl leading-5" data-onboarding-tts-privacy>
                  Read aloud is separate and off by default. Configure it later in Settings → Voice & Speech → Text to Speech.
                  Pressing the speaker sends the latest response text to Google, even for local-model replies;
                  Google charges may apply. Paired phones and tablets use this same desktop setup;
                  they cannot enable or configure Read aloud themselves. This setup screen does not send speech requests.
                </Text>
                <Text as="p" variant="small" color="secondary" className="mt-3 max-w-2xl leading-5">
                  Settings → Context & Limits also offers optional prompt cache warming. It is off by default;
                  enabling it allows paid refresh requests during active desktop chats when estimated savings justify the cost.
                </Text>
                <Text as="p" variant="small" color="secondary" className="mt-3 max-w-2xl leading-5">
                  Image generation uses its own keys, added later in Settings → Image Generation. The connection you
                  choose here is never used for images.
                </Text>
                </details>
              </div>
            ) : null}
          </main>

          <footer
            data-onboarding-footer
            className="flex shrink-0 items-center justify-between border-t border-separator px-6 py-4 max-[520px]:px-4"
          >
            <Button
              variant="transparent"
              disabled={!stateReady || index === 0 || saving || creatingBot}
              onClick={() => { attempt.current++; setRoute(null); setIndex(value => Math.max(0, value - 1)); }}
            >
              <ChevronLeft /> Back
            </Button>
            <div className="flex min-w-0 items-center gap-3">
              {(step !== "provider" || connected) && <Button ref={continueRef} variant="accent" pressFeedback
                disabled={!canContinue || saving || creatingBot} onClick={() => void next()}>
                {step === "tour" ? "Start using Aiden" : step === "provider" ? "Continue setup" : "Next"} <ChevronRight />
              </Button>}
            </div>
          </footer>
        </div>
      </section>
      {customProvider ? (
        <ProviderEditor
          provider={customProvider}
          returnFocus={returnFocus}
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
            if (!ready) throw new Error("Couldn’t read the saved connection.");
            await confirmConnection(ready);
          }}
        />
      ) : null}
      {route?.kind === "local" && <LocalProviderDialog returnFocus={returnFocus} runtime={route.runtime} layer="onboarding" onSaved={confirmConnection}
        onClose={() => setRoute(null)} onEdit={() => {
          const existing = providers.data?.find(p => p.id === `custom:${route.runtime}`);
          setCustomProvider(existing ?? { ...localProviderDraft(route.runtime), hasKey: false });
          setRoute(null);
        }} />}
      {googleScope && <GeminiVoiceSetupDialog open layer="onboarding" activatesVoice={false} returnFocus={returnFocus}
        scope={googleScope} hasKey={existingConnections.some(p => p.id === "google" && p.hasKey)} busy={saving} error={providerError} provider={existingConnections.find(p => p.id === "google")}
        onScopeChange={setGoogleScope} onOpenChange={open => { if (!open) setGoogleScope(null); }}
        onConfirm={async () => {
          if (savingRef.current) return;
          savingRef.current = true; setSaving(true); setProviderError(null);
          try {
            queryClient.setQueryData(queryKeys.settings, await settingsApi.setGeminiUsageScope(googleScope));
            if (googleScope === "models_and_transcription") {
              const refreshed = await providersApi.list();
              queryClient.setQueryData(queryKeys.providers, refreshed);
              const google = refreshed.find(provider => provider.id === "google");
              if (!google) throw new Error("Couldn’t read the saved Google connection.");
              await confirmConnection(google);
            }
            setGoogleScope(null);
          } catch (cause) { setProviderError(cause instanceof Error ? cause.message : "Couldn’t save Google chat access."); }
          finally { savingRef.current = false; setSaving(false); }
        }} />}
      {keyId && <ProviderKeyDialog returnFocus={returnFocus} id={keyId} layer="onboarding" onSaved={confirmConnection} onClose={() => setRoute(null)} />}
      {builtin && !keyId && route?.kind === "builtin" && <BuiltinProviderEditor
        returnFocus={returnFocus} provider={builtin} method={route.method} open layer="onboarding"
        onOpenChange={nextOpen => { if (!nextOpen && attempt.current === routeAttempt) { attempt.current++; setRoute(null); } }}
        onSaved={async () => {
          const refreshed = await providersApi.list();
          queryClient.setQueryData(queryKeys.providers, refreshed);
          const ready = refreshed.find(p => p.id === builtin.id);
          if (!ready) throw new Error("Couldn’t read the saved connection.");
          const currentSettings = await settingsApi.get();
          if (routeAttempt !== attempt.current) return;
          if (ready.id === "google" && currentSettings.geminiUsageScope === "transcription_only") {
            setRoute(null);
            setGoogleScope("transcription_only");
            return;
          }
          await confirmConnection(ready);
        }} />}
    </OnboardingDialogShell>
  );
}
