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
} from "lucide-react";
import { ProvidersSettings } from "../components/settings/providers-settings";
import { AppearanceSettings } from "../components/settings/appearance-settings";
import { SkillsSettings } from "../components/settings/skills-settings";
import { McpSettings } from "../components/settings/mcp-settings";
import { WebSearchSettings } from "../components/settings/web-search-settings";
import { VoiceSettings } from "../components/settings/voice-settings";
import { ShortcutSettings } from "../components/settings/shortcut-settings";
import { ComputerUseSettings } from "../components/settings/computer-use-settings";
import { ModelDataSettings } from "../components/settings/model-data-settings";
import type { SettingsSection } from "../lib/settings-section";

type NavGroup = "Agent" | "App";

type NavItem = {
  id: SettingsSection;
  title: string;
  icon: React.ReactNode;
  group: NavGroup;
  keywords: string;
};

const NAV: NavItem[] = [
  {
    id: "providers",
    title: "Providers",
    icon: <Server className="size-5" />,
    group: "Agent",
    keywords: "models api keys",
  },
  {
    id: "modelData",
    title: "Model data",
    icon: <ChartScatter className="size-5" />,
    group: "Agent",
    keywords: "artificial analysis api key model pad rankings benchmarks offline cache",
  },
  {
    id: "skills",
    title: "Skills",
    icon: <Wand2 className="size-5" />,
    group: "Agent",
    keywords: "instructions tools",
  },
  {
    id: "mcp",
    title: "MCP Servers",
    icon: <Plug className="size-5" />,
    group: "Agent",
    keywords: "connections tools protocol",
  },
  {
    id: "websearch",
    title: "Web Search",
    icon: <Globe className="size-5" />,
    group: "Agent",
    keywords: "internet search",
  },
  {
    id: "computerUse",
    title: "Computer Use",
    icon: <MousePointer2 className="size-5" />,
    group: "Agent",
    keywords: "desktop native apps accessibility screen recording cua beta",
  },
  {
    id: "voice",
    title: "Voice",
    icon: <Mic className="size-5" />,
    group: "App",
    keywords: "microphone audio transcription",
  },
  {
    id: "shortcut",
    title: "Keyboard shortcuts",
    icon: <Keyboard className="size-5" />,
    group: "App",
    keywords: "hotkey command",
  },
  {
    id: "appearance",
    title: "Appearance",
    icon: <Palette className="size-5" />,
    group: "App",
    keywords: "theme light dark system",
  },
];

const NAV_GROUPS: NavGroup[] = ["Agent", "App"];

const CONTENT: Record<SettingsSection, React.ComponentType> = {
  providers: ProvidersSettings,
  modelData: ModelDataSettings,
  skills: SkillsSettings,
  mcp: McpSettings,
  websearch: WebSearchSettings,
  computerUse: ComputerUseSettings,
  voice: VoiceSettings,
  shortcut: ShortcutSettings,
  appearance: AppearanceSettings,
};

export function SettingsView({ initialSection }: { initialSection?: SettingsSection }) {
  const router = useRouter();
  const navigate = useNavigate();
  const section = initialSection ?? "providers";
  const [search, setSearch] = React.useState("");

  const query = search.trim().toLocaleLowerCase();
  const filteredNav = query
    ? NAV.filter((item) => `${item.title} ${item.keywords}`.toLocaleLowerCase().includes(query))
    : NAV;
  const ActiveSection = CONTENT[section];

  return (
    <SplitView
      storageKey="aiden-agent-settings"
      sidebarSize={{ default: 288, min: 252, max: 340 }}
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

            <label className="mb-6 flex h-10 items-center gap-2 rounded-control border border-field bg-background px-3 shadow-control transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:border-primary/30 focus-within:border-focus-ring focus-within:ring-2 focus-within:ring-focus-ring">
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
                            className={`flex min-h-10 w-full items-center gap-3 rounded-[13px] px-3 py-2 text-left text-[15px] outline-none transition-[background-color,box-shadow] duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:ring-2 focus-visible:ring-focus-ring ${
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
        <div className="mx-auto w-full max-w-2xl px-5 py-6">
          <ActiveSection />
        </div>
      </ScrollArea>
    </SplitView>
  );
}
