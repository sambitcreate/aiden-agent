import { isSettingsAnchor, type SettingsSection } from "../shared/settings-section";

export * from "../shared/settings-section";

/**
 * Where a Settings section lives. Asking for the same spot twice is the same URL, so the
 * request rides on the history entry and the page can scroll back to it.
 */
export function settingsLocation(
  section: SettingsSection,
  from?: { pathname: string },
) {
  return {
    to: "/settings" as const,
    search: { section },
    // Settings is one history entry, so Back to app leaves it from any page.
    ...(from?.pathname === "/settings" ? { replace: true } : {}),
    ...(isSettingsAnchor(section) ? { state: { aidenSettingsAnchor: Date.now() } } : {}),
  };
}
