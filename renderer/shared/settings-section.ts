export const SETTINGS_SECTIONS = [
  "providers",
  "modelData",
  "skills",
  "mcp",
  "websearch",
  "telegram",
  "remoteAccess",
  "computerUse",
  "memory",
  "scheduledTasks",
  "assistant",
  "voice",
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
  { id: "providers", title: "Providers", group: "Agent", keywords: ["models", "api", "keys", "connect my ai", "chatgpt", "lm studio", "ollama", "custom provider"] },
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
      "openrouter",
      "benchmark insights",
    ],
  },
  { id: "skills", title: "Skills", group: "Agent", keywords: ["instructions", "tools"] },
  {
    id: "mcp",
    title: "Plugins",
    group: "Agent",
    keywords: ["mcp", "connections", "protocol", "plugins", "connectors"],
  },
  {
    id: "websearch",
    title: "Web Search",
    group: "Agent",
    keywords: [
      "web access",
      "search",
      "internet",
      "providers",
      "route",
      "automatic",
      "fixed",
      "privacy",
      "exa",
    ],
  },
  {
    id: "telegram",
    title: "Telegram",
    group: "Agent",
    keywords: ["remote", "bot", "phone", "control"],
  },
  {
    id: "remoteAccess",
    title: "Aiden On The Go",
    group: "Agent",
    keywords: ["remote access", "iphone", "ipad", "android", "connect my phone", "connect my tablet", "away from home", "tailscale", "local network", "pairing"],
  },
  {
    id: "scheduledTasks",
    title: "Scheduled tasks",
    group: "Agent",
    keywords: ["automation", "cron", "recurring", "background", "scripts", "notifications", "do this every day", "run later"],
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
    keywords: ["desktop", "native apps", "accessibility", "screen recording", "beta", "control my computer", "see my screen", "permissions"],
  },
  {
    id: "memory",
    title: "Memory",
    group: "Agent",
    keywords: ["remember", "facts", "recall", "workspace", "privacy"],
  },
  {
    id: "voice",
    title: "Voice",
    group: "App",
    keywords: ["microphone", "audio", "transcription", "dictation", "use my voice", "microphone not working", "talk to aiden"],
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
