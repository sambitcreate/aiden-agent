import {
  AudioWaveform,
  Blocks,
  Bot,
  CalendarClock,
  ChartBar,
  ChartScatter,
  Command,
  Eye,
  FileDiff,
  Files,
  FolderGit2,
  GitBranch,
  Globe2,
  Lightbulb,
  MessageSquare,
  Mic2,
  MousePointer2,
  Palette,
  Plug,
  Send,
  ShieldCheck,
  Smartphone,
  SquareTerminal,
  UsersRound,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { Text } from "./ui";
import { onboardingModelDescription } from "../lib/onboarding-provider";
import type { KeyboardPlatform } from "../shared/keybindings";
import {
  FeatureArt,
  featureArtTintStyle,
  type FeatureArtId,
  type FeatureArtSize,
} from "./onboarding-art/feature-art";

type FeatureGroupId = "create" | "extend" | "control";

export interface OnboardingFeature {
  id: FeatureArtId;
  group: FeatureGroupId;
  title: string;
  description: string;
  icon: LucideIcon;
  size: FeatureArtSize;
}

const featureGroups: ReadonlyArray<{ id: FeatureGroupId; title: string }> = [
  { id: "create", title: "Build in your workspace" },
  { id: "extend", title: "Choose and extend" },
  { id: "control", title: "Automate and stay in control" },
];

export const onboardingFeatures: OnboardingFeature[] = [
  {
    id: "workspace",
    group: "create",
    title: "Workspace Agent",
    description:
      "Read, search, edit, and run commands in your workspace. Queue follow-ups, edit them, or steer the next response. Aiden follows your global and workspace AGENTS.md guidance, refreshing it between model turns.",
    icon: MessageSquare,
    size: "hero",
  },
  {
    id: "computerUse",
    group: "create",
    title: "Computer Use",
    description: "Inspect and operate Mac apps when you opt in, with approval before every action.",
    icon: MousePointer2,
    size: "tall",
  },
  {
    id: "subagents",
    group: "create",
    title: "Native Subagents",
    description:
      "Delegate research, plans, reviews, or coding to a child agent. Implementer writes and commands follow your workspace permission.",
    icon: UsersRound,
    size: "standard",
  },
  {
    id: "browser",
    group: "create",
    title: "Browser & Annotations",
    description:
      "Browse beside your chat, select page elements as context, and let Aiden use the same tabs. Browser profiles keep their own local sign-ins; Incognito is temporary. Manage agent access in Browser settings.",
    icon: Globe2,
    size: "standard",
  },
  {
    id: "filesEditor",
    group: "create",
    title: "Files & Text Editor",
    description: "Open Files from the workspace tools launcher to browse, search, edit, and safely save text files beside the chat. On your phone, expand folders on demand and preview source before editing. Activity confirms files written or edited. Large workspace tool outputs can be recovered in the same chat for up to seven days.",
    icon: Files,
    size: "standard",
  },
  {
    id: "reviewDiffs",
    group: "create",
    title: "Review & Diffs",
    description: "Inspect staged, unstaged, and branch-to-branch diffs before you commit.",
    icon: FileDiff,
    size: "standard",
  },
  {
    id: "terminal",
    group: "create",
    title: "Integrated Terminal",
    description:
      "Open Terminal from the workspace tools launcher. Keep shell tabs and split panes at the bottom or move them beside your chat, then reopen it with sanitized local history.",
    icon: SquareTerminal,
    size: "standard",
  },
  {
    id: "gitWorkflows",
    group: "create",
    title: "Git Workflows",
    description:
      "Switch branches, create reviewed commits, push with stale-state guards, and link or open pull requests right from the chat.",
    icon: GitBranch,
    size: "wide",
  },
  {
    id: "workspaces",
    group: "create",
    title: "Workspaces & Worktrees",
    description:
      "Keep chats grouped with folders, scratch spaces, and isolated worktrees in one workspace outline.",
    icon: FolderGit2,
    size: "wide",
  },
  {
    id: "models",
    group: "extend",
    title: "Model Freedom",
    description: onboardingModelDescription("other"),
    icon: Blocks,
    size: "hero",
  },
  {
    id: "toolScripts",
    group: "extend",
    title: "Tool Scripts",
    description:
      "Combine workspace and connected-service tools in short scripts. Every tool keeps its normal permission checks; scripts cannot access your files or network directly.",
    icon: SquareTerminal,
    size: "standard",
  },
  {
    id: "modelPad",
    group: "extend",
    title: "Personal Model Pad",
    description:
      "Arrange favorite models on your own map; an optional benchmark-only OpenRouter key never imports its model catalog. Live catalog checks happen only when you choose provider setup or Update model catalogs; ordinary browsing stays offline.",
    icon: ChartScatter,
    size: "tall",
  },
  {
    id: "thinking",
    group: "extend",
    title: "Thinking Controls",
    description: "Tune reasoning effort, including configured custom models, and follow thinking as it streams.",
    icon: Lightbulb,
    size: "standard",
  },
  {
    id: "vision",
    group: "extend",
    title: "Attachments & Vision",
    description:
      "Attach images directly to vision models, explicitly choose an image-understanding companion for a text-only Bot, and let the workspace agent show raster images inline. Generate or edit attached images with configured image models after approving the prompt, reference images, and possible provider charges.",
    icon: Eye,
    size: "standard",
  },
  {
    id: "webSearch",
    group: "extend",
    title: "Web Search",
    description:
      "Search the live web when needed—on by default with anonymous Exa, with a reviewed provider zoo in Settings.",
    icon: Globe2,
    size: "standard",
  },
  {
    id: "skills",
    group: "extend",
    title: "Reusable Skills",
    description: "Skills can allow automatic use, explicit attachment with $, or both. Turn all skills off anytime in Settings → Skills.",
    icon: Wand2,
    size: "wide",
  },
  {
    id: "mcp",
    group: "extend",
    title: "MCP Connectors",
    description: "Connect MCP services to use their tools and read the resources they share. Connected services may also provide guidance for using those tools. Sharing a provider sign-in requires approval on each device.",
    icon: Plug,
    size: "wide",
  },
  {
    id: "geminiLive",
    group: "control",
    title: "Aiden Live",
    description:
      "Talk to Aiden, share screen context, and approve each app action one at a time from the Live button.",
    icon: AudioWaveform,
    size: "hero",
  },
  {
    id: "bots",
    group: "control",
    title: "Meet your Bots",
    description:
      "Start with a helper for a job, like planning meals or keeping up with email. Each Bot keeps one chat, remembers its instructions, and can run on a schedule.",
    icon: Bot,
    size: "standard",
  },
  {
    id: "schedules",
    group: "control",
    title: "Scheduled Automations",
    description:
      "Ask Aiden in any chat to schedule recurring work, review its unattended access, then run, change, or pause it anytime.",
    icon: CalendarClock,
    size: "tall",
  },
  {
    id: "voice",
    group: "control",
    title: "Voice & Dictation",
    description:
      "Speak in the composer or dictate system-wide. Tap, hold, or both, and teach Aiden your names and terms in Voice settings. On-device models keep audio on this computer, or explicitly connect cloud transcription and review what it can access.",
    icon: Mic2,
    size: "standard",
  },
  {
    id: "commands",
    group: "control",
    title: "Command Palette",
    description: "Use Command-K or / for app commands, and $ to attach a reusable skill.",
    icon: Command,
    size: "standard",
  },
  {
    id: "telegram",
    group: "control",
    title: "Aiden in Telegram",
    description:
      "Use models, skills, files, and voice from your paired account. Queue follow-ups, steer a running response, interrupt a turn, or stop pending work.",
    icon: Send,
    size: "standard",
  },
  {
    id: "aidenOnTheGo",
    group: "control",
    title: "Aiden On The Go",
    description: "Connect your phone or tablet with a guided setup and one-time code. Add custom providers from the paired client; connections and keys stay on your Mac.",
    icon: Smartphone,
    size: "standard",
  },
  {
    id: "usage",
    group: "control",
    title: "Private Usage Profile",
    description: "See on-device activity, token mix, cost coverage, and your top models.",
    icon: ChartBar,
    size: "standard",
  },
  {
    id: "permissions",
    group: "control",
    title: "Permissioned by Default",
    description: "Choose No access, Ask first, or Full per workspace; keys stay encrypted.",
    icon: ShieldCheck,
    size: "wide",
  },
  {
    id: "themes",
    group: "control",
    title: "Themes & Accessibility",
    description: "Pick a theme and follow the system, light, or dark appearance.",
    icon: Palette,
    size: "wide",
  },
];

const FEATURE_LAYOUTS: Readonly<Record<FeatureArtSize, string>> = {
  hero: "col-span-4 row-span-2 max-[560px]:col-span-2 max-[420px]:col-span-1",
  tall: "col-span-2 row-span-2 max-[560px]:col-span-1 max-[420px]:col-span-1",
  standard: "col-span-2 max-[560px]:col-span-1 max-[420px]:col-span-1",
  wide: "col-span-3 max-[560px]:col-span-2 max-[420px]:col-span-1",
};

/** Keeps each title clear of the art it sits beside. */
const TITLE_LAYOUTS: Readonly<Record<FeatureArtSize, string>> = {
  hero: "max-w-[132px]",
  tall: "right-3 text-center",
  standard: "right-3",
  wide: "max-w-[112px]",
};

/** The final onboarding step's feature tour: grouped bento tiles with code-drawn art. */
export function OnboardingFeatureGallery({
  features,
  platform,
}: {
  features: readonly OnboardingFeature[];
  /** Keyboard platform, so drawn shortcuts match the ones this machine uses. */
  platform: KeyboardPlatform;
}) {
  return (
    <div
      data-onboarding-bento
      data-onboarding-feature-count={features.length}
      className="mt-5 space-y-7 pb-1"
    >
      {featureGroups.map((group) => {
        const groupFeatures = features.filter((feature) => feature.group === group.id);
        const headingId = `onboarding-feature-group-${group.id}`;
        return (
          <section key={group.id} aria-labelledby={headingId}>
            <div className="mb-2.5 flex items-center justify-between gap-3 px-0.5">
              <Text id={headingId} as="h3" variant="small-strong" color="secondary">
                {group.title}
              </Text>
              <Text variant="small" color="tertiary" className="text-mini">
                {groupFeatures.length} features
              </Text>
            </div>
            <div className="grid auto-rows-[minmax(118px,auto)] grid-cols-6 gap-2.5 max-[560px]:auto-rows-[minmax(112px,auto)] max-[560px]:grid-cols-2 max-[420px]:grid-cols-1">
              {groupFeatures.map((feature) => {
                const Icon = feature.icon;
                return (
                  <article
                    key={feature.id}
                    tabIndex={0}
                    aria-label={`${feature.title}. ${feature.description}`}
                    data-onboarding-feature={feature.id}
                    style={featureArtTintStyle(feature.id)}
                    className={`oa-tile group relative overflow-hidden rounded-card shadow-control outline-none transition-[background-color,box-shadow] duration-150 hover:shadow-control-hover focus-visible:shadow-control-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring motion-reduce:transition-none ${FEATURE_LAYOUTS[feature.size]}`}
                  >
                    <div
                      aria-hidden="true"
                      className="absolute inset-0 transition-opacity duration-150 group-hover:opacity-0 group-focus:opacity-0 motion-reduce:transition-none"
                    >
                      <FeatureArt id={feature.id} size={feature.size} platform={platform} />
                      <Text
                        variant="small-strong"
                        className={`absolute bottom-3 left-3 block leading-4 ${TITLE_LAYOUTS[feature.size]}`}
                      >
                        {feature.title}
                      </Text>
                    </div>
                    <div
                      aria-hidden="true"
                      className="relative flex min-h-full flex-col justify-end bg-popover p-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100 motion-reduce:transition-none"
                    >
                      <Icon aria-hidden="true" className="absolute right-3 top-3 size-4 text-accent" />
                      <div className="mt-5">
                        <Text variant="small-strong" className="block leading-4">
                          {feature.title}
                        </Text>
                        <Text
                          variant="small"
                          color="secondary"
                          className="mt-1 block text-small leading-4"
                          data-onboarding-feature-description
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
  );
}
