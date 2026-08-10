/** IDs reserved for Aiden-owned custom connections, never Pi built-ins. */
export const CUSTOM_PROVIDER_ID_PREFIX = "custom:";

export function isCustomProviderId(providerId: string): boolean {
  return (
    providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX) &&
    providerId.length > CUSTOM_PROVIDER_ID_PREFIX.length
  );
}

export function customProviderId(providerId: string): string {
  const normalized = providerId.trim();
  return isCustomProviderId(normalized)
    ? normalized
    : `${CUSTOM_PROVIDER_ID_PREFIX}${normalized || "connection"}`;
}

/**
 * Aiden template identities, deliberately separate from Pi's provider IDs.
 * Legacy spellings and collision-safe numeric siblings remain recognized so
 * migrated local connections retain specialized discovery and loading probes.
 */
export function isLmStudioProviderId(providerId: string): boolean {
  return (
    providerId === "lmstudio" ||
    providerId === `${CUSTOM_PROVIDER_ID_PREFIX}lmstudio` ||
    /^custom:lmstudio-(?:[2-9]|[1-9]\d+)$/u.test(providerId)
  );
}

export function isOllamaProviderId(providerId: string): boolean {
  return (
    providerId === "ollama" ||
    providerId === `${CUSTOM_PROVIDER_ID_PREFIX}ollama` ||
    /^custom:ollama-(?:[2-9]|[1-9]\d+)$/u.test(providerId)
  );
}
