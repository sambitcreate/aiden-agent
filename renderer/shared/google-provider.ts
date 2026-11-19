export const AZURE_PROVIDER_ID = "azure";
export const LEGACY_AZURE_PROVIDER_ID = "azure-openai-responses";

export const GOOGLE_PROVIDER_ID = "google";
export const LEGACY_GEMINI_PROVIDER_ID = "gemini";
export const MOONSHOT_AI_PROVIDER_ID = "moonshotai";
export const LEGACY_MOONSHOT_PROVIDER_ID = "moonshot";

/** Aiden's Google chat catalog excludes legacy families, including dated variants. */
export function isSelectableGoogleCatalogModel(modelId: string): boolean {
  return !/^gemini-(?:2\.5|2\.0|1\.5)(?:-|$)/iu.test(
    modelId.replace(/^models\//iu, ""),
  );
}

/** Preserve legacy voice-mode ids while remapping Pi chat-provider ownership. */
export function migrateLegacyPiProviderId(providerId: string | undefined): string | undefined {
  if (providerId === LEGACY_AZURE_PROVIDER_ID) return AZURE_PROVIDER_ID;
  if (providerId === LEGACY_GEMINI_PROVIDER_ID) return GOOGLE_PROVIDER_ID;
  if (providerId === LEGACY_MOONSHOT_PROVIDER_ID) return MOONSHOT_AI_PROVIDER_ID;
  return providerId;
}

/** Preserve the narrow legacy Google migration used by older callers. */
export function migrateLegacyGoogleProviderId(providerId: string | undefined): string | undefined {
  return providerId === LEGACY_GEMINI_PROVIDER_ID ? GOOGLE_PROVIDER_ID : providerId;
}
