import type { AuthResult } from "@earendil-works/pi-ai";
import {
  CREATE_IMAGES_GEMINI_RELEASE_CATALOG,
  CREATE_IMAGES_PROVIDER_STATUS_VERSION,
  type CreateImagesProviderStatus,
} from "../../../renderer/shared/create-images/providers.js";

export const CREATE_IMAGES_GEMINI_CREDENTIAL_PROVIDER_ID = "google" as const;

export interface GeminiProviderCredentialAuthority {
  credentialKind(): Promise<"api_key" | "oauth" | undefined>;
  requestAuth(): Promise<AuthResult | undefined>;
}

function usableApiKey(auth: AuthResult | undefined): boolean {
  const key = auth?.auth.apiKey;
  return typeof key === "string" && /^[\x21-\x7e]{1,512}$/u.test(key);
}

export async function createImagesGeminiProviderStatus(
  authority: GeminiProviderCredentialAuthority,
): Promise<CreateImagesProviderStatus> {
  let kind: "api_key" | "oauth" | undefined;
  try {
    kind = await authority.credentialKind();
  } catch {
    return {
      schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
      providerId: "gemini",
      displayName: "Google Gemini",
      connectionState: "unavailable",
      safeErrorCode: "feature-unavailable",
    };
  }
  if (kind === undefined) {
    return {
      schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
      providerId: "gemini",
      displayName: "Google Gemini",
      connectionState: "disconnected",
      safeErrorCode: "credential-missing",
    };
  }
  if (kind !== "api_key") {
    return {
      schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
      providerId: "gemini",
      displayName: "Google Gemini",
      connectionState: "unavailable",
      safeErrorCode: "credential-scope-unverified",
    };
  }
  let auth: AuthResult | undefined;
  try {
    auth = await authority.requestAuth();
  } catch {
    return {
      schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
      providerId: "gemini",
      displayName: "Google Gemini",
      connectionState: "invalid",
      credentialKind: "google-api-key",
      safeErrorCode: "credential-invalid",
    };
  }
  if (!usableApiKey(auth)) {
    return {
      schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
      providerId: "gemini",
      displayName: "Google Gemini",
      connectionState: "invalid",
      credentialKind: "google-api-key",
      safeErrorCode: "credential-invalid",
    };
  }
  return {
    schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
    providerId: "gemini",
    displayName: "Google Gemini",
    connectionState: "connected",
    credentialKind: "google-api-key",
    capabilitySnapshot: CREATE_IMAGES_GEMINI_RELEASE_CATALOG,
  };
}

export async function resolveCreateImagesGeminiApiKeyAuth(
  authority: GeminiProviderCredentialAuthority,
): Promise<AuthResult> {
  const kind = await authority.credentialKind();
  if (kind !== "api_key") {
    throw new Error(
      kind === undefined
        ? "Connect a Google Gemini API key in Settings before starting this run."
        : "Create Images requires a Google API-key connection; OAuth is not authorized for this request.",
    );
  }
  const auth = await authority.requestAuth();
  if (!usableApiKey(auth)) {
    throw new Error("The configured Google API key is unavailable or invalid.");
  }
  return auth!;
}
