export const GOOGLE_PROVIDER_ID = "google";
export const LEGACY_GEMINI_PROVIDER_ID = "gemini";
export const MOONSHOT_AI_PROVIDER_ID = "moonshotai";
export const LEGACY_MOONSHOT_PROVIDER_ID = "moonshot";

/** Preserve legacy voice-mode ids while remapping Pi chat-provider ownership. */
export function migrateLegacyPiProviderId(providerId: string | undefined): string | undefined {
  if (providerId === LEGACY_GEMINI_PROVIDER_ID) return GOOGLE_PROVIDER_ID;
  if (providerId === LEGACY_MOONSHOT_PROVIDER_ID) return MOONSHOT_AI_PROVIDER_ID;
  return providerId;
}

export function migrateLegacyPiSelection(value: string): string {
  for (const [legacyId, piId] of [
    [LEGACY_GEMINI_PROVIDER_ID, GOOGLE_PROVIDER_ID],
    [LEGACY_MOONSHOT_PROVIDER_ID, MOONSHOT_AI_PROVIDER_ID],
  ]) {
    const prefix = `${legacyId}::`;
    if (value.startsWith(prefix)) return `${piId}::${value.slice(prefix.length)}`;
  }
  return value;
}

/** Preserve the narrow legacy Google migration used by older callers. */
export function migrateLegacyGoogleProviderId(providerId: string | undefined): string | undefined {
  return providerId === LEGACY_GEMINI_PROVIDER_ID ? GOOGLE_PROVIDER_ID : providerId;
}

/** Preserve the narrow legacy Google selection migration used by older callers. */
export function migrateLegacyGoogleSelection(value: string): string {
  const prefix = `${LEGACY_GEMINI_PROVIDER_ID}::`;
  return value.startsWith(prefix) ? `${GOOGLE_PROVIDER_ID}::${value.slice(prefix.length)}` : value;
}
