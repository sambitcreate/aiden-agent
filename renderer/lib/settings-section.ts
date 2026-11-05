import type { SettingsSection } from "../shared/settings-section";

export * from "../shared/settings-section";

declare module "@tanstack/history" {
  interface HistoryState {
    /** Set when someone asks for a spot on a Settings page. A new value is a new request. */
    aidenSettingsAnchor?: number;
  }
}

/**
 * Where a Settings section lives. Asking for the same spot twice is the same URL, so the
 * request rides on the history entry and the page can scroll back to it.
 */
export function settingsLocation(section: SettingsSection) {
  return {
    to: "/settings" as const,
    search: { section },
    ...(section === "links" ? { state: { aidenSettingsAnchor: Date.now() } } : {}),
  };
}
