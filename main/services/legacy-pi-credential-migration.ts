import { logger } from "../platform.js";
import { configStore } from "./config-store.js";
import { listProvidersWithSafeLegacyPiCredentialMigration } from "./legacy-pi-credential-migration-core.js";
import { providerRegistry } from "./provider-registry.js";

export function listProvidersWithLegacyPiCredentialMigration() {
  return listProvidersWithSafeLegacyPiCredentialMigration({
    listProviders: () => configStore.listProviders(),
    migrationReady: () => configStore.providerLegacyCredentialMigrationReady(),
    migrate: () => providerRegistry.migrateLegacyApiKeys(),
    onDeferred: () => {
      logger.warn(
        "providers",
        "Deferred legacy Pi credential migration until portable provider aliases are safe.",
      );
    },
    onMigrationError: (error) => {
      logger.warn("providers", "Could not migrate a legacy provider credential into Pi.", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}
