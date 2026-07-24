export const SETTINGS_SECTIONS = [
  "providers",
  "modelData",
  "skills",
  "mcp",
  "websearch",
  "computerUse",
  "scheduledTasks",
  "voice",
  "shortcut",
  "appearance",
  "about",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

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
