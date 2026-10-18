import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_SETTINGS,
  isBrowserLinkOpening,
  type BrowserDefaults,
  type BrowserProfile,
  type BrowserTab,
} from "../../../renderer/shared/browser.js";
import { browserBoundedNumber, savedLinkOpening } from "./core.js";

export function browserProfileName(value: unknown): string {
  if (typeof value !== "string" || value.length > 48) throw new Error("Invalid profile name.");
  const name = value.trim();
  if (!name) throw new Error("Enter a profile name.");
  return name;
}

export function validBrowserViewport(viewport: BrowserTab["viewport"]): BrowserTab["viewport"] {
  if (!viewport || !["fill", "responsive"].includes(viewport.mode))
    throw new Error("Invalid browser viewport mode.");
  const width = Math.round(browserBoundedNumber(viewport.width, 240, 3_840, "Viewport width"));
  const height = Math.round(browserBoundedNumber(viewport.height, 240, 3_840, "Viewport height"));
  if (width * height > 8_294_400) throw new Error("Browser viewport is too large.");
  return {
    mode: viewport.mode,
    width,
    height,
    ...(typeof viewport.deviceName === "string"
      ? { deviceName: viewport.deviceName.slice(0, 100) }
      : {}),
    ...(typeof viewport.ratioLocked === "boolean" ? { ratioLocked: viewport.ratioLocked } : {}),
  };
}

/** Merge `input` over valid `base` defaults; throws when the merged result is invalid. */
export function validBrowserDefaults(
  base: BrowserDefaults,
  input: Partial<BrowserDefaults>,
  assertProfile: (profileId: string) => unknown,
): BrowserDefaults {
  const result = { ...base, ...input };
  assertProfile(result.profileId);
  if (!["system", "light", "dark"].includes(result.appearance))
    throw new Error("Invalid browser appearance.");
  if (!isBrowserLinkOpening(result.linkOpening))
    throw new Error("Invalid link opening preference.");
  delete (result as { linkTarget?: unknown }).linkTarget;
  if (!["off", "allow"].includes(result.agentAccess))
    throw new Error("Invalid browser agent access.");
  if (typeof result.autoShow !== "boolean")
    throw new Error("Invalid browser automatic visibility.");
  browserBoundedNumber(result.zoom, 0.25, 5, "Zoom");
  browserBoundedNumber(result.recordingFps, 1, 60, "Recording frame rate");
  result.viewport = validBrowserViewport(result.viewport);
  return result;
}

export interface BrowserPreferences {
  /** Saved persistent profiles, in addition to the built-in ones. */
  profiles: BrowserProfile[];
  defaults: BrowserDefaults;
  workspaceAccess: Map<string, "allow" | "off">;
}

/**
 * Read `browser/state.json`. Every profile, default field and workspace
 * override stands alone: one invalid value falls back to its default instead
 * of discarding everything after it (which the next save would persist).
 */
export function parseBrowserPreferences(saved: unknown): BrowserPreferences {
  const preferences: BrowserPreferences = {
    profiles: [],
    defaults: structuredClone(DEFAULT_BROWSER_SETTINGS),
    workspaceAccess: new Map(),
  };
  if (!saved || typeof saved !== "object") return preferences;
  const record = saved as Record<string, unknown>;
  if (Array.isArray(record.profiles))
    for (const profile of record.profiles.slice(0, 24)) {
      if (!profile || typeof profile !== "object") continue;
      const { id, name } = profile as Record<string, unknown>;
      if (typeof id !== "string" || !/^profile-[a-z\d-]+$/i.test(id)) continue;
      try {
        preferences.profiles.push({ id, name: browserProfileName(name), kind: "persistent" });
      } catch {
        /* An unreadable profile name skips only that profile. */
      }
    }
  if (record.defaults && typeof record.defaults === "object") {
    const legacy = record.defaults as Record<string, unknown>;
    const { linkTarget: _legacyTarget, ...current } = legacy;
    const known = [...BUILT_IN_BROWSER_PROFILES, ...preferences.profiles];
    const assertProfile = (profileId: string) => {
      if (!known.some((profile) => profile.id === profileId))
        throw new Error("This browser profile no longer exists.");
    };
    for (const [field, value] of Object.entries({ ...current, linkOpening: savedLinkOpening(legacy) })) {
      try {
        preferences.defaults = validBrowserDefaults(
          preferences.defaults,
          { [field]: value } as Partial<BrowserDefaults>,
          assertProfile,
        );
      } catch {
        /* An invalid field keeps its default. */
      }
    }
  }
  if (record.workspaceAccess && typeof record.workspaceAccess === "object")
    for (const [id, access] of Object.entries(record.workspaceAccess).slice(0, 1000)) {
      if (id.length > 0 && id.length <= 200 && (access === "allow" || access === "off"))
        preferences.workspaceAccess.set(id, access);
    }
  return preferences;
}
