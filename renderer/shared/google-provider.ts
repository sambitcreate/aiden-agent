export const GOOGLE_PROVIDER_ID = "google";
export const LEGACY_GEMINI_PROVIDER_ID = "gemini";

/** Preserve legacy voice-mode ids while remapping chat-provider ownership. */
export function migrateLegacyGoogleProviderId(providerId: string | undefined): string | undefined {
  return providerId === LEGACY_GEMINI_PROVIDER_ID ? GOOGLE_PROVIDER_ID : providerId;
}

export function migrateLegacyGoogleSelection(value: string): string {
  const prefix = `${LEGACY_GEMINI_PROVIDER_ID}::`;
  return value.startsWith(prefix) ? `${GOOGLE_PROVIDER_ID}::${value.slice(prefix.length)}` : value;
}
