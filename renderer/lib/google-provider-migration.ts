import {
  GOOGLE_PROVIDER_ID,
  LEGACY_GEMINI_PROVIDER_ID,
  migrateLegacyGoogleSelection,
} from "../shared/google-provider";
import { MODEL_PAD_LAYOUT_KEY } from "./model-pad-layout";
import { PINNED_MODELS_KEY } from "./model-picker-data";

export const SELECTED_PROVIDER_KEY = "aiden-agent.providerId";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function migrateStringList(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    const migrated = value
      .filter((entry): entry is string => typeof entry === "string")
      .map(migrateLegacyGoogleSelection);
    return JSON.stringify([...new Set(migrated)]);
  } catch {
    return null;
  }
}

function migrateModelPad(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const layout = value as { placements?: unknown };
    if (
      !layout.placements ||
      typeof layout.placements !== "object" ||
      Array.isArray(layout.placements)
    )
      return null;
    const placements = layout.placements as Record<string, unknown>;
    const migrated: Record<string, unknown> = {};
    for (const [selection, placement] of Object.entries(placements)) {
      const next = migrateLegacyGoogleSelection(selection);
      // An already-native preference wins over its legacy duplicate.
      if (!(next in migrated) || selection.startsWith(`${GOOGLE_PROVIDER_ID}::`)) {
        migrated[next] = placement;
      }
    }
    return JSON.stringify({ ...value, placements: migrated });
  } catch {
    return null;
  }
}

/** Run before React reads local preferences. Safe to repeat on every launch. */
export function migrateGoogleProviderPreferences(storage: StorageLike): boolean {
  let changed = false;
  try {
    if (storage.getItem(SELECTED_PROVIDER_KEY) === LEGACY_GEMINI_PROVIDER_ID) {
      storage.setItem(SELECTED_PROVIDER_KEY, GOOGLE_PROVIDER_ID);
      changed = true;
    }

    const pinned = storage.getItem(PINNED_MODELS_KEY);
    const migratedPinned = migrateStringList(pinned);
    if (migratedPinned !== null && migratedPinned !== pinned) {
      storage.setItem(PINNED_MODELS_KEY, migratedPinned);
      changed = true;
    }

    const layout = storage.getItem(MODEL_PAD_LAYOUT_KEY);
    const migratedLayout = migrateModelPad(layout);
    if (migratedLayout !== null && migratedLayout !== layout) {
      storage.setItem(MODEL_PAD_LAYOUT_KEY, migratedLayout);
      changed = true;
    }
  } catch {
    // Preferences are conveniences. Storage denial must not block app startup.
  }
  return changed;
}
