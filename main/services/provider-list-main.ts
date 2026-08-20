import { logger } from "../platform.js";
import { listProvidersWithLegacyPiCredentialMigration } from "./legacy-pi-credential-migration.js";
import { mergeCodexProvider } from "./provider-list-core.js";
import { providerRegistry } from "./provider-registry.js";

/** Authoritative configured provider list shared by Electron and Remote Access. */
export async function listConfiguredProviders() {
  const customProviders = await listProvidersWithLegacyPiCredentialMigration();
  const providers = [
    ...(await providerRegistry.listBuiltinProviders()),
    ...customProviders.filter((provider) => !providerRegistry.isBuiltinProvider(provider.id)),
  ];
  try {
    return mergeCodexProvider(providers, await providerRegistry.codex.snapshot());
  } catch {
    logger.warn("providers", "ChatGPT / Codex status was unavailable while listing providers.");
    return mergeCodexProvider(providers, null);
  }
}
