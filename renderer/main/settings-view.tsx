// In-app full-screen settings: left nav + section content, with "Back to app".

import { HistoryNavButtons } from "../components/history-nav";
import * as React from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Button, ScrollArea, Sidebar, SplitView } from "../components/ui";
import {
  ChevronLeft,
  Server,
  Palette,
  Plug,
  Wand2,
  Globe,
  Image as ImageIcon,
  Mic,
  Keyboard,
  Link2,
  ListFilter,
  Search,
  MousePointer2,
  Monitor,
  ChartScatter,
  Info,
  Clock3,
  Send,
  Smartphone,
  TabletSmartphone,
  AudioWaveform,
  Volume2,
  ShieldCheck,
  Hourglass,
  Bot,
  Webhook,
} from "lucide-react";
import { ProvidersSettings } from "../components/settings/providers-settings";
import { AppearanceSettings } from "../components/settings/appearance-settings";
import { SkillsSettings } from "../components/settings/skills-settings";
import { McpSettings } from "../components/settings/mcp-settings";
import { WebSearchSettings } from "../components/settings/web-search-settings";
import { ImageGenerationSettings } from "../components/settings/image-generation-settings";
import { TelegramSettings } from "../components/settings/telegram-settings";
import { VoiceSettings } from "../components/settings/voice-settings";
import { TtsSettings } from "../components/settings/tts-settings";
import { ShortcutSettings } from "../components/settings/shortcut-settings";
import { LinksSettings } from "../components/settings/links-settings";
import { ComputerUseSettings } from "../components/settings/computer-use-settings";
import { BotComputersSettings } from "../components/settings/bot-computers-settings";
import { BotsSettings } from "../components/settings/bots-settings";
import { ModelDataSettings } from "../components/settings/model-data-settings";
import { AboutSettings } from "../components/settings/about-settings";
import { ScheduledTasksSettings } from "../components/settings/scheduled-tasks-settings";
import { AidenLiveSettings } from "../components/settings/gemini-live-settings";
import { ConnectionsSettings } from "../components/settings/connections-settings";
import { SimulatorSettingsPage } from "../components/settings/device-workspace-settings";
import { ToolApprovalSettings } from "../components/settings/tool-approval-settings";
import { LimitsSettings } from "../components/settings/limits-settings";
import { HooksSettings } from "../components/settings/hooks-settings";
import {
  availableSettingsDestinations,
  matchesSettingsSearch,
  SETTINGS_DESTINATIONS,
  type SettingsSection,
} from "../lib/settings-section";
import { useAppCapabilities } from "../lib/app-capabilities";
import { MemoryCardIcon } from "../components/memory-card-icon";
import { SettingsPage } from "../components/settings/settings-page";
import { MemorySettings } from "../components/settings/memory-settings";

type NavGroup = "Agent" | "App";

type NavItem = {
  id: SettingsSection;
  title: string;
  icon: React.ReactNode;
  group: NavGroup;
  keywords: string;
};

const NAV_ICONS: Record<SettingsSection, React.ReactNode> = {
  providers: <Server className="size-5" />,
  modelData: <ChartScatter className="size-5" />,
  limits: <Hourglass className="size-5" />,
  skills: <Wand2 className="size-5" />,
  mcp: <Plug className="size-5" />,
  hooks: <Webhook className="size-5" />,
  telegram: <Send className="size-5" />,
  remoteAccess: <Smartphone className="size-5" />,
  websearch: <Globe className="size-5" />,
  imageGeneration: <ImageIcon className="size-5" />,
  scheduledTasks: <Clock3 className="size-5" />,
  geminiLive: <AudioWaveform className="size-5" />,
  approvals: <ShieldCheck className="size-5" />,
  computerUse: <MousePointer2 className="size-5" />,
  bots: <Bot className="size-5" />,
  botComputers: <Monitor className="size-5" />,
  simulator: <TabletSmartphone className="size-5" />,
  memory: <MemoryCardIcon className="size-5" />,
  voice: <Mic className="size-5" />,
  tts: <Volume2 className="size-5" />,
  links: <Link2 className="size-5" />,
  shortcut: <Keyboard className="size-5" />,
  appearance: <Palette className="size-5" />,
  about: <Info className="size-5" />,
};

const NAV: NavItem[] = SETTINGS_DESTINATIONS.map((item) => ({
  ...item,
  icon: NAV_ICONS[item.id],
  keywords: item.keywords.join(" "),
}));

const NAV_GROUPS: NavGroup[] = ["Agent", "App"];

const CONTENT: Record<SettingsSection, React.ComponentType> = {
  providers: ProvidersSettings,
  modelData: ModelDataSettings,
  limits: LimitsSettings,
  skills: SkillsSettings,
  telegram: TelegramSettings,
  remoteAccess: ConnectionsSettings,
  mcp: McpSettings,
  hooks: HooksSettings,
  websearch: WebSearchSettings,
  imageGeneration: ImageGenerationSettings,
  approvals: ToolApprovalSettings,
  computerUse: ComputerUseSettings,
  bots: BotsSettings,
  botComputers: BotComputersSettings,
  simulator: SimulatorSettingsPage,
  memory: MemorySettings,
  scheduledTasks: ScheduledTasksSettings,
  geminiLive: AidenLiveSettings,
  voice: VoiceSettings,
  tts: TtsSettings,
  links: LinksSettings,
  shortcut: ShortcutSettings,
  appearance: AppearanceSettings,
  about: AboutSettings,
};

const DESCRIPTIONS: Record<SettingsSection, string> = {
  providers: "Connect models to Aiden and manage the providers you use.",
  modelData: "Arrange your models by capability and pace. Your map stays on this device.",
  limits: "Choose how long replies wait out a provider’s usage limit, and how much chats and Bots may spend.",
  skills: "Choose the reusable instructions Aiden can load in chats.",
  mcp: "Connect tools and services to extend what Aiden can do.",
  hooks: "Run your own shell commands at points in a chat, such as before a tool runs. Each one runs only after you approve it.",
  telegram: "Connect your Telegram bots and choose how they respond.",
  remoteAccess: "Use Aiden from your phone or another computer, or control your other computers from here.",
  websearch: "Choose how Aiden searches and reads the web.",
  imageGeneration: "Connect image providers and choose the models Aiden uses to make images.",
  approvals: "Review the exact actions Aiden may repeat without asking, and revoke them.",
  computerUse: "Manage Aiden’s access to native apps and your screen.",
  bots: "Choose how every Bot handles steps that need your OK.",
  botComputers: "Give a Bot its own macOS computer to work in, apart from yours.",
  simulator: "Control iOS Simulator streaming, agent access, and the helper tools on this Mac.",
  memory: "Control what Aiden remembers and how long chats stay manageable.",
  scheduledTasks: "Manage when Aiden works in the background.",
  geminiLive: "Set up Aiden’s real-time voice, screen context, and approved actions.",
  voice: "Set up voice input, transcription, and dictation.",
  tts: "Read Aiden’s latest response aloud with Google Gemini.",
  links: "Choose where links you click open.",
  shortcut: "Customize the keyboard controls for Aiden and the app.",
  appearance: "Pick a theme, choose when Aiden uses its light or dark look, and set how wide conversations read.",
  about: "App information, updates, and diagnostics.",
};

export function SettingsView({ initialSection }: { initialSection?: SettingsSection }) {
  const router = useRouter();
  const navigate = useNavigate();
  const capabilities = useAppCapabilities();
  const [search, setSearch] = React.useState("");

  const query = search.trim().toLocaleLowerCase();
  const availableDestinationIds = new Set(
    availableSettingsDestinations(capabilities).map((destination) => destination.id),
  );
  // A deep link to a page this Mac can't show (Computer Use off, Bot computers on
  // Linux or an Intel Mac) lands on Providers rather than an empty page.
  const section =
    initialSection && availableDestinationIds.has(initialSection) ? initialSection : "providers";
  const availableNav = NAV.filter((item) => availableDestinationIds.has(item.id));
  const filteredNav = query
    ? availableNav.filter((item) => matchesSettingsSearch(item, query, DESCRIPTIONS[item.id]))
    : availableNav;
  const ActiveSection = CONTENT[section];

  return (
    <SplitView
      storageKey="aiden-agent"
      sidebarSize={{ default: 272, min: 236, max: 340 }}
      sidebar={
        <Sidebar actions={
          <SplitView.SidebarToggle>
            <HistoryNavButtons />
          </SplitView.SidebarToggle>
        }>
          <div className="flex min-h-full flex-col px-3 pb-4">
            <Button
              variant="transparent"
              className="mb-2 h-10 justify-start gap-3 px-2 text-[15px] font-normal text-secondary"
              onClick={() => router.history.back()}
            >
              <ChevronLeft className="size-5" />
              Back to app
            </Button>

            <div className="mb-4 flex h-10 items-center gap-3 px-2 text-primary">
              <ListFilter className="size-5" />
              <span className="text-[16px] font-medium">All settings</span>
            </div>

            <label className="mb-6 flex h-10 items-center gap-2 rounded-control border border-field bg-background px-3 shadow-control transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:border-primary/30 focus-within:bg-input">
              <Search className="size-5 shrink-0 text-tertiary" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setSearch("");
                    event.currentTarget.blur();
                  }
                }}
                placeholder="Search settings…"
                aria-label="Search settings"
                className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-primary outline-none placeholder:text-tertiary"
              />
            </label>

            <nav aria-label="Settings" className="space-y-5">
              {NAV_GROUPS.map((group) => {
                const items = filteredNav.filter((item) => item.group === group);
                if (items.length === 0) return null;

                return (
                  <div key={group}>
                    <div className="mb-2 px-3 text-[13px] font-medium text-tertiary">{group}</div>
                    <div className="space-y-0.5">
                      {items.map((item) => {
                        const selected = section === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            aria-current={selected ? "page" : undefined}
                            onClick={() =>
                              void navigate({
                                to: "/settings",
                                search: { section: item.id },
                                replace: true,
                              })
                            }
                            className={`flex min-h-10 w-full items-center gap-3 rounded-[13px] px-3 py-2 text-left text-[15px] outline-none transition-[background-color,box-shadow] duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:ring-2 focus-visible:ring-focus-ring ${
                              selected
                                ? "bg-list-selection text-primary hover:bg-list-selection"
                                : "text-primary"
                            }`}
                          >
                            <span className="shrink-0 text-secondary">{item.icon}</span>
                            <span className="min-w-0 truncate">{item.title}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {filteredNav.length === 0 ? (
                <p role="status" className="px-3 py-2 text-[13px] leading-relaxed text-tertiary">
                  No settings match “{search.trim()}”.
                </p>
              ) : null}
            </nav>
          </div>
        </Sidebar>
      }
    >
      <ScrollArea className="h-full" title="Settings">
        <div className="settings-responsive mx-auto w-full max-w-5xl px-5 py-6">
          <SettingsPage
            heading={
              !["providers", "skills", "mcp", "appearance", "websearch", "shortcut", "hooks"].includes(
                section,
              )
            }
            title={NAV.find((item) => item.id === section)?.title ?? "Settings"}
            description={DESCRIPTIONS[section]}
          >
            <ActiveSection />
          </SettingsPage>
        </div>
      </ScrollArea>
    </SplitView>
  );
}
