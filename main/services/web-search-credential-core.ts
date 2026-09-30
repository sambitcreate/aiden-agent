import {
  getWebSearchProviderDefinition,
  isWebSearchProviderId,
  MAX_WEB_SEARCH_PROVIDER_ENDPOINT_CHARS,
  type BoundedNonSecretProviderConfig,
  type WebSearchProviderId,
} from "./web-search-provider-registry-core.js";
import {
  EMPTY_WEB_SEARCH_KEY_POOL_DOCUMENT,
  MAX_WEB_SEARCH_KEY_POOL_ENTRIES,
  WEB_SEARCH_KEY_POOL_PRIMARY_ENTRY_ID,
  isWebSearchKeyPoolEntryId,
  isWebSearchKeyPoolStrategy,
  normalizeWebSearchKeyPoolLabel,
  parseWebSearchKeyPoolDocument,
  reorderWebSearchKeyPoolEntries,
  serializeWebSearchKeyPoolDocument,
  webSearchKeyPoolEntrySecretId,
  webSearchKeyPoolIndexSecretId,
  webSearchKeyPoolSupported,
  type WebSearchKeyPool,
  type WebSearchKeyPoolDocument,
  type WebSearchPooledKey,
} from "./web-search-key-pool-core.js";

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
  deleteKeyFamily(providerId: string, isCurrent?: () => boolean): Promise<void>;
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
  /**
   * Non-secret pool index for a pool-capable provider: order, labels, and
   * strategy of the keys that currently exist. Never includes key material.
   */
  listPool(reference: WebSearchCredentialReference): Promise<WebSearchKeyPoolDocument>;
  /** Main-only: every existing pooled key, in index order. */
  readPool(reference: WebSearchCredentialReference): Promise<WebSearchKeyPool>;
  addPoolKey(
    reference: WebSearchCredentialReference,
    key: unknown,
    label?: unknown,
    isCurrent?: () => boolean,
  ): Promise<WebSearchKeyPoolDocument>;
  removePoolKey(
    reference: WebSearchCredentialReference,
    entryId: unknown,
    isCurrent?: () => boolean,
  ): Promise<WebSearchKeyPoolDocument>;
  reorderPool(
    reference: WebSearchCredentialReference,
    orderedIds: unknown,
    isCurrent?: () => boolean,
  ): Promise<WebSearchKeyPoolDocument>;
  setPoolStrategy(
    reference: WebSearchCredentialReference,
    strategy: unknown,
    isCurrent?: () => boolean,
  ): Promise<WebSearchKeyPoolDocument>;
}

export interface WebSearchCredentialAccessOptions {
  /** Opaque pool entry IDs; injectable for deterministic tests. */
  readonly createEntryId?: () => string;
  readonly now?: () => number;
}

function defaultEntryId(): string {
  return globalThis.crypto.randomUUID().replace(/-/gu, "").slice(0, 16);
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
  options: WebSearchCredentialAccessOptions = {},
): WebSearchCredentialAccess {
  const createEntryId = options.createEntryId ?? defaultEntryId;
  const now = options.now ?? Date.now;
  // Pool index writes are read-modify-write; serialize them per process so
  // two quick Settings actions cannot drop each other's change.
  let poolTail: Promise<unknown> = Promise.resolve();
  const serializedPool = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = poolTail.then(operation, operation);
    poolTail = result.catch(() => undefined);
    return result;
  };

  const readPrimary = async (reference: WebSearchCredentialReference) => {
    const current = await secrets.getProviderKey(reference.secretId, reference.binding);
    if (current !== null) return current;
    if (reference.legacySecretId) {
      return secrets.getOrBindLegacyProviderKey(reference.legacySecretId, reference.binding);
    }
    return null;
  };

  const readEntryKey = (reference: WebSearchCredentialReference, entryId: string) =>
    entryId === WEB_SEARCH_KEY_POOL_PRIMARY_ENTRY_ID
      ? readPrimary(reference)
      : secrets.getProviderKey(
          webSearchKeyPoolEntrySecretId(reference.secretId, entryId),
          reference.binding,
        );

  /**
   * Resolve the index against the keys that actually exist. A key saved
   * before pools existed (no index) becomes the single primary entry.
   */
  const loadPool = async (
    reference: WebSearchCredentialReference,
  ): Promise<{ document: WebSearchKeyPoolDocument; keys: WebSearchPooledKey[] }> => {
    const stored = parseWebSearchKeyPoolDocument(
      await secrets.getProviderKey(
        webSearchKeyPoolIndexSecretId(reference.secretId),
        reference.binding,
      ),
    );
    const document: WebSearchKeyPoolDocument = stored ?? {
      ...EMPTY_WEB_SEARCH_KEY_POOL_DOCUMENT,
      entries: [{ id: WEB_SEARCH_KEY_POOL_PRIMARY_ENTRY_ID, label: "Key 1", addedAt: 0 }],
    };
    const loaded = await Promise.all(
      document.entries.map(async (entry) => ({
        entry,
        key: await readEntryKey(reference, entry.id),
      })),
    );
    const present = loaded.flatMap((item) =>
      item.key === null ? [] : [{ entry: item.entry, key: item.key }],
    );
    return {
      document: { ...document, entries: present.map((item) => item.entry) },
      keys: present.map((item) => ({ id: item.entry.id, key: item.key })),
    };
  };

  const assertPool = (reference: WebSearchCredentialReference) => {
    if (!webSearchKeyPoolSupported(reference.providerId)) {
      throw new Error("This Web Search provider does not support multiple API keys.");
    }
  };

  const writeIndex = (
    reference: WebSearchCredentialReference,
    document: WebSearchKeyPoolDocument,
    isCurrent: () => boolean,
  ) =>
    secrets.setProviderKey(
      webSearchKeyPoolIndexSecretId(reference.secretId),
      serializeWebSearchKeyPoolDocument(document),
      reference.binding,
      isCurrent,
    );

  const access: WebSearchCredentialAccess = {
    reference: webSearchCredentialReference,

    async read(reference) {
      if (!webSearchKeyPoolSupported(reference.providerId)) return readPrimary(reference);
      // A pool-capable provider's single-key view is its first existing key.
      await poolTail;
      const { keys } = await loadPool(reference);
      return keys[0]?.key ?? null;
    },

    async has(reference) {
      return (await access.read(reference)) !== null;
    },

    async set(reference, key, isCurrent = () => true) {
      const normalized = normalizeWebSearchCredential(key);
      if (!webSearchKeyPoolSupported(reference.providerId)) {
        await secrets.setProviderKey(reference.secretId, normalized, reference.binding, isCurrent);
        return;
      }
      await serializedPool(async () => {
        const { document } = await loadPool(reference);
        await secrets.setProviderKey(reference.secretId, normalized, reference.binding, isCurrent);
        if (document.entries.some((entry) => entry.id === WEB_SEARCH_KEY_POOL_PRIMARY_ENTRY_ID)) {
          return;
        }
        // Replacing through the single-key path re-adds the primary slot at
        // the front so it is used first, matching the pre-pool behavior.
        await writeIndex(
          reference,
          {
            ...document,
            entries: [
              { id: WEB_SEARCH_KEY_POOL_PRIMARY_ENTRY_ID, label: "Key 1", addedAt: now() },
              ...document.entries,
            ].slice(0, MAX_WEB_SEARCH_KEY_POOL_ENTRIES),
          },
          isCurrent,
        );
      });
    },

    async remove(reference, isCurrent = () => true) {
      const removeAll = async () => {
        if (webSearchKeyPoolSupported(reference.providerId)) {
          // Provider removal is an explicit request to erase every pooled slot.
          // Do not trust the index: it may be corrupt or may omit a slot left
          // by an interrupted add/remove mutation.
          await secrets.deleteKeyFamily(reference.secretId, isCurrent);
        } else {
          await secrets.deleteKey(reference.secretId, isCurrent);
        }
        // Removal is provider-scoped. Clear the old Exa slot too so a removed
        // credential cannot silently reappear through the compatibility path.
        if (reference.legacySecretId) await secrets.deleteKey(reference.legacySecretId, isCurrent);
      };
      if (webSearchKeyPoolSupported(reference.providerId)) await serializedPool(removeAll);
      else await removeAll();
    },

    async listPool(reference) {
      assertPool(reference);
      await poolTail;
      return (await loadPool(reference)).document;
    },

    async readPool(reference) {
      if (!webSearchKeyPoolSupported(reference.providerId)) {
        const key = await readPrimary(reference);
        return {
          strategy: "ordered",
          keys: key === null ? [] : [{ id: WEB_SEARCH_KEY_POOL_PRIMARY_ENTRY_ID, key }],
        };
      }
      await poolTail;
      const { document, keys } = await loadPool(reference);
      return { strategy: document.strategy, keys };
    },

    async addPoolKey(reference, key, label, isCurrent = () => true) {
      assertPool(reference);
      const normalized = normalizeWebSearchCredential(key);
      return serializedPool(async () => {
        const { document, keys } = await loadPool(reference);
        if (document.entries.length >= MAX_WEB_SEARCH_KEY_POOL_ENTRIES) {
          throw new Error(
            `A Web Search key pool holds at most ${MAX_WEB_SEARCH_KEY_POOL_ENTRIES} keys.`,
          );
        }
        if (keys.some((existing) => existing.key === normalized)) {
          throw new Error("This API key is already in the pool.");
        }
        // Use the pre-pool slot first so older single-key readers keep working.
        const primaryFree = !document.entries.some(
          (entry) => entry.id === WEB_SEARCH_KEY_POOL_PRIMARY_ENTRY_ID,
        );
        let entryId = primaryFree ? WEB_SEARCH_KEY_POOL_PRIMARY_ENTRY_ID : createEntryId();
        if (
          !isWebSearchKeyPoolEntryId(entryId) ||
          document.entries.some((entry) => entry.id === entryId)
        ) {
          entryId = defaultEntryId();
        }
        const next: WebSearchKeyPoolDocument = {
          ...document,
          entries: [
            ...document.entries,
            {
              id: entryId,
              label: normalizeWebSearchKeyPoolLabel(label, `Key ${document.entries.length + 1}`),
              addedAt: now(),
            },
          ],
        };
        await secrets.setProviderKey(
          webSearchKeyPoolEntrySecretId(reference.secretId, entryId),
          normalized,
          reference.binding,
          isCurrent,
        );
        await writeIndex(reference, next, isCurrent);
        return next;
      });
    },

    async removePoolKey(reference, entryId, isCurrent = () => true) {
      assertPool(reference);
      return serializedPool(async () => {
        const { document } = await loadPool(reference);
        if (
          !isWebSearchKeyPoolEntryId(entryId) ||
          !document.entries.some((entry) => entry.id === entryId)
        ) {
          throw new Error("That API key is no longer in the pool.");
        }
        const next: WebSearchKeyPoolDocument = {
          ...document,
          entries: document.entries.filter((entry) => entry.id !== entryId),
        };
        // Publish the smaller index before deleting the key so an interrupted
        // removal leaves an unreferenced secret, never a dangling entry.
        await writeIndex(reference, next, isCurrent);
        await secrets.deleteKey(
          webSearchKeyPoolEntrySecretId(reference.secretId, entryId),
          isCurrent,
        );
        if (entryId === WEB_SEARCH_KEY_POOL_PRIMARY_ENTRY_ID && reference.legacySecretId) {
          await secrets.deleteKey(reference.legacySecretId, isCurrent);
        }
        return next;
      });
    },

    async reorderPool(reference, orderedIds, isCurrent = () => true) {
      assertPool(reference);
      return serializedPool(async () => {
        const { document } = await loadPool(reference);
        const next: WebSearchKeyPoolDocument = {
          ...document,
          entries: reorderWebSearchKeyPoolEntries(document.entries, orderedIds),
        };
        await writeIndex(reference, next, isCurrent);
        return next;
      });
    },

    async setPoolStrategy(reference, strategy, isCurrent = () => true) {
      assertPool(reference);
      if (!isWebSearchKeyPoolStrategy(strategy)) {
        throw new Error("Unknown Web Search key rotation strategy.");
      }
      return serializedPool(async () => {
        const { document } = await loadPool(reference);
        const next: WebSearchKeyPoolDocument = { ...document, strategy };
        await writeIndex(reference, next, isCurrent);
        return next;
      });
    },
  };
  return access;
}
