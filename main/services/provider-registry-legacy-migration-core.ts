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
  /**
   * A built-in signed out while its legacy record was kept for a custom alias; never import it.
   * Must reject when the marker cannot be read, not report it absent.
   */
  signedOut: (legacyId: string) => Promise<boolean>;
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
      // A marker that cannot be read fails closed: skip this run rather than undo a logout.
      if (await dependencies.signedOut(legacyId).catch(() => true)) return;
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

export interface LegacyApiKeyLogoutDependencies {
  /**
   * The legacy record provably belongs to the built-in provider: portable aliases were read
   * safely and none maps this id to a custom endpoint, whose only recovery key it would be.
   */
  ownedByBuiltin: (legacyId: string) => Promise<boolean>;
  deleteLegacy: (legacyId: string) => Promise<void>;
  /** Durably records the sign-out so a kept record is never migrated back. */
  markSignedOut: (legacyId: string) => Promise<void>;
}

/**
 * Logout removes the pre-Pi record too, so the next launch cannot migrate it back. A record whose
 * owner is unclear is kept, and a durable sign-out marker keeps the logout in force instead.
 */
export async function deleteLegacyApiKeysForPiProvider(
  piProviderId: string,
  dependencies: LegacyApiKeyLogoutDependencies,
): Promise<void> {
  for (const [legacyId, piId] of Object.entries(LEGACY_API_KEY_PROVIDER_IDS)) {
    if (piId !== piProviderId) continue;
    if (await dependencies.ownedByBuiltin(legacyId)) {
      // Deleting the record is what keeps this logout; the marker is only a second guard.
      await dependencies.markSignedOut(legacyId).catch(() => undefined);
      await dependencies.deleteLegacy(legacyId);
    } else {
      await dependencies.markSignedOut(legacyId);
    }
  }
}
