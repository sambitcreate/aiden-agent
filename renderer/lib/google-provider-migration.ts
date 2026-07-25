import { migrateLegacyPiProviderId } from "../shared/google-provider";
import { MODEL_PAD_LAYOUT_KEY } from "./model-pad-layout";
import { PINNED_MODELS_KEY } from "./model-picker-data";

export const SELECTED_PROVIDER_KEY = "aiden-agent.providerId";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function migrateProviderId(
  providerId: string | undefined,
  aliases: Readonly<Record<string, string>>,
): string | undefined {
  return providerId ? (aliases[providerId] ?? migrateLegacyPiProviderId(providerId)) : providerId;
}

function migrateSelection(value: string, aliases: Readonly<Record<string, string>>): string {
  const separator = value.indexOf("::");
  if (separator < 0) return migrateProviderId(value, aliases) ?? value;
  const providerId = value.slice(0, separator);
  const modelId = value.slice(separator + 2);
  const migratedProviderId = migrateProviderId(providerId, aliases) ?? providerId;
  return `${migratedProviderId}::${modelId}`;
}

function migrateStringList(
  raw: string | null,
  aliases: Readonly<Record<string, string>>,
): string | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    const migrated = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => migrateSelection(entry, aliases));
    return JSON.stringify([...new Set(migrated)]);
  } catch {
    return null;
  }
}

function migrateModelPad(
  raw: string | null,
  aliases: Readonly<Record<string, string>>,
): string | null {
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
      const next = migrateSelection(selection, aliases);
      // An already-canonical preference wins over its legacy duplicate.
      if (!(next in migrated) || selection === next) {
        migrated[next] = placement;
      }
    }
    return JSON.stringify({ ...value, placements: migrated });
  } catch {
    return null;
  }
}

/** Run before React reads local preferences. Safe to repeat on every launch. */
export function migrateGoogleProviderPreferences(
  storage: StorageLike,
  aliases: Readonly<Record<string, string>> = {},
): boolean {
  let changed = false;
  try {
    const selected = storage.getItem(SELECTED_PROVIDER_KEY);
    const migratedSelected = migrateProviderId(selected ?? undefined, aliases);
    if (migratedSelected && migratedSelected !== selected) {
      storage.setItem(SELECTED_PROVIDER_KEY, migratedSelected);
      changed = true;
    }

    const pinned = storage.getItem(PINNED_MODELS_KEY);
    const migratedPinned = migrateStringList(pinned, aliases);
    if (migratedPinned !== null && migratedPinned !== pinned) {
      storage.setItem(PINNED_MODELS_KEY, migratedPinned);
      changed = true;
    }

    const layout = storage.getItem(MODEL_PAD_LAYOUT_KEY);
    const migratedLayout = migrateModelPad(layout, aliases);
    if (migratedLayout !== null && migratedLayout !== layout) {
      storage.setItem(MODEL_PAD_LAYOUT_KEY, migratedLayout);
      changed = true;
    }
  } catch {
    // Preferences are conveniences. Storage denial must not block app startup.
  }
  return changed;
}
