import {
  Bot,
  Blocks,
  BrainCircuit,
  CalendarClock,
  ChartBar,
  ChartScatter,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Command,
  Eye,
  FileDiff,
  Files,
  FolderGit2,
  GitBranch,
  Globe2,
  Lock,
  LoaderCircle,
  MessageSquare,
  Mic2,
  MousePointer2,
  Network,
  Palette,
  Plug,
  Send,
  ShieldCheck,
  SquareTerminal,
  Smartphone,
  UserRound,
  UsersRound,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ProviderIcon } from "./provider-icon";
import { BuiltinProviderEditor } from "./settings/builtin-provider-editor";
import { CodexProviderSettings } from "./settings/codex-provider-settings";
import { Button, Dialog, Field, Input, Switch, Text, toast } from "./ui";
import { appApi, profileApi, providersApi, webSearchApi } from "../lib/ipc";
import {
  clearLegacyOnboardingCompletion,
  markOnboardingComplete,
  shouldShowOnboarding,
} from "../lib/onboarding-state";
import {
  discoveredDefaultModel,
  fieldsAfterProviderChoiceChange,
  makeOnboardingProvider,
  type OnboardingProviderChoice,
} from "../lib/onboarding-provider";
import {
  canConfigureOnboardingBuiltinProvider,
  getOnboardingMoreProviders,
  isOnboardingBuiltinProviderReady,
  onboardingBuiltinProviderSetupLabel,
} from "../lib/pi-provider-display";
import { queryKeys, useCodexProviderStatus, useProviders, useWebSearch } from "../lib/queries";
import { persistModelSelection } from "../lib/use-model-selection";
import type { Provider } from "../lib/types";
import {
  onboardingStepIndex,
  shouldOpenOnboarding,
  type OnboardingSnapshot,
} from "../shared/onboarding";

type Step = "profile" | "provider" | "tour";
const steps: Step[] = ["profile", "provider", "tour"];
const stepLabels: Readonly<Record<Step, string>> = {
  profile: "Your profile",
  provider: "Model provider",
  tour: "Ready to go",
};

const APP_ICON_URL = new URL("../../resources/app-icon.png", import.meta.url).href;

const FEATURE_ILLUSTRATIONS = {
  workspace: new URL("../assets/onboarding/aiden-workspace.png", import.meta.url).href,
  computerUse: new URL("../assets/onboarding/features/computer-use.png", import.meta.url).href,
  subagents: new URL("../assets/onboarding/features/native-subagents.png", import.meta.url).href,
  filesEditor: new URL("../assets/onboarding/features/files-editor.png", import.meta.url).href,
  reviewDiffs: new URL("../assets/onboarding/features/review-diffs.png", import.meta.url).href,
  terminal: new URL("../assets/onboarding/features/terminal.png", import.meta.url).href,
  gitWorkflows: new URL("../assets/onboarding/features/git-workflows.png", import.meta.url).href,
  workspaces: new URL("../assets/onboarding/features/workspaces-worktrees.png", import.meta.url)
    .href,
  models: new URL("../assets/onboarding/features/model-freedom.png", import.meta.url).href,
  modelPad: new URL("../assets/onboarding/features/model-pad.png", import.meta.url).href,
  thinking: new URL("../assets/onboarding/features/thinking-controls.png", import.meta.url).href,
  vision: new URL("../assets/onboarding/features/attachments-vision.png", import.meta.url).href,
  webSearch: new URL("../assets/onboarding/features/web-search.png", import.meta.url).href,
  skills: new URL("../assets/onboarding/features/skills.png", import.meta.url).href,
  mcp: new URL("../assets/onboarding/features/mcp-connectors.png", import.meta.url).href,
  assistant: new URL("../assets/onboarding/features/aiden-assistant.png", import.meta.url).href,
  bots: new URL("../assets/onboarding/features/bots.png", import.meta.url).href,
  schedules: new URL("../assets/onboarding/features/scheduled-automations.png", import.meta.url)
    .href,
  voice: new URL("../assets/onboarding/features/voice-dictation.png", import.meta.url).href,
  commands: new URL("../assets/onboarding/features/command-palette.png", import.meta.url).href,
  usage: new URL("../assets/onboarding/features/usage-profile.png", import.meta.url).href,
  permissions: new URL("../assets/onboarding/features/permissions.png", import.meta.url).href,
  themes: new URL("../assets/onboarding/features/themes-accessibility.png", import.meta.url).href,
  telegram: new URL("../assets/onboarding/features/telegram-remote-control.png", import.meta.url)
    .href,
  aidenOnTheGo: new URL("../assets/onboarding/features/aiden-on-the-go.png", import.meta.url).href,
} as const;

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
    title: "ChatGPT sign in",
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
    id: "tailscale",
    title: "Tailscale custom model",
    description: "Connect to a private model on your tailnet.",
  },
];

type FeatureGroupId = "create" | "extend" | "control";
type FeatureBentoSize = "hero" | "tall" | "standard" | "wide";
type FeatureBentoId = keyof typeof FEATURE_ILLUSTRATIONS;

interface FeatureBento {
  id: FeatureBentoId;
  group: FeatureGroupId;
  title: string;
  description: string;
  icon: LucideIcon;
  imageUrl: string;
  size: FeatureBentoSize;
}

const featureGroups: ReadonlyArray<{ id: FeatureGroupId; title: string }> = [
  { id: "create", title: "Build in your workspace" },
  { id: "extend", title: "Choose and extend" },
  { id: "control", title: "Automate and stay in control" },
];

const featureBentos: FeatureBento[] = [
  {
    id: "workspace",
    group: "create",
    title: "Workspace Agent",
    description: "Read, search, edit, and run commands inside the workspace you choose.",
    icon: MessageSquare,
    imageUrl: FEATURE_ILLUSTRATIONS.workspace,
    size: "hero",
  },
  {
    id: "computerUse",
    group: "create",
    title: "Computer Use",
    description: "Inspect and operate Mac apps when you opt in, with approval before every action.",
    icon: MousePointer2,
    imageUrl: FEATURE_ILLUSTRATIONS.computerUse,
    size: "tall",
  },
  {
    id: "subagents",
    group: "create",
    title: "Native Subagents",
    description: "Delegate scout, planner, and reviewer jobs, then inspect their live results.",
    icon: UsersRound,
    imageUrl: FEATURE_ILLUSTRATIONS.subagents,
    size: "standard",
  },
  {
    id: "filesEditor",
    group: "create",
    title: "Files & Text Editor",
    description: "Browse, search, edit, and safely save workspace text files beside the chat.",
    icon: Files,
    imageUrl: FEATURE_ILLUSTRATIONS.filesEditor,
    size: "standard",
  },
  {
    id: "reviewDiffs",
    group: "create",
    title: "Review & Diffs",
    description: "Inspect staged, unstaged, and branch-to-branch diffs before you commit.",
    icon: FileDiff,
    imageUrl: FEATURE_ILLUSTRATIONS.reviewDiffs,
    size: "standard",
  },
  {
    id: "terminal",
    group: "create",
    title: "Integrated Terminal",
    description:
      "Run a workspace shell in tabs or split panes, then reopen it with sanitized local history.",
    icon: SquareTerminal,
    imageUrl: FEATURE_ILLUSTRATIONS.terminal,
    size: "standard",
  },
  {
    id: "gitWorkflows",
    group: "create",
    title: "Git Workflows",
    description: "Switch branches, create reviewed commits, and push with stale-state guards.",
    icon: GitBranch,
    imageUrl: FEATURE_ILLUSTRATIONS.gitWorkflows,
    size: "wide",
  },
  {
    id: "workspaces",
    group: "create",
    title: "Workspaces & Worktrees",
    description:
      "Keep chats grouped with folders, scratch spaces, and isolated worktrees in one workspace outline.",
    icon: FolderGit2,
    imageUrl: FEATURE_ILLUSTRATIONS.workspaces,
    size: "wide",
  },
  {
    id: "models",
    group: "extend",
    title: "Model Freedom",
    description: "Choose from 30+ Pi providers, ChatGPT sign-in, Apple models, or local endpoints.",
    icon: Blocks,
    imageUrl: FEATURE_ILLUSTRATIONS.models,
    size: "hero",
  },
  {
    id: "modelPad",
    group: "extend",
    title: "Personal Model Pad",
    description:
      "Arrange favorite models on your own map; an optional benchmark-only OpenRouter key never imports its model catalog. Live catalog checks happen only when you choose provider setup or Update model catalogs; ordinary browsing stays offline.",
    icon: ChartScatter,
    imageUrl: FEATURE_ILLUSTRATIONS.modelPad,
    size: "tall",
  },
  {
    id: "thinking",
    group: "extend",
    title: "Thinking Controls",
    description: "Tune supported models' reasoning effort and follow thinking as it streams.",
    icon: BrainCircuit,
    imageUrl: FEATURE_ILLUSTRATIONS.thinking,
    size: "standard",
  },
  {
    id: "vision",
    group: "extend",
    title: "Attachments & Vision",
    description:
      "Attach images directly to vision models, explicitly choose an image-understanding companion for a text-only Bot, and let the workspace agent show raster images inline.",
    icon: Eye,
    imageUrl: FEATURE_ILLUSTRATIONS.vision,
    size: "standard",
  },
  {
    id: "webSearch",
    group: "extend",
    title: "Web Search",
    description:
      "Search the live web when needed—on by default with anonymous Exa, with a reviewed provider zoo in Settings.",
    icon: Globe2,
    imageUrl: FEATURE_ILLUSTRATIONS.webSearch,
    size: "standard",
  },
  {
    id: "skills",
    group: "extend",
    title: "Reusable Skills",
    description: "Create reusable instructions, then type $ to attach one to your next message.",
    icon: Wand2,
    imageUrl: FEATURE_ILLUSTRATIONS.skills,
    size: "wide",
  },
  {
    id: "mcp",
    group: "extend",
    title: "MCP Connectors",
    description: "Connect services or any MCP server and expose only the tools you enable.",
    icon: Plug,
    imageUrl: FEATURE_ILLUSTRATIONS.mcp,
    size: "wide",
  },
  {
    id: "assistant",
    group: "control",
    title: "Aiden Assistant",
    description: "Ask about the app and prepare confirmed automations from a private dock.",
    icon: Bot,
    imageUrl: FEATURE_ILLUSTRATIONS.assistant,
    size: "hero",
  },
  {
    id: "bots",
    group: "control",
    title: "Reusable Bots",
    description:
      "Create reusable teammates with durable instructions, one persistent chat, explicit image understanding, access controls, and Telegram control.",
    icon: Bot,
    imageUrl: FEATURE_ILLUSTRATIONS.bots,
    size: "standard",
  },
  {
    id: "schedules",
    group: "control",
    title: "Scheduled Automations",
    description:
      "Ask Aiden in any chat to schedule recurring work, review its unattended access, then run, change, or pause it anytime.",
    icon: CalendarClock,
    imageUrl: FEATURE_ILLUSTRATIONS.schedules,
    size: "tall",
  },
  {
    id: "voice",
    group: "control",
    title: "Voice & Dictation",
    description:
      "Speak in the composer or dictate system-wide. Keep audio on-device with Parakeet, or explicitly connect cloud transcription and review what it can access.",
    icon: Mic2,
    imageUrl: FEATURE_ILLUSTRATIONS.voice,
    size: "standard",
  },
  {
    id: "commands",
    group: "control",
    title: "Command Palette",
    description: "Use Command-K or / for app commands, and $ to attach a reusable skill.",
    icon: Command,
    imageUrl: FEATURE_ILLUSTRATIONS.commands,
    size: "standard",
  },
  {
    id: "telegram",
    group: "control",
    title: "Aiden in Telegram",
    description:
      "Use models, skills, files, voice, queues, and trusted workspace automation from your paired account.",
    icon: Send,
    imageUrl: FEATURE_ILLUSTRATIONS.telegram,
    size: "standard",
  },
  {
    id: "aidenOnTheGo",
    group: "control",
    title: "Aiden On The Go",
    description: "Pair your iPhone or iPad over pinned local HTTPS or a private Tailscale route.",
    icon: Smartphone,
    imageUrl: FEATURE_ILLUSTRATIONS.aidenOnTheGo,
    size: "standard",
  },
  {
    id: "usage",
    group: "control",
    title: "Private Usage Profile",
    description: "See on-device activity, token mix, cost coverage, and your top models.",
    icon: ChartBar,
    imageUrl: FEATURE_ILLUSTRATIONS.usage,
    size: "standard",
  },
  {
    id: "permissions",
    group: "control",
    title: "Permissioned by Default",
    description: "Choose No access, Ask first, or Full per workspace; keys stay encrypted.",
    icon: ShieldCheck,
    imageUrl: FEATURE_ILLUSTRATIONS.permissions,
    size: "wide",
  },
  {
    id: "themes",
    group: "control",
    title: "Themes & Accessibility",
    description: "Tune light or dark themes, fonts, contrast, motion, and diff markers.",
    icon: Palette,
    imageUrl: FEATURE_ILLUSTRATIONS.themes,
    size: "wide",
  },
];

const FEATURE_LAYOUTS: Readonly<Record<FeatureBentoSize, string>> = {
  hero: "col-span-4 row-span-2 max-[560px]:col-span-2 max-[420px]:col-span-1",
  tall: "col-span-2 row-span-2 max-[560px]:col-span-1 max-[420px]:col-span-1",
  standard: "col-span-2 max-[560px]:col-span-1 max-[420px]:col-span-1",
  wide: "col-span-3 max-[560px]:col-span-2 max-[420px]:col-span-1",
};

const FEATURE_IMAGE_LAYOUTS: Readonly<Record<FeatureBentoSize, string>> = {
  hero: "-right-3 -top-3 h-[116%] w-[72%] object-right",
  tall: "left-1/2 top-1 h-[72%] w-[92%] -translate-x-1/2 object-center",
  standard: "right-1 top-1 size-[76px] object-center",
  wide: "right-1 top-0 h-full w-[46%] object-right",
};

function FeatureBentoVisual({ feature }: { feature: FeatureBento }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      draggable={false}
      src={feature.imageUrl}
      className={`pointer-events-none absolute object-contain ${FEATURE_IMAGE_LAYOUTS[feature.size]}`}
    />
  );
}

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

export function OnboardingFlow() {
  const queryClient = useQueryClient();
  const providers = useProviders();
  const codexStatus = useCodexProviderStatus();
  const webSearch = useWebSearch();
  // Main-owned state is authoritative. Block the workbench until it has been
  // checked so a stale legacy renderer marker cannot expose a bypass window.
  const [open, setOpen] = React.useState(true);
  const [stateReady, setStateReady] = React.useState(false);
  const [onboardingLoadError, setOnboardingLoadError] = React.useState<string | null>(null);
  const [index, setIndex] = React.useState(0);
  const [name, setName] = React.useState("");
  const [choice, setChoice] = React.useState<OnboardingProviderChoice | null>("openai-signin");
  const [builtinChoiceId, setBuiltinChoiceId] = React.useState<string | null>(null);
  const [showMoreProviders, setShowMoreProviders] = React.useState(false);
  const [settingUpProvider, setSettingUpProvider] = React.useState<Provider | null>(null);
  const [apiKeyDialogChoice, setApiKeyDialogChoice] = React.useState<
    "openai-key" | "anthropic" | null
  >(null);
  const [apiKey, setApiKey] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [discovering, setDiscovering] = React.useState(false);
  const [providerError, setProviderError] = React.useState<string | null>(null);
  const [providerSkipped, setProviderSkipped] = React.useState(false);
  const [webSearchSaving, setWebSearchSaving] = React.useState(false);
  const onboardingSnapshotRef = React.useRef<OnboardingSnapshot | null>(null);
  const readyProviderIdRef = React.useRef<string | null>(null);
  const savingRef = React.useRef(false);
  const webSearchSavingRef = React.useRef(false);
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
        setIndex(onboardingStepIndex(snapshot));
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

  if (!open) return null;
  const step = steps[index];
  const selected = providerChoices.find((item) => item.id === choice);
  const moreProviders = getOnboardingMoreProviders(providers.data ?? []);
  const selectedBuiltinProvider = moreProviders.find((provider) => provider.id === builtinChoiceId);
  const hasProviderChoice = Boolean(selected || selectedBuiltinProvider);
  const codexReady =
    codexStatus.data?.configured === true &&
    codexStatus.data.needsAttention === false &&
    codexStatus.data.models.length > 0;
  const canContinue = !stateReady
    ? false
    : step === "profile"
      ? name.trim().length > 0
      : step === "provider"
        ? choice === "openai-signin"
          ? codexReady
          : hasProviderChoice
        : true;

  const selectProviderChoice = (nextChoice: OnboardingProviderChoice | null) => {
    const nextFields = fieldsAfterProviderChoiceChange(choice, nextChoice, { apiKey, baseUrl });
    setApiKey(nextFields.apiKey);
    setBaseUrl(nextFields.baseUrl);
    setChoice(nextChoice);
    setProviderError(null);
  };

  const setWebSearchEnabled = async (enabled: boolean) => {
    if (!webSearch.data || webSearchSavingRef.current) return;
    const focusTarget =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    webSearchSavingRef.current = true;
    setWebSearchSaving(true);
    try {
      // The migration/default decision stays main-owned. Onboarding only
      // persists an explicit user choice through the fenced generic seam.
      const next = await webSearchApi.setEnabled(enabled);
      queryClient.setQueryData(queryKeys.webSearch, next);
    } catch (error) {
      if (focusTarget?.isConnected) requestAnimationFrame(() => focusTarget.focus());
      toast.error(error instanceof Error ? error.message : "Couldn’t update Web Search.");
    } finally {
      webSearchSavingRef.current = false;
      setWebSearchSaving(false);
    }
  };

  const completeProviderStep = async (providerId: string) => {
    const snapshot = await appApi.setOnboardingProgress("provider", providerId);
    onboardingSnapshotRef.current = snapshot;
    readyProviderIdRef.current = providerId;
    setProviderSkipped(false);
    setIndex(2);
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
      toast.error(message);
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
    setIndex(2);
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
        const model = codexStatus.data?.models[0]?.id;
        if (!codexReady || !model) {
          setProviderError("Complete ChatGPT sign-in before continuing.");
          return;
        }
        persistModelSelection("openai-codex", model);
        await completeProviderStep("openai-codex");
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
            toast.error(message);
            return;
          } finally {
            setDiscovering(false);
          }
          const defaultModel = discoveredDefaultModel(providerToSave, discovery);
          if (!defaultModel) {
            const message =
              "Endpoint reached, but no chat models were found. Load one in the server, then try again.";
            setProviderError(message);
            toast.info(message);
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
        toast.error(message);
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
              <Text as="h1" variant="heading1" className="mt-5 block text-[20px] leading-6">
                Set up Aiden
              </Text>
              <Text as="p" variant="small" color="secondary" className="mt-2 block leading-5">
                Add your profile and one model connection. You can change either later in Settings.
              </Text>
            </div>
            <ol className="space-y-2" aria-label="Setup progress">
              {steps.map((item, itemIndex) => (
                <li
                  key={item}
                  aria-current={itemIndex === index ? "step" : undefined}
                  className={`flex items-center gap-2 ${itemIndex <= index ? "text-primary" : "text-tertiary"}`}
                >
                  <span
                    className={`grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${itemIndex <= index ? "bg-accent text-accent-foreground" : "bg-control"}`}
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
                Step {index + 1} of {steps.length}
              </Text>
            </div>
            {step === "provider" ? (
              <Button
                className="no-drag h-7 px-2"
                size="small"
                variant="transparent"
                disabled={!stateReady || saving}
                onClick={skipProvider}
              >
                Skip provider
              </Button>
            ) : (
              <Text variant="small" color="tertiary">
                Profile and provider setup required
              </Text>
            )}
          </header>

          <main
            ref={scrollContainerRef}
            data-onboarding-scroll
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 max-[520px]:px-4"
          >
            {onboardingLoadError ? (
              <div role="alert" className="mb-4 rounded-card border border-red/30 bg-red/5 p-3">
                <Text variant="small" color="red">
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
                      className="block text-[20px] leading-6 outline-none"
                    >
                      What should Aiden call you?
                    </Text>
                    <Text as="p" variant="small" color="secondary" className="mt-1.5 block">
                      This personalizes your profile and model context on this Mac.
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
                    Stored privately on this Mac.
                  </Text>
                </div>
                <section
                  data-onboarding-web-search
                  aria-busy={webSearchSaving || webSearch.isFetching || undefined}
                  aria-labelledby="onboarding-web-search-title"
                  className="mt-6 rounded-card border border-separator bg-well p-4 shadow-control motion-reduce:transition-none"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-control bg-accent/10 text-accent">
                      <Globe2 aria-hidden="true" className="size-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <Text id="onboarding-web-search-title" variant="small-strong">
                            Web Search
                          </Text>
                          <Text
                            as="span"
                            variant="small"
                            color="tertiary"
                            className="ml-2"
                            aria-live="polite"
                          >
                            {webSearch.data
                              ? webSearch.data.settings.enabled
                                ? "On"
                                : "Off"
                              : webSearch.isError
                                ? "Unavailable"
                                : "Checking local setting…"}
                          </Text>
                        </div>
                        <Switch
                          checked={webSearch.data?.settings.enabled === true}
                          onCheckedChange={(enabled) => void setWebSearchEnabled(enabled)}
                          disabled={!webSearch.data || webSearch.isFetching || webSearchSaving}
                          aria-label="Allow Web Search in attended chats"
                          aria-describedby="onboarding-web-search-description"
                          className="motion-reduce:transition-none motion-reduce:[&_*]:transition-none"
                        />
                      </div>
                      <Text
                        id="onboarding-web-search-description"
                        as="p"
                        variant="small"
                        color="secondary"
                        className="mt-2 leading-5"
                      >
                        Fresh profiles start with Web Search on; anonymous Exa is the initial
                        recipient. Existing opt-outs and routes stay unchanged. Aiden may derive a
                        search query from this conversation and send that query and your network
                        address to Exa only when the model invokes search. This screen makes no
                        network request.
                      </Text>
                      <Text as="p" variant="small" color="tertiary" className="mt-2 leading-5">
                        Turn it off here, or choose another provider later in Settings → Web Search.
                      </Text>
                      {webSearch.isError && !webSearch.data ? (
                        <Text role="alert" variant="small" color="red" className="mt-2 block">
                          The local Web Search setting could not be read. No change was made.
                        </Text>
                      ) : null}
                      {webSearchSaving ? (
                        <Text
                          role="status"
                          aria-live="polite"
                          variant="small"
                          color="tertiary"
                          className="mt-2 block"
                        >
                          Saving Web Search preference…
                        </Text>
                      ) : null}
                    </div>
                  </div>
                </section>
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
                      className="block text-[20px] leading-6 outline-none"
                    >
                      Add a model provider
                    </Text>
                    <Text as="p" variant="small" color="secondary" className="mt-1.5 block">
                      Choose one connection to get started.
                    </Text>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 max-[560px]:grid-cols-1">
                  {providerChoices.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      disabled={saving}
                      aria-pressed={choice === item.id}
                      className={`flex min-h-[68px] items-start gap-2.5 rounded-control border border-transparent px-3 py-2.5 text-left outline-none transition-colors duration-150 focus-visible:bg-control-active ${choice === item.id ? "bg-list-selection" : "bg-well hover:bg-control"}`}
                      onClick={() => {
                        selectProviderChoice(item.id);
                        setBuiltinChoiceId(null);
                        setProviderSkipped(false);
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
                        <Text variant="small" color="secondary" className="mt-0.5 block leading-4">
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
                    <CodexProviderSettings layer="onboarding" />
                  </div>
                ) : null}
                <button
                  data-onboarding-more-provider-trigger
                  type="button"
                  disabled={saving}
                  aria-controls="onboarding-more-providers"
                  aria-expanded={showMoreProviders}
                  className="mt-2 flex min-h-12 w-full items-center gap-2.5 rounded-control border border-transparent bg-well px-3 py-2 text-left outline-none transition-colors duration-150 hover:bg-control focus-visible:bg-control-active"
                  onClick={() => setShowMoreProviders((visible) => !visible)}
                >
                  <span className="grid size-8 shrink-0 place-items-center text-secondary">
                    <Blocks className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <Text variant="small-strong" className="block">
                      Choose from more
                    </Text>
                    <Text variant="small" color="secondary" className="mt-0.5 block leading-4">
                      {providers.isLoading
                        ? "Loading provider catalog…"
                        : selectedBuiltinProvider
                          ? `${selectedBuiltinProvider.label} selected`
                          : `${moreProviders.length} additional provider${moreProviders.length === 1 ? "" : "s"}`}
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
                    aria-live="polite"
                    className="mt-2 rounded-card bg-well p-2"
                  >
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
                              className={`flex min-h-14 items-center gap-2.5 rounded-control border border-transparent px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:bg-control-active disabled:cursor-not-allowed disabled:opacity-50 ${isSelected ? "bg-list-selection" : "bg-transparent hover:bg-control"}`}
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
                      className="block text-[20px] leading-6 outline-none"
                    >
                      Everything Aiden brings together
                    </Text>
                    <Text as="p" variant="small" color="secondary" className="mt-1.5 block">
                      Explore all {featureBentos.length} shipped features. Scroll, then hover or
                      focus a tile to learn more.
                    </Text>
                    <Text as="p" variant="small" color="tertiary" className="mt-1 block">
                      Phone and iPad access starts off. After setup, opt in from Settings → Remote
                      Access; Aiden must stay running, and Tailscale is optional.
                    </Text>
                  </div>
                </div>
                <div
                  data-onboarding-bento
                  data-onboarding-feature-count={featureBentos.length}
                  className="mt-5 space-y-7 pb-1"
                >
                  {featureGroups.map((group) => {
                    const features = featureBentos.filter((feature) => feature.group === group.id);
                    const headingId = `onboarding-feature-group-${group.id}`;
                    return (
                      <section key={group.id} aria-labelledby={headingId}>
                        <div className="mb-2.5 flex items-center justify-between gap-3 px-0.5">
                          <Text id={headingId} as="h3" variant="small-strong" color="secondary">
                            {group.title}
                          </Text>
                          <Text variant="small" color="tertiary" className="text-[11px]">
                            {features.length} features
                          </Text>
                        </div>
                        <div className="grid auto-rows-[118px] grid-cols-6 gap-2.5 max-[560px]:auto-rows-[112px] max-[560px]:grid-cols-2 max-[420px]:grid-cols-1">
                          {features.map((feature) => {
                            const Icon = feature.icon;
                            return (
                              <article
                                key={feature.id}
                                aria-label={`${feature.title}. ${feature.description}`}
                                className={`group relative overflow-hidden rounded-card bg-well shadow-control outline-none transition-[background-color,box-shadow] duration-150 hover:bg-control-hover hover:shadow-control-hover focus-visible:bg-control-hover focus-visible:shadow-control-hover ${FEATURE_LAYOUTS[feature.size]}`}
                              >
                                <div
                                  aria-hidden="true"
                                  className="absolute inset-0 transition-opacity duration-150 group-hover:opacity-0 group-focus:opacity-0"
                                >
                                  <FeatureBentoVisual feature={feature} />
                                  <Text
                                    variant="small-strong"
                                    className={`absolute bottom-3 left-3 right-3 block leading-4 ${
                                      feature.size === "hero"
                                        ? "max-w-[42%]"
                                        : feature.size === "tall"
                                          ? "text-center"
                                          : feature.size === "standard"
                                            ? "max-w-[calc(100%_-_80px)]"
                                            : "max-w-[54%]"
                                    }`}
                                  >
                                    {feature.title}
                                  </Text>
                                </div>
                                <div
                                  aria-hidden="true"
                                  className="absolute inset-0 bg-popover p-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100"
                                >
                                  <Icon
                                    aria-hidden="true"
                                    className="absolute right-3 top-3 size-4 text-accent"
                                  />
                                  <div className="absolute bottom-3 left-3 right-3">
                                    <Text variant="small-strong" className="block leading-4">
                                      {feature.title}
                                    </Text>
                                    <Text
                                      variant="small"
                                      color="secondary"
                                      className="mt-1 block text-[12px] leading-4"
                                    >
                                      {feature.description}
                                    </Text>
                                  </div>
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
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
            <Button
              variant="accent"
              disabled={!stateReady || !canContinue || saving}
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
          </footer>
        </div>
      </section>
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
        description="Paste your API key to verify the connection. Validation does not send a chat message, and the key is stored encrypted on this Mac."
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
