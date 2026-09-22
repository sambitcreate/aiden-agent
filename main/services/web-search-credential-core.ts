import {
  getWebSearchProviderDefinition,
  isWebSearchProviderId,
  MAX_WEB_SEARCH_PROVIDER_ENDPOINT_CHARS,
  type BoundedNonSecretProviderConfig,
  type WebSearchProviderId,
} from "./web-search-provider-registry-core.js";

/** Stable namespace for Web Search credentials in the encrypted key store. */
export const WEB_SEARCH_CREDENTIAL_PREFIX = "web-search:";
export const WEB_SEARCH_API_KEY_SLOT = "api-key";
/** The pre-v2 Exa key is intentionally retained as a read/migration input. */
export const LEGACY_EXA_SECRET_ID = "exa";
export const MAX_WEB_SEARCH_CREDENTIAL_CHARS = 16_384;
export const MAX_WEB_SEARCH_CREDENTIAL_BYTES = 64 * 1_024;

export interface WebSearchCredentialReference {
  providerId: WebSearchProviderId;
  credentialSlot: typeof WEB_SEARCH_API_KEY_SLOT;
  secretId: string;
  binding: string;
  legacySecretId?: typeof LEGACY_EXA_SECRET_ID;
}

/** Narrow encrypted-store seam. Implementations must never expose key metadata to the renderer. */
export interface WebSearchEncryptedSecretPort {
  getProviderKey(providerId: string, binding: string): Promise<string | null>;
  getOrBindLegacyProviderKey(providerId: string, binding: string): Promise<string | null>;
  setProviderKey(
    providerId: string,
    key: string,
    binding: string,
    isCurrent?: () => boolean,
  ): Promise<void>;
  deleteKey(providerId: string, isCurrent?: () => boolean): Promise<void>;
}

export interface WebSearchCredentialAccess {
  reference(
    providerId: unknown,
    providerConfig?: BoundedNonSecretProviderConfig,
  ): WebSearchCredentialReference;
  read(reference: WebSearchCredentialReference): Promise<string | null>;
  has(reference: WebSearchCredentialReference): Promise<boolean>;
  set(
    reference: WebSearchCredentialReference,
    key: unknown,
    isCurrent?: () => boolean,
  ): Promise<void>;
  remove(reference: WebSearchCredentialReference, isCurrent?: () => boolean): Promise<void>;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // Include C0, DEL, and C1 controls. They have no place in an API key and
    // can otherwise become log/header delimiters at a later adapter boundary.
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Validate write-only credential input without returning or logging its value. */
export function normalizeWebSearchCredential(value: unknown): string {
  if (typeof value !== "string") throw new Error("Web Search credential must be a string.");
  const normalized = value.trim();
  if (
    !normalized ||
    hasControlCharacter(normalized) ||
    Array.from(normalized).length > MAX_WEB_SEARCH_CREDENTIAL_CHARS ||
    utf8Bytes(normalized) > MAX_WEB_SEARCH_CREDENTIAL_BYTES
  ) {
    throw new Error("Web Search credential is invalid or exceeds its size limit.");
  }
  return normalized;
}

function normalizedEndpoint(
  providerId: WebSearchProviderId,
  providerConfig: BoundedNonSecretProviderConfig | undefined,
): string | undefined {
  const endpoint = providerConfig?.endpoint;
  if (endpoint === undefined) return undefined;
  if (
    typeof endpoint !== "string" ||
    !endpoint.trim() ||
    endpoint.length > MAX_WEB_SEARCH_PROVIDER_ENDPOINT_CHARS ||
    hasControlCharacter(endpoint)
  ) {
    throw new Error(`Web Search ${providerId} endpoint is invalid.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint.trim());
  } catch {
    throw new Error(`Web Search ${providerId} endpoint is invalid.`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Web Search ${providerId} endpoint is invalid.`);
  }
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, parsed.pathname === "/" ? "/" : "");
}

function credentialOrigin(
  providerId: WebSearchProviderId,
  providerConfig: BoundedNonSecretProviderConfig | undefined,
): string {
  const definition = getWebSearchProviderDefinition(providerId);
  if (!definition) throw new Error("Unknown Web Search provider.");
  // Exa's API-key adapter uses the direct API origin; its anonymous MCP
  // origin must never become the binding for a keyed credential.
  if (providerId === "exa") return definition.fixedOrigins[1] ?? definition.fixedOrigins[0]!;
  const endpoint = normalizedEndpoint(providerId, providerConfig);
  if (endpoint) return endpoint;
  const fixedOrigin = definition.fixedOrigins[0];
  if (fixedOrigin) return fixedOrigin;
  throw new Error(`Web Search ${providerId} requires an explicit endpoint.`);
}

function supportsApiKey(providerId: WebSearchProviderId): boolean {
  const definition = getWebSearchProviderDefinition(providerId);
  if (!definition || definition.releaseState === "blocked") return false;
  const kind = definition.credentialKind;
  return (
    kind === "optional-api-key" ||
    kind === "api-key" ||
    kind === "endpoint-and-api-key" ||
    kind === "api-key-and-zone"
  );
}

/** Build a stable, non-secret ID + endpoint binding for one provider credential. */
export function webSearchCredentialReference(
  providerId: unknown,
  providerConfig?: BoundedNonSecretProviderConfig,
): WebSearchCredentialReference {
  if (!isWebSearchProviderId(providerId) || !supportsApiKey(providerId)) {
    throw new Error("This Web Search provider does not accept an API key.");
  }
  const endpoint = credentialOrigin(providerId, providerConfig);
  const binding = JSON.stringify({
    version: 1,
    providerId,
    credentialSlot: WEB_SEARCH_API_KEY_SLOT,
    endpoint,
    ...(providerConfig?.zone === undefined ? {} : { zone: providerConfig.zone }),
  });
  return {
    providerId,
    credentialSlot: WEB_SEARCH_API_KEY_SLOT,
    secretId: `${WEB_SEARCH_CREDENTIAL_PREFIX}${providerId}:${WEB_SEARCH_API_KEY_SLOT}`,
    binding,
    ...(providerId === "exa" ? { legacySecretId: LEGACY_EXA_SECRET_ID } : {}),
  };
}

/** Main-only credential access with exact compatibility for the legacy Exa slot. */
export function createWebSearchCredentialAccess(
  secrets: WebSearchEncryptedSecretPort,
): WebSearchCredentialAccess {
  return {
    reference: webSearchCredentialReference,

    async read(reference) {
      const current = await secrets.getProviderKey(reference.secretId, reference.binding);
      if (current !== null) return current;
      if (reference.legacySecretId) {
        return secrets.getOrBindLegacyProviderKey(reference.legacySecretId, reference.binding);
      }
      return null;
    },

    async has(reference) {
      return (await this.read(reference)) !== null;
    },

    async set(reference, key, isCurrent = () => true) {
      const normalized = normalizeWebSearchCredential(key);
      await secrets.setProviderKey(reference.secretId, normalized, reference.binding, isCurrent);
    },

    async remove(reference, isCurrent = () => true) {
      await secrets.deleteKey(reference.secretId, isCurrent);
      // Removal is provider-scoped. Clear the old Exa slot too so a removed
      // credential cannot silently reappear through the compatibility path.
      if (reference.legacySecretId) await secrets.deleteKey(reference.legacySecretId, isCurrent);
    },
  };
}
