// In-app full-screen settings: left nav + section content, with "Back to app".

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Button,
  ScrollArea,
  Sidebar,
  SidebarList,
  SidebarListItem,
  SplitView,
} from "@glaze/core/components";
import { ChevronLeft, Server, Palette, Plug, Wand2, Globe, Mic, Command } from "lucide-react";
import { ProvidersSettings } from "../components/settings/providers-settings";
import { AppearanceSettings } from "../components/settings/appearance-settings";
import { SkillsSettings } from "../components/settings/skills-settings";
import { McpSettings } from "../components/settings/mcp-settings";
import { WebSearchSettings } from "../components/settings/web-search-settings";
import { VoiceSettings } from "../components/settings/voice-settings";
import { ShortcutSettings } from "../components/settings/shortcut-settings";

type Section = "providers" | "skills" | "mcp" | "websearch" | "voice" | "shortcut" | "appearance";

const NAV: Array<{ id: Section; title: string; icon: React.ReactNode }> = [
  { id: "providers", title: "Providers", icon: <Server className="size-4" /> },
  { id: "skills", title: "Skills", icon: <Wand2 className="size-4" /> },
  { id: "mcp", title: "MCP Servers", icon: <Plug className="size-4" /> },
  { id: "websearch", title: "Web Search", icon: <Globe className="size-4" /> },
  { id: "voice", title: "Voice", icon: <Mic className="size-4" /> },
  { id: "shortcut", title: "Shortcut", icon: <Command className="size-4" /> },
  { id: "appearance", title: "Appearance", icon: <Palette className="size-4" /> },
];

const CONTENT: Record<Section, React.ReactNode> = {
  providers: <ProvidersSettings />,
  skills: <SkillsSettings />,
  mcp: <McpSettings />,
  websearch: <WebSearchSettings />,
  voice: <VoiceSettings />,
  shortcut: <ShortcutSettings />,
  appearance: <AppearanceSettings />,
};

export function SettingsView() {
  const navigate = useNavigate();
  const [section, setSection] = React.useState<Section>("providers");
  const title = NAV.find((n) => n.id === section)?.title ?? "Settings";

  return (
    <SplitView
      storageKey="aiden-agent-settings"
      sidebarSize={{ default: 220, min: 200, max: 280 }}
      sidebar={
        <Sidebar>
          <SidebarList>
            {NAV.map((item) => (
              <SidebarListItem
                key={item.id}
                icon={item.icon}
                title={item.title}
                selected={section === item.id}
                onClick={() => setSection(item.id)}
              />
            ))}
          </SidebarList>
        </Sidebar>
      }
    >
      <ScrollArea
        className="h-full"
        title={title}
        leading={
          <Button variant="glass" size="large" onClick={() => navigate({ to: "/" })}>
            <ChevronLeft className="size-4.5" />
            Back to app
          </Button>
        }
      >
        <div className="mx-auto w-full max-w-2xl px-5 py-6">{CONTENT[section]}</div>
      </ScrollArea>
    </SplitView>
  );
}
