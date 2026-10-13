import { migrateLegacyPiProviderId } from "../shared/google-provider";

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

/**
 * Run before React reads the remembered provider. Safe to repeat on every
 * launch. Model Pad placements and pins live in main-process settings, which
 * re-homes them with the provider-id migration itself.
 */
export function migrateGoogleProviderPreferences(
  storage: StorageLike,
  aliases: Readonly<Record<string, string>> = {},
): boolean {
  try {
    const selected = storage.getItem(SELECTED_PROVIDER_KEY);
    const migratedSelected = migrateProviderId(selected ?? undefined, aliases);
    if (migratedSelected && migratedSelected !== selected) {
      storage.setItem(SELECTED_PROVIDER_KEY, migratedSelected);
      return true;
    }
  } catch {
    // Preferences are conveniences. Storage denial must not block app startup.
  }
  return false;
}
