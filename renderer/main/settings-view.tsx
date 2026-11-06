// In-app full-screen settings: left nav + section content, with "Back to app".

import { HistoryNavButtons } from "../components/history-nav";
import * as React from "react";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
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
  ListFilter,
  Search,
  Monitor,
  ChartScatter,
  Info,
  Clock3,
  Smartphone,
  TabletSmartphone,
  Hourglass,
  Bot,
  HardDrive,
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
import { ComputerUseSettings } from "../components/settings/computer-use-settings";
import { BotComputersSettings } from "../components/settings/bot-computers-settings";
import { BotsSettings } from "../components/settings/bots-settings";
import { ModelDataSettings } from "../components/settings/model-data-settings";
import { AboutSettings } from "../components/settings/about-settings";
import { ScheduledTasksSettings } from "../components/settings/scheduled-tasks-settings";
import { AidenLiveSettings } from "../components/settings/gemini-live-settings";
import { RemoteAccessSettings } from "../components/settings/remote-access-settings";
import { PeerHostsSettingsPage } from "../components/settings/peer-hosts-settings";
import { AppControlSettings } from "../components/settings/app-control-settings";
import { SimulatorSettingsPage } from "../components/settings/device-workspace-settings";
import { ToolApprovalSettings } from "../components/settings/tool-approval-settings";
import { LimitsSettings } from "../components/settings/limits-settings";
import {
  availableSettingsPages,
  firstMatchingSettingsSection,
  pageFor,
  resolveSettingsSection,
  SETTINGS_GROUPS,
  type SettingsPageId,
  type SettingsSection,
  settingsLocation,
} from "../lib/settings-section";
import { useAppCapabilities } from "../lib/app-capabilities";
import { MemoryCardIcon } from "../components/memory-card-icon";
import {
  SettingsAnchorContext,
  SettingsPage,
  SettingsPageTabs,
} from "../components/settings/settings-page";
import { MemorySettings } from "../components/settings/memory-settings";
import { StorageSettingsPage } from "../components/settings/storage-settings";

const NAV_ICONS: Record<SettingsPageId, React.ReactNode> = {
  providers: <Server className="size-5" />,
  modelData: <ChartScatter className="size-5" />,
  limits: <Hourglass className="size-5" />,
  skills: <Wand2 className="size-5" />,
  mcp: <Plug className="size-5" />,
  websearch: <Globe className="size-5" />,
  imageGeneration: <ImageIcon className="size-5" />,
  memory: <MemoryCardIcon className="size-5" />,
  botsApprovals: <Bot className="size-5" />,
  scheduledTasks: <Clock3 className="size-5" />,
  computers: <Monitor className="size-5" />,
  simulator: <TabletSmartphone className="size-5" />,
  voiceSpeech: <Mic className="size-5" />,
  connections: <Smartphone className="size-5" />,
  appearance: <Palette className="size-5" />,
  shortcut: <Keyboard className="size-5" />,
  storage: <HardDrive className="size-5" />,
  about: <Info className="size-5" />,
};

/** These pages draw their own heading. */
const OWN_HEADING = new Set<SettingsPageId>([
  "providers",
  "skills",
  "mcp",
  "appearance",
  "websearch",
  "shortcut",
]);

const CONTENT: Record<SettingsSection, React.ComponentType> = {
  providers: ProvidersSettings,
  modelData: ModelDataSettings,
  limits: LimitsSettings,
  skills: SkillsSettings,
  telegram: TelegramSettings,
  remoteAccess: RemoteAccessSettings,
  peerHosts: PeerHostsSettingsPage,
  mcp: McpSettings,
  websearch: WebSearchSettings,
  imageGeneration: ImageGenerationSettings,
  approvals: ToolApprovalSettings,
  appControls: AppControlSettings,
  computerUse: ComputerUseSettings,
  bots: BotsSettings,
  botComputers: BotComputersSettings,
  simulator: SimulatorSettingsPage,
  memory: MemorySettings,
  scheduledTasks: ScheduledTasksSettings,
  geminiLive: AidenLiveSettings,
  voice: VoiceSettings,
  tts: TtsSettings,
  links: AppearanceSettings,
  shortcut: ShortcutSettings,
  appearance: AppearanceSettings,
  storage: StorageSettingsPage,
  about: AboutSettings,
};

const DESCRIPTIONS: Record<SettingsSection, string> = {
  providers: "Connect models to Aiden and manage the providers you use.",
  modelData: "Arrange your models by capability and pace. Your map stays on this device.",
  limits: "Choose how long chats stay manageable, how replies wait out usage limits, and how much chats and Bots may spend.",
  skills: "Choose the reusable instructions Aiden can load in chats.",
  mcp: "Connect tools and services to extend what Aiden can do.",
  telegram: "Connect your Telegram bots and choose how they respond.",
  remoteAccess: "Use Aiden on this computer from your phone or another computer.",
  peerHosts: "Pair the other computers you control from here, and manage them.",
  websearch: "Choose how Aiden searches and reads the web.",
  imageGeneration: "Connect image providers and choose the models Aiden uses to make images.",
  approvals: "Review the exact actions Aiden may repeat without asking, and revoke them.",
  appControls: "Ask Aiden how a feature works or to show its settings. Chat controls use the same settings and permissions as the app.",
  computerUse: "Manage Aiden’s access to native apps and your screen.",
  bots: "Choose how every Bot handles steps that need your OK.",
  botComputers: "Give a Bot its own macOS computer to work in, apart from yours.",
  simulator: "Control iOS Simulator streaming, agent access, and the helper tools on this Mac.",
  memory: "Control what Aiden remembers across chats and Workspaces.",
  scheduledTasks: "Manage when Aiden works in the background.",
  geminiLive: "Set up Aiden’s real-time voice, screen context, and approved actions.",
  voice: "Set up voice input, transcription, and dictation.",
  tts: "Read Aiden’s latest response aloud with Google Gemini.",
  links: "Choose where links you click open.",
  shortcut: "Customize the keyboard controls for Aiden and the app.",
  appearance: "Pick a theme, choose when Aiden uses its light or dark look, and set how wide conversations read.",
  storage: "See how much disk Aiden uses on this computer, and clear out what you no longer need.",
  about: "App information, updates, and diagnostics.",
};

export function SettingsView({ initialSection }: { initialSection?: SettingsSection }) {
  const router = useRouter();
  const navigate = useNavigate();
  const capabilities = useAppCapabilities();
  const [search, setSearch] = React.useState("");

  const anchorRequest = useLocation({ select: (location) => location.state.aidenSettingsAnchor });
  const query = search.trim().toLocaleLowerCase();
  const section = resolveSettingsSection(initialSection, capabilities);
  const pages = availableSettingsPages(capabilities);
  const activePage = pages.find((page) => page.id === pageFor(section).id)!;
  const rows = pages.flatMap((page) => {
    const target = firstMatchingSettingsSection(page, query, (item) => DESCRIPTIONS[item]);
    return target ? [{ page, target }] : [];
  });
  const open = (next: SettingsSection) =>
    void navigate({ ...settingsLocation(next), replace: true });
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
              {SETTINGS_GROUPS.map((group) => {
                const items = rows.filter((row) => row.page.group === group);
                if (items.length === 0) return null;

                return (
                  <div key={group}>
                    <div className="mb-2 px-3 text-[13px] font-medium text-tertiary">{group}</div>
                    <div className="space-y-0.5">
                      {items.map(({ page, target }) => {
                        const selected = activePage.id === page.id;
                        return (
                          <button
                            key={page.id}
                            type="button"
                            aria-current={selected ? "page" : undefined}
                            onClick={() => open(target)}
                            className={`flex min-h-10 w-full items-center gap-3 rounded-[13px] px-3 py-2 text-left text-[15px] outline-none transition-[background-color,box-shadow] duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:ring-2 focus-visible:ring-focus-ring ${
                              selected
                                ? "bg-list-selection text-primary hover:bg-list-selection"
                                : "text-primary"
                            }`}
                          >
                            <span className="shrink-0 text-secondary">{NAV_ICONS[page.id]}</span>
                            <span className="min-w-0 truncate">{page.title}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {rows.length === 0 ? (
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
            heading={!OWN_HEADING.has(activePage.id)}
            title={activePage.title}
            description={DESCRIPTIONS[section]}
          >
            <SettingsPageTabs page={activePage} section={section} onSelect={open}>
              <SettingsAnchorContext.Provider value={section === "links" ? { section, request: anchorRequest ?? 0 } : null}>
                <ActiveSection />
              </SettingsAnchorContext.Provider>
            </SettingsPageTabs>
          </SettingsPage>
        </div>
      </ScrollArea>
    </SplitView>
  );
}
