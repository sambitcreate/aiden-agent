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
  MessageSquare,
  Mic2,
  MousePointer2,
  Network,
  Palette,
  Plug,
  Send,
  ShieldCheck,
  SquareTerminal,
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
import { Button, Input, Text, toast } from "./ui";
import { providersApi, profileApi } from "../lib/ipc";
import { markOnboardingComplete, shouldShowOnboarding } from "../lib/onboarding-state";
import {
  discoveredDefaultModel,
  fieldsAfterProviderChoiceChange,
  makeOnboardingProvider,
  type OnboardingProviderChoice,
} from "../lib/onboarding-provider";
import { getOnboardingMoreProviders } from "../lib/pi-provider-display";
import { queryKeys, useProviders } from "../lib/queries";
import { persistModelSelection } from "../lib/use-model-selection";
import type { Provider } from "../lib/types";

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
  schedules: new URL("../assets/onboarding/features/scheduled-automations.png", import.meta.url)
    .href,
  voice: new URL("../assets/onboarding/features/voice-dictation.png", import.meta.url).href,
  commands: new URL("../assets/onboarding/features/command-palette.png", import.meta.url).href,
  usage: new URL("../assets/onboarding/features/usage-profile.png", import.meta.url).href,
  permissions: new URL("../assets/onboarding/features/permissions.png", import.meta.url).href,
  themes: new URL("../assets/onboarding/features/themes-accessibility.png", import.meta.url).href,
  telegram: new URL("../assets/onboarding/features/telegram-remote-control.png", import.meta.url)
    .href,
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
    description: "Use folders, scratch spaces, and isolated worktrees while preserving context.",
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
    description: "Arrange favorite models on your own map of capability and response pace.",
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
      "Attach files for models to inspect, and let the workspace agent show raster images inline.",
    icon: Eye,
    imageUrl: FEATURE_ILLUSTRATIONS.vision,
    size: "standard",
  },
  {
    id: "webSearch",
    group: "extend",
    title: "Web Search",
    description: "Give the workspace agent live Exa search when you choose to connect it.",
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
    id: "schedules",
    group: "control",
    title: "Scheduled Automations",
    description: "Schedule recurring model work or trusted scripts, then run or pause anytime.",
    icon: CalendarClock,
    imageUrl: FEATURE_ILLUSTRATIONS.schedules,
    size: "tall",
  },
  {
    id: "voice",
    group: "control",
    title: "Voice & Dictation",
    description: "Speak into the composer or dictate system-wide with cloud or on-device voice.",
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
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          className="fixed inset-0 z-60 grid place-items-center bg-background p-4 outline-none max-[760px]:p-0"
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

function builtinProviderSetupLabel(provider: Provider): string {
  if (provider.hasKey) return "Ready on this Mac";
  const methods = (provider.authMethods ?? [])
    .filter((method) => method.canLogin)
    .map((method) => method.label);
  if (methods.length > 0) return methods.slice(0, 2).join(" or ");
  return "Requires system credentials";
}

function canChooseBuiltinProvider(provider: Provider): boolean {
  return provider.hasKey || (provider.authMethods ?? []).some((method) => method.canLogin);
}

export function OnboardingFlow() {
  const queryClient = useQueryClient();
  const providers = useProviders();
  const [open, setOpen] = React.useState(() => shouldShowOnboarding());
  const [index, setIndex] = React.useState(0);
  const [name, setName] = React.useState("");
  const [choice, setChoice] = React.useState<OnboardingProviderChoice | null>("openai-signin");
  const [builtinChoiceId, setBuiltinChoiceId] = React.useState<string | null>(null);
  const [showMoreProviders, setShowMoreProviders] = React.useState(false);
  const [settingUpProvider, setSettingUpProvider] = React.useState<Provider | null>(null);
  const [apiKey, setApiKey] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [discovering, setDiscovering] = React.useState(false);
  const [providerError, setProviderError] = React.useState<string | null>(null);
  const savingRef = React.useRef(false);
  const scrollContainerRef = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [index]);

  if (!open) return null;
  const step = steps[index];
  const selected = providerChoices.find((item) => item.id === choice);
  const moreProviders = getOnboardingMoreProviders(providers.data ?? []);
  const chatGptProvider = (providers.data ?? []).find(
    (provider) => provider.id === "openai-codex" && provider.isBuiltin === true,
  );
  const selectedBuiltinProvider = moreProviders.find((provider) => provider.id === builtinChoiceId);
  const hasProviderChoice = Boolean(selected || selectedBuiltinProvider);
  const canContinue =
    step === "profile" ? name.trim().length > 0 : step === "provider" ? hasProviderChoice : true;

  const selectProviderChoice = (nextChoice: OnboardingProviderChoice | null) => {
    const nextFields = fieldsAfterProviderChoiceChange(choice, nextChoice, {
      apiKey,
      baseUrl,
    });
    setApiKey(nextFields.apiKey);
    setBaseUrl(nextFields.baseUrl);
    setChoice(nextChoice);
    setProviderError(null);
  };

  const next = async () => {
    if (!canContinue || savingRef.current) return;
    if (step === "profile") {
      savingRef.current = true;
      setSaving(true);
      try {
        const saved = await profileApi.setName(name);
        queryClient.setQueryData(queryKeys.profile, saved);
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
        if (selectedBuiltinProvider.hasKey) {
          setIndex(2);
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
        if (providers.isLoading) {
          toast.info("Aiden is still loading the ChatGPT sign-in option. Try again in a moment.");
          return;
        }
        if (!chatGptProvider) {
          toast.error(
            "ChatGPT sign-in is unavailable. Refresh the provider catalog or choose another option.",
          );
          return;
        }
        if (chatGptProvider.hasKey) setIndex(2);
        else setSettingUpProvider(chatGptProvider);
        return;
      }
      if (choice === "tailscale" && !baseUrl.trim()) {
        toast.error("Enter the Tailscale model server URL before continuing.");
        return;
      }
      if (selected.requiresKey && !apiKey.trim()) {
        toast.error("Paste an API key or choose a sign-in/local option.");
        return;
      }
      savingRef.current = true;
      setSaving(true);
      setProviderError(null);
      try {
        const isLocalRuntime = choice === "lmstudio" || choice === "ollama";
        // Resolve reserved local identities from a fresh main-process snapshot.
        // The query cache may still be loading or stale when the user clicks Next.
        const currentProviders = isLocalRuntime
          ? await providersApi.list()
          : (providers.data ?? []);
        if (isLocalRuntime) {
          queryClient.setQueryData(queryKeys.providers, currentProviders);
        }
        let providerToSave = makeOnboardingProvider(choice, baseUrl.trim(), currentProviders);
        if (providerToSave && isLocalRuntime) {
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
          if (isLocalRuntime) {
            persistModelSelection(saved.id, saved.defaultModel ?? providerToSave.defaultModel!);
          }
          toast.success(`${saved.label} added.`);
        }
        setIndex(2);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Couldn't add that provider.";
        setProviderError(message);
        toast.error(message);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
      return;
    }
    markOnboardingComplete();
    setOpen(false);
  };

  return (
    <OnboardingDialogShell>
      <section
        aria-busy={saving || undefined}
        aria-label="Set up Aiden"
        className="relative grid h-[min(600px,calc(100vh-32px))] min-h-0 w-[min(860px,calc(100vw-32px))] grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-dialog bg-popover shadow-modal max-[760px]:h-full max-[760px]:w-full max-[760px]:grid-cols-1 max-[760px]:rounded-none max-[760px]:shadow-none"
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
            <Button
              className="no-drag"
              variant="transparent"
              size="small"
              disabled={saving}
              onClick={() => {
                markOnboardingComplete();
                setOpen(false);
              }}
            >
              Skip
            </Button>
          </header>

          <main
            ref={scrollContainerRef}
            data-onboarding-scroll
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 max-[520px]:px-4"
          >
            {step === "profile" ? (
              <div className="max-w-md">
                <div className="flex items-start gap-3">
                  <UserRound className="mt-0.5 size-5 shrink-0 text-accent" />
                  <div>
                    <Text as="h2" variant="heading1" className="block text-[20px] leading-6">
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
                    autoFocus
                    className="mt-2 h-10"
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
              </div>
            ) : null}

            {step === "provider" ? (
              <div>
                <div className="flex items-start gap-3">
                  <Network className="mt-0.5 size-5 shrink-0 text-accent" />
                  <div>
                    <Text as="h2" variant="heading1" className="block text-[20px] leading-6">
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
                      className={`flex min-h-[68px] items-start gap-2.5 rounded-control border px-3 py-2.5 text-left transition-[background-color,border-color] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${choice === item.id ? "border-accent bg-accent/10" : "border-field bg-well hover:bg-control"}`}
                      onClick={() => {
                        selectProviderChoice(item.id);
                        setBuiltinChoiceId(null);
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
                <button
                  data-onboarding-more-provider-trigger
                  type="button"
                  disabled={saving}
                  aria-controls="onboarding-more-providers"
                  aria-expanded={showMoreProviders}
                  className="mt-2 flex min-h-12 w-full items-center gap-2.5 rounded-control border border-field bg-well px-3 py-2 text-left transition-[background-color,border-color] duration-150 hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
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
                    className="mt-2 rounded-card border border-separator bg-well p-2"
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
                          const canChoose = canChooseBuiltinProvider(provider);
                          const isSelected = builtinChoiceId === provider.id;
                          return (
                            <button
                              key={provider.id}
                              type="button"
                              disabled={!canChoose || saving}
                              aria-pressed={isSelected}
                              className={`flex min-h-14 items-center gap-2.5 rounded-control border px-2.5 py-2 text-left transition-[background-color,border-color] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50 ${isSelected ? "border-accent bg-accent/10" : "border-transparent bg-transparent hover:border-field hover:bg-control"}`}
                              onClick={() => {
                                selectProviderChoice(null);
                                setBuiltinChoiceId(provider.id);
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
                                  {builtinProviderSetupLabel(provider)}
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
                  {selected?.requiresKey ? (
                    <label>
                      <Text variant="small-strong">API key</Text>
                      <Input
                        className="mt-2"
                        type="password"
                        disabled={saving}
                        value={apiKey}
                        placeholder="Paste key"
                        onChange={(event) => setApiKey(event.currentTarget.value)}
                      />
                    </label>
                  ) : null}
                  {choice === "tailscale" || choice === "openai-key" || choice === "anthropic" ? (
                    <label>
                      <Text variant="small-strong">
                        {choice === "tailscale" ? "Model URL" : "Base URL (optional)"}
                      </Text>
                      <Input
                        className="mt-2"
                        disabled={saving}
                        value={baseUrl}
                        placeholder={
                          choice === "tailscale"
                            ? "https://model.tailnet.ts.net/v1"
                            : "Use provider default"
                        }
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

            {step === "tour" ? (
              <div>
                <div className="flex items-start gap-3">
                  <Check className="mt-0.5 size-5 shrink-0 text-accent" />
                  <div>
                    <Text as="h2" variant="heading1" className="block text-[20px] leading-6">
                      Everything Aiden brings together
                    </Text>
                    <Text as="p" variant="small" color="secondary" className="mt-1.5 block">
                      Explore all {featureBentos.length} shipped features. Scroll, then hover or
                      focus a tile to learn more.
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
                                tabIndex={0}
                                aria-label={`${feature.title}. ${feature.description}`}
                                className={`group relative overflow-hidden rounded-card border border-field bg-well shadow-control outline-none transition-[background-color,border-color,box-shadow] duration-150 hover:border-separator hover:bg-control-hover hover:shadow-control-hover focus-visible:border-focus-ring focus-visible:bg-control-hover focus-visible:shadow-control-hover ${FEATURE_LAYOUTS[feature.size]}`}
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
              disabled={index === 0 || saving}
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
            >
              <ChevronLeft /> Back
            </Button>
            <Button variant="accent" disabled={!canContinue || saving} onClick={() => void next()}>
              {discovering
                ? "Discovering models…"
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
            void queryClient.invalidateQueries({
              queryKey: queryKeys.providers,
            });
            setIndex(2);
          }}
        />
      ) : null}
    </OnboardingDialogShell>
  );
}
