export interface LegacyPiCredentialMigrationDependencies<T> {
  listProviders: () => Promise<T[]>;
  migrationReady: () => Promise<boolean>;
  migrate: () => Promise<void>;
  onDeferred?: () => void;
  onMigrationError?: (error: unknown) => void;
}

/**
 * Every path that can reach Pi credentials must pass through the same config
 * and encrypted-alias gate. Returning the provider list keeps Settings from
 * needing a separate, accidentally divergent migration path.
 */
export async function listProvidersWithSafeLegacyPiCredentialMigration<T>(
  dependencies: LegacyPiCredentialMigrationDependencies<T>,
): Promise<T[]> {
  const providers = await dependencies.listProviders();
  if (!(await dependencies.migrationReady())) {
    dependencies.onDeferred?.();
    return providers;
  }
  try {
    await dependencies.migrate();
  } catch (error) {
    dependencies.onMigrationError?.(error);
  }
  return providers;
}
