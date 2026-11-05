export const SETTINGS_SECTIONS = [
  "providers",
  "modelData",
  "limits",
  "skills",
  "mcp",
  "websearch",
  "imageGeneration",
  "telegram",
  "remoteAccess",
  "peerHosts",
  "approvals",
  "appControls",
  "computerUse",
  "bots",
  "botComputers",
  "simulator",
  "memory",
  "scheduledTasks",
  "geminiLive",
  "voice",
  "tts",
  "links",
  "shortcut",
  "appearance",
  "about",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SETTINGS_DESTINATIONS: ReadonlyArray<{
  id: SettingsSection;
  title: string;
  /** The tab's label when it differs from the title, which search and the palette keep. */
  tabLabel?: string;
  keywords: string[];
}> = [
  { id: "providers", title: "Providers", keywords: ["models", "api", "keys", "connect my ai", "chatgpt", "lm studio", "ollama", "custom provider"] },
  {
    id: "modelData",
    title: "Model Pad",
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
  {
    id: "limits",
    title: "Context & Limits",
    keywords: [
      "rate limit",
      "usage limit",
      "wait",
      "retry",
      "subscription",
      "weekly limit",
      "429",
      "spending",
      "cost",
      "budget",
      "cap",
      "money",
    ],
  },
  { id: "skills", title: "Skills", keywords: ["instructions", "tools"] },
  {
    id: "mcp",
    title: "Connectors",
    keywords: ["mcp", "plugins", "apps", "integrations", "tools", "servers", "composio"],
  },
  {
    id: "websearch",
    title: "Web Search",
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
    id: "imageGeneration",
    title: "Image Generation",
    keywords: [
      "images",
      "image generation",
      "replicate",
      "fal",
      "openrouter",
      "flux",
      "nano banana",
      "seedream",
      "api keys",
    ],
  },
  {
    id: "telegram",
    title: "Telegram",
    keywords: ["remote", "bot", "phone", "control"],
  },
  {
    id: "remoteAccess",
    title: "Connections",
    tabLabel: "Control this device",
    keywords: ["aiden on the go", "remote access", "iphone", "ipad", "android", "connect my phone", "connect my tablet", "away from home", "tailscale", "local network", "pairing"],
  },
  {
    id: "peerHosts",
    title: "Control other devices",
    keywords: ["control other computers", "other devices", "multiple computers", "paired computers", "add device", "tailscale", "pairing"],
  },
  {
    id: "scheduledTasks",
    title: "Scheduled tasks",
    keywords: ["automation", "cron", "recurring", "background", "scripts", "notifications", "do this every day", "run later"],
  },
  {
    id: "geminiLive",
    title: "Aiden Live",
    keywords: [
      "live",
      "voice assistant",
      "orb",
      "hotkey",
      "shortcut",
      "model",
      "access",
      "proactive",
      "beta",
    ],
  },
  {
    id: "approvals",
    title: "Tool approvals",
    keywords: [
      "always allow",
      "allow for this chat",
      "remembered",
      "permissions",
      "revoke",
      "commands",
      "stop asking me",
    ],
  },
  {
    id: "appControls",
    title: "Controls in chat",
    keywords: ["chat controls", "app controls", "agent app actions", "paired-device", "change settings from chat"],
  },
  {
    id: "computerUse",
    title: "Computer Use",
    keywords: ["desktop", "native apps", "accessibility", "screen recording", "beta", "control my computer", "see my screen", "permissions"],
  },
  {
    id: "bots",
    title: "Bots",
    keywords: ["bot", "routines", "allow", "go ahead", "ask first", "approvals", "permissions", "stop asking me", "unattended"],
  },
  {
    id: "botComputers",
    title: "Bot computers",
    keywords: ["virtual machine", "vm", "lume", "macos", "bot computer", "disk space", "apple silicon"],
  },
  {
    id: "simulator",
    title: "Simulator",
    keywords: ["ios", "iphone", "ipad", "simulator", "xcode", "devices", "agent-device", "npm", "paired macs", "floating", "auto-show"],
  },
  {
    id: "memory",
    title: "Memory",
    keywords: ["remember", "facts", "recall", "workspace", "privacy"],
  },
  {
    id: "voice",
    title: "Voice",
    keywords: ["microphone", "audio", "transcription", "dictation", "use my voice", "microphone not working", "talk to aiden"],
  },
  {
    id: "tts",
    title: "Text to Speech",
    keywords: [
      "read aloud",
      "speaker",
      "speech output",
      "gemini",
      "voice design",
      "voice replication",
      "text to speech",
      "listen",
    ],
  },
  {
    id: "links",
    title: "Links",
    keywords: ["browser", "open links", "external", "system browser", "aiden browser", "url"],
  },
  {
    id: "shortcut",
    title: "Keyboard shortcuts",
    keywords: ["hotkey", "command"],
  },
  {
    id: "appearance",
    title: "Appearance",
    keywords: ["theme", "light", "dark", "mode", "system", "chat width", "layout", "wide", "narrow"],
  },
  {
    id: "about",
    title: "About",
    keywords: ["version", "build", "github", "repository", "app information", "update", "diagnostics", "logs", "reset", "onboarding", "restart"],
  },
];

export type SettingsGroup =
  | "Models & Context"
  | "Capabilities"
  | "Autonomy & Devices"
  | "Voice & Channels"
  | "App";

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  "Models & Context",
  "Capabilities",
  "Autonomy & Devices",
  "Voice & Channels",
  "App",
];

export type SettingsPageId =
  | "providers"
  | "modelData"
  | "limits"
  | "skills"
  | "mcp"
  | "websearch"
  | "imageGeneration"
  | "memory"
  | "botsApprovals"
  | "scheduledTasks"
  | "computers"
  | "simulator"
  | "voiceSpeech"
  | "connections"
  | "appearance"
  | "shortcut"
  | "about";

export type SettingsPageEntry = {
  id: SettingsPageId;
  title: string;
  group: SettingsGroup;
  /** One `section` per tab. The first available tab is the page's default. */
  tabs: readonly SettingsSection[];
  /** Sections that open a spot on the page instead of a tab. */
  anchors?: readonly SettingsSection[];
};

/** The sidebar. `section` stays the only URL state; these pages group sections into tabs. */
export const SETTINGS_PAGES: readonly SettingsPageEntry[] = [
  { id: "providers", title: "Providers", group: "Models & Context", tabs: ["providers"] },
  { id: "modelData", title: "Model Pad", group: "Models & Context", tabs: ["modelData"] },
  { id: "limits", title: "Context & Limits", group: "Models & Context", tabs: ["limits"] },
  { id: "skills", title: "Skills", group: "Capabilities", tabs: ["skills"] },
  { id: "mcp", title: "Connectors", group: "Capabilities", tabs: ["mcp"] },
  { id: "websearch", title: "Web Search", group: "Capabilities", tabs: ["websearch"] },
  { id: "imageGeneration", title: "Image Generation", group: "Capabilities", tabs: ["imageGeneration"] },
  { id: "memory", title: "Memory", group: "Capabilities", tabs: ["memory"] },
  { id: "botsApprovals", title: "Bots & Approvals", group: "Autonomy & Devices", tabs: ["bots", "approvals", "appControls"] },
  { id: "scheduledTasks", title: "Scheduled tasks", group: "Autonomy & Devices", tabs: ["scheduledTasks"] },
  { id: "computers", title: "Computers & VMs", group: "Autonomy & Devices", tabs: ["computerUse", "botComputers"] },
  { id: "simulator", title: "Simulator", group: "Autonomy & Devices", tabs: ["simulator"] },
  { id: "voiceSpeech", title: "Voice & Speech", group: "Voice & Channels", tabs: ["voice", "tts", "geminiLive"] },
  { id: "connections", title: "Connections", group: "Voice & Channels", tabs: ["remoteAccess", "peerHosts", "telegram"] },
  { id: "appearance", title: "Appearance", group: "App", tabs: ["appearance"], anchors: ["links"] },
  { id: "shortcut", title: "Keyboard shortcuts", group: "App", tabs: ["shortcut"] },
  { id: "about", title: "About", group: "App", tabs: ["about"] },
];

/** The host features that hide sections. */
export type SettingsCapabilities = {
  computerUse: boolean;
  devices: boolean;
  botComputers: boolean;
};

function isSettingsSectionAvailable(
  section: SettingsSection,
  capabilities: SettingsCapabilities,
): boolean {
  return (
    (section !== "computerUse" || capabilities.computerUse) &&
    (section !== "simulator" || capabilities.devices) &&
    (section !== "botComputers" || capabilities.botComputers)
  );
}

export function availableSettingsDestinations(
  capabilities: SettingsCapabilities,
): typeof SETTINGS_DESTINATIONS {
  return SETTINGS_DESTINATIONS.filter((destination) =>
    isSettingsSectionAvailable(destination.id, capabilities),
  );
}

/** The sections the assistant may name and open on this host. */
export function assistantSettingsSections(capabilities: SettingsCapabilities): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => isSettingsSectionAvailable(section, capabilities));
}

function destinationFor(section: SettingsSection): (typeof SETTINGS_DESTINATIONS)[number] {
  return SETTINGS_DESTINATIONS.find((destination) => destination.id === section)!;
}

/** The page that holds a section, as a tab or an anchor. */
export function pageFor(section: SettingsSection): SettingsPageEntry {
  return SETTINGS_PAGES.find(
    (page) => page.tabs.includes(section) || page.anchors?.includes(section),
  )!;
}

/** What a section's tab says. */
export function settingsTabLabel(section: SettingsSection): string {
  const destination = destinationFor(section);
  return destination.tabLabel ?? destination.title;
}

/**
 * The sidebar for this host: unavailable tabs are removed, pages with none left are
 * dropped, and a merged page left with one tab takes that tab's title.
 */
export function availableSettingsPages(capabilities: SettingsCapabilities): SettingsPageEntry[] {
  return SETTINGS_PAGES.flatMap((page) => {
    const tabs = page.tabs.filter((tab) => isSettingsSectionAvailable(tab, capabilities));
    if (tabs.length === 0) return [];
    const merged = page.tabs.length > 1 && tabs.length === 1;
    return [{ ...page, tabs, title: merged ? settingsTabLabel(tabs[0]!) : page.title }];
  });
}

/**
 * The section a deep link really opens. A section this host can't show falls to its
 * page's first available tab, then to Providers, so a link never lands on an empty page.
 */
export function resolveSettingsSection(
  requested: SettingsSection | undefined,
  capabilities: SettingsCapabilities,
): SettingsSection {
  if (!requested) return "providers";
  if (isSettingsSectionAvailable(requested, capabilities)) return requested;
  return (
    pageFor(requested).tabs.find((tab) => isSettingsSectionAvailable(tab, capabilities)) ??
    "providers"
  );
}

/**
 * The section a sidebar row opens for a search, or undefined when the page doesn't match.
 * A tab that matches on its own wins, so "approvals" opens Tool approvals and not the
 * first tab of Bots & Approvals. The page title counts only after that.
 */
export function firstMatchingSettingsSection(
  page: SettingsPageEntry,
  search: string,
  describe: (section: SettingsSection) => string = () => "",
): SettingsSection | undefined {
  const sections = [...page.tabs, ...(page.anchors ?? [])];
  const matching = (context: string) =>
    sections.find((section) =>
      matchesSettingsSearch(destinationFor(section), search, `${describe(section)} ${context}`),
    );
  const named = sections.find((section) =>
    matchesSettingsSearch({ title: destinationFor(section).title, keywords: [] }, search),
  );
  return named ?? matching("") ?? matching(page.title);
}

/**
 * Settings search matches when every whitespace-separated term appears somewhere in the
 * destination's title, keywords, or description, in any order ("phone connect").
 */
export function matchesSettingsSearch(
  destination: { title: string; keywords: string | readonly string[] },
  search: string,
  description = "",
): boolean {
  const terms = search.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return true;
  const keywords =
    typeof destination.keywords === "string" ? [destination.keywords] : destination.keywords;
  const haystack = [destination.title, ...keywords, description]
    .join(" ")
    .toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
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
