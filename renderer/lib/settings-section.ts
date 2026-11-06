import type { SettingsSection } from "../shared/settings-section";

export * from "../shared/settings-section";

/**
 * Where a Settings section lives. Asking for the same spot twice is the same URL, so the
 * request rides on the history entry and the page can scroll back to it.
 */
export function settingsLocation(
  section: SettingsSection,
  from?: { pathname: string; search: { section?: unknown } },
) {
  return {
    to: "/settings" as const,
    search: { section },
    // Asking again for the page already open must not stack a history entry.
    ...(from?.pathname === "/settings" && from.search.section === section ? { replace: true } : {}),
    ...(section === "links" ? { state: { aidenSettingsAnchor: Date.now() } } : {}),
  };
}
