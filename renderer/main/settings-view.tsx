// In-app full-screen settings: left nav + section content, with "Back to app".

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
  Mic,
  Keyboard,
  ListFilter,
  Search,
  MousePointer2,
  ChartScatter,
  Info,
  Clock3,
  Sparkles,
  Send,
  Smartphone,
} from "lucide-react";
import { ProvidersSettings } from "../components/settings/providers-settings";
import { AppearanceSettings } from "../components/settings/appearance-settings";
import { SkillsSettings } from "../components/settings/skills-settings";
import { McpSettings } from "../components/settings/mcp-settings";
import { WebSearchSettings } from "../components/settings/web-search-settings";
import { TelegramSettings } from "../components/settings/telegram-settings";
import { VoiceSettings } from "../components/settings/voice-settings";
import { ShortcutSettings } from "../components/settings/shortcut-settings";
import { ComputerUseSettings } from "../components/settings/computer-use-settings";
import { ModelDataSettings } from "../components/settings/model-data-settings";
import { AboutSettings } from "../components/settings/about-settings";
import { ScheduledTasksSettings } from "../components/settings/scheduled-tasks-settings";
import { AssistantSettings } from "../components/settings/assistant-settings";
import { RemoteAccessSettings } from "../components/settings/remote-access-settings";
import { SETTINGS_DESTINATIONS, type SettingsSection } from "../lib/settings-section";
import { useAppCapabilities } from "../lib/app-capabilities";

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
  skills: <Wand2 className="size-5" />,
  mcp: <Plug className="size-5" />,
  telegram: <Send className="size-5" />,
  remoteAccess: <Smartphone className="size-5" />,
  websearch: <Globe className="size-5" />,
  scheduledTasks: <Clock3 className="size-5" />,
  assistant: <Sparkles className="size-5" />,
  computerUse: <MousePointer2 className="size-5" />,
  voice: <Mic className="size-5" />,
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
  skills: SkillsSettings,
  telegram: TelegramSettings,
  remoteAccess: RemoteAccessSettings,
  mcp: McpSettings,
  websearch: WebSearchSettings,
  computerUse: ComputerUseSettings,
  scheduledTasks: ScheduledTasksSettings,
  assistant: AssistantSettings,
  voice: VoiceSettings,
  shortcut: ShortcutSettings,
  appearance: AppearanceSettings,
  about: AboutSettings,
};

export function SettingsView({ initialSection }: { initialSection?: SettingsSection }) {
  const router = useRouter();
  const navigate = useNavigate();
  const capabilities = useAppCapabilities();
  const section =
    initialSection === "computerUse" && !capabilities.computerUse
      ? "providers"
      : (initialSection ?? "providers");
  const [search, setSearch] = React.useState("");

  const query = search.trim().toLocaleLowerCase();
  const availableNav = capabilities.computerUse
    ? NAV
    : NAV.filter((item) => item.id !== "computerUse");
  const filteredNav = query
    ? availableNav.filter((item) =>
        `${item.title} ${item.keywords}`.toLocaleLowerCase().includes(query),
      )
    : availableNav;
  const ActiveSection = CONTENT[section];

  return (
    <SplitView
      storageKey="aiden-agent"
      sidebarSize={{ default: 272, min: 236, max: 340 }}
      sidebar={
        <Sidebar actions={<SplitView.SidebarToggle />}>
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

            <label className="mb-6 flex h-10 items-center gap-2 rounded-control border border-field bg-background px-3 shadow-control transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:border-primary/30 focus-within:border-focus-ring focus-within:bg-input">
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
                            className={`flex min-h-10 w-full items-center gap-3 rounded-[13px] px-3 py-2 text-left text-[15px] outline-none transition-[background-color,box-shadow] duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none ${
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
        <div className="settings-responsive mx-auto w-full max-w-2xl px-5 py-6">
          <ActiveSection />
        </div>
      </ScrollArea>
    </SplitView>
  );
}
