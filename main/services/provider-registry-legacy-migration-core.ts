import type { CredentialStore } from "@earendil-works/pi-ai";

/** IDs used by Aiden before Pi became the provider authority. */
export const LEGACY_API_KEY_PROVIDER_IDS: Readonly<Record<string, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  deepseek: "deepseek",
  moonshot: "moonshotai",
};

export interface LegacyApiKeyMigrationDependencies {
  readLegacy: (legacyId: string) => Promise<string | null>;
  deleteLegacy: (legacyId: string) => Promise<void>;
  credentials: Pick<CredentialStore, "read" | "modify">;
}

/**
 * Move pre-Pi key records into Pi's credential store. A current Pi credential
 * always wins. The legacy record is deleted once Pi holds a credential, so a
 * later logout cannot be undone by migrating the same key again.
 */
export async function migrateLegacyApiKeysToPi(
  dependencies: LegacyApiKeyMigrationDependencies,
): Promise<void> {
  await Promise.all(
    Object.entries(LEGACY_API_KEY_PROVIDER_IDS).map(async ([legacyId, piId]) => {
      if (await dependencies.credentials.read(piId)) return;
      const key = await dependencies.readLegacy(legacyId);
      if (!key?.trim()) return;
      await dependencies.credentials.modify(
        piId,
        async (current) => current ?? { type: "api_key", key: key.trim() },
      );
      await dependencies.deleteLegacy(legacyId);
    }),
  );
}

/** Logout removes the pre-Pi record too, so the next launch cannot migrate it back. */
export async function deleteLegacyApiKeysForPiProvider(
  piProviderId: string,
  deleteLegacy: (legacyId: string) => Promise<void>,
): Promise<void> {
  for (const [legacyId, piId] of Object.entries(LEGACY_API_KEY_PROVIDER_IDS)) {
    if (piId === piProviderId) await deleteLegacy(legacyId);
  }
}
