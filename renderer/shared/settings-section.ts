export const SETTINGS_SECTIONS = [
  "providers",
  "modelData",
  "skills",
  "mcp",
  "websearch",
  "computerUse",
  "scheduledTasks",
  "assistant",
  "voice",
  "ambientMusic",
  "shortcut",
  "appearance",
  "about",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SETTINGS_DESTINATIONS: ReadonlyArray<{
  id: SettingsSection;
  title: string;
  group: "Agent" | "App";
  keywords: string[];
}> = [
  { id: "providers", title: "Providers", group: "Agent", keywords: ["models", "api", "keys"] },
  {
    id: "modelData",
    title: "Model Pad",
    group: "Agent",
    keywords: [
      "personal",
      "models",
      "arrange",
      "rank",
      "capability",
      "speed",
      "pace",
      "artificial analysis",
    ],
  },
  { id: "skills", title: "Skills", group: "Agent", keywords: ["instructions", "tools"] },
  { id: "mcp", title: "MCP Servers", group: "Agent", keywords: ["connections", "protocol"] },
  { id: "websearch", title: "Web Search", group: "Agent", keywords: ["internet", "exa"] },
  {
    id: "scheduledTasks",
    title: "Scheduled tasks",
    group: "Agent",
    keywords: ["automation", "cron", "recurring", "background", "scripts", "notifications"],
  },
  {
    id: "assistant",
    title: "Aiden",
    group: "Agent",
    keywords: [
      "assistant",
      "companion",
      "chat",
      "hotkey",
      "shortcut",
      "model",
      "access",
      "proactive",
    ],
  },
  {
    id: "computerUse",
    title: "Computer Use",
    group: "Agent",
    keywords: ["desktop", "native apps", "accessibility", "screen recording", "beta"],
  },
  {
    id: "voice",
    title: "Voice",
    group: "App",
    keywords: ["microphone", "audio", "transcription", "dictation"],
  },
  {
    id: "ambientMusic",
    title: "Ambient Music",
    group: "App",
    keywords: ["music", "audio", "focus", "sound", "mixer", "magenta", "media controls"],
  },
  {
    id: "shortcut",
    title: "Keyboard shortcuts",
    group: "App",
    keywords: ["hotkey", "command"],
  },
  {
    id: "appearance",
    title: "Appearance",
    group: "App",
    keywords: ["theme", "light", "dark"],
  },
  {
    id: "about",
    title: "About",
    group: "App",
    keywords: ["version", "build", "github", "repository", "app information"],
  },
];

export interface SettingsCapabilities {
  ambientMusic: boolean;
}

export function settingsSectionsForCapabilities({
  ambientMusic,
}: SettingsCapabilities): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => ambientMusic || section !== "ambientMusic");
}

export function settingsDestinationsForCapabilities({
  ambientMusic,
}: SettingsCapabilities): typeof SETTINGS_DESTINATIONS {
  return SETTINGS_DESTINATIONS.filter(
    (destination) => ambientMusic || destination.id !== "ambientMusic",
  );
}

export function parseSettingsSection(value: unknown): SettingsSection | undefined {
  return typeof value === "string" && SETTINGS_SECTIONS.some((section) => section === value)
    ? (value as SettingsSection)
    : undefined;
}

export function parseSettingsSearch(search: Record<string, unknown>): {
  section?: SettingsSection;
} {
  const section = parseSettingsSection(search.section);
  return section ? { section } : {};
}
