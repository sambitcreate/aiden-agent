import type {
  ModelsPublication,
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
} from "@earendil-works/pi-ai";

import { DataStore, type DataStorePublicationReceipt } from "./data-store.js";
import { parsePiRemoteCatalog } from "./pi-remote-catalog.js";

const MAX_STORE_BYTES = 32 * 1024 * 1024;
const MAX_STORED_PROVIDERS = 256;

interface PersistedModelsStoreEntry extends ModelsStoreEntry {
  lastModified?: number;
  etag?: string;
}

interface PiModelsDocument {
  version: 1;
  entries: Record<string, PersistedModelsStoreEntry>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validProviderId(providerId: string): boolean {
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(providerId);
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function normalizePiModelsDocument(value: unknown): PiModelsDocument {
  const document = object(value);
  const source = object(document?.entries) ?? {};
  const entries: Record<string, PersistedModelsStoreEntry> = {};
  for (const [providerId, rawEntry] of Object.entries(source).slice(0, MAX_STORED_PROVIDERS)) {
    if (!validProviderId(providerId)) continue;
    const entry = object(rawEntry);
    if (!entry || !Array.isArray(entry.models)) continue;
    let models;
    try {
      models = parsePiRemoteCatalog(providerId, entry.models, { allowEmptyBaseUrl: true });
    } catch {
      continue;
    }
    const checkedAt = timestamp(entry.checkedAt);
    const lastModified = timestamp(entry.lastModified);
    const etag =
      typeof entry.etag === "string" && entry.etag.length <= 512 && !/[\r\n]/u.test(entry.etag)
        ? entry.etag
        : undefined;
    entries[providerId] = {
      models,
      ...(checkedAt === undefined ? {} : { checkedAt }),
      ...(lastModified === undefined ? {} : { lastModified }),
      ...(etag === undefined ? {} : { etag }),
    };
  }
  return { version: 1, entries };
}

function safePiModelsDocument(value: unknown): boolean {
  try {
    return JSON.stringify(value) === JSON.stringify(normalizePiModelsDocument(value));
  } catch {
    return false;
  }
}

const store = new DataStore<PiModelsDocument>(
  "pi-provider-models.json",
  { version: 1, entries: {} },
  undefined,
  {
    maxBytes: MAX_STORE_BYTES,
    fileMode: 0o600,
    normalize: normalizePiModelsDocument,
    isSafe: safePiModelsDocument,
  },
);

function clone(entry: ModelsStoreEntry): ModelsStoreEntry {
  return structuredClone(entry);
}

/**
 * Device-local, non-secret cache for Pi dynamic catalogs. Pi owns validation
 * and retry behavior; this store only gives it durable last-known snapshots.
 */
interface CatalogBackingStore extends ModelsStore {
  write(id: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions, receipt?: DataStorePublicationReceipt): Promise<void>;
  delete(id: string, options?: ModelsStoreOperationOptions, receipt?: DataStorePublicationReceipt): Promise<void>;
}

export function createPiModelsBackingStore(store: DataStore<PiModelsDocument>): CatalogBackingStore {
  return {
    async read(providerId) {
      if (!validProviderId(providerId)) throw new Error("Invalid provider model catalog identifier.");
      const document = await store.load();
      const entry = document.entries[providerId];
      return entry ? clone(entry) : undefined;
    },

    async write(providerId, entry, _options, receipt) {
      if (receipt) receipt.state = "not-published";
      if (!validProviderId(providerId)) throw new Error("Invalid provider model catalog identifier.");
      await store.update((document) => {
        document.version = 1;
        document.entries[providerId] = clone(entry);
      }, undefined, receipt);
    },

    async delete(providerId, _options, receipt) {
      if (receipt) receipt.state = "not-published";
      if (!validProviderId(providerId)) throw new Error("Invalid provider model catalog identifier.");
      await store.update((document) => {
        delete document.entries[providerId];
      }, undefined, receipt);
    },
  };
}

export interface ProviderModelsStore {
  read(): Promise<ModelsStoreEntry | undefined>;
  write(entry: ModelsStoreEntry): Promise<void>;
  delete(): Promise<void>;
  /** Keep persistence, ownership validation, and any retirement in one queue slot. */
  publish(
    publication: ModelsPublication,
    canPublish: () => Promise<boolean>,
    isCurrent: () => boolean,
  ): Promise<boolean>;
}

class CatalogPublicationError extends Error {
  readonly cause: unknown;

  constructor(message: string, readonly errors: readonly unknown[]) {
    super(message);
    this.name = "CatalogPublicationError";
    this.cause = errors[0];
  }
}

/**
 * Every reader/writer, including native Pi refresh and offline hydration, shares
 * the publication queue. Rejected writes are retired, or reads quarantined if
 * cleanup fails, before another publisher can write. Cleanup cannot erase a
 * newer catalog (even identical bytes).
 */
export function createOwnedPiModelsStore(backing: CatalogBackingStore): {
  modelsStore: ModelsStore;
  providerStore: (providerId: string) => ProviderModelsStore;
} {
  const tails = new Map<string, Promise<void>>();
  const quarantined = new Set<string>();
  const retire = async (providerId: string) => {
    quarantined.add(providerId);
    try {
      await backing.delete(providerId);
    } catch (deleteError) {
      try {
        // A failed delete may have committed, or may have left the old entry.
        // An empty replacement is safe for both Pi hydration and our overlays.
        await backing.write(providerId, { models: [] });
      } catch (fallbackError) {
        throw new CatalogPublicationError("Could not retire an obsolete model catalog.", [deleteError, fallbackError]);
      }
    }
    quarantined.delete(providerId);
  };
  const serialized = <T>(providerId: string, action: () => Promise<T>): Promise<T> => {
    const previous = tails.get(providerId) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(providerId, tail);
    void tail.then(() => { if (tails.get(providerId) === tail) tails.delete(providerId); });
    return result;
  };
  const modelsStore: ModelsStore = {
    read: (id, options) => serialized(id, async () => {
      options?.signal?.throwIfAborted();
      return quarantined.has(id) ? undefined : backing.read(id, options);
    }),
    write: (id, entry, options) => {
      const snapshot = clone(entry);
      return serialized(id, async () => {
        options?.signal?.throwIfAborted();
        await backing.write(id, snapshot, options);
        quarantined.delete(id);
      });
    },
    delete: (id, options) => serialized(id, async () => {
      options?.signal?.throwIfAborted();
      await backing.delete(id, options);
      quarantined.delete(id);
    }),
  };
  return {
    modelsStore,
    providerStore: (providerId) => ({
      read: () => modelsStore.read(providerId),
      write: (entry) => modelsStore.write(providerId, entry),
      delete: () => modelsStore.delete(providerId),
      publish: (publication, canPublish, isCurrent) => serialized(providerId, async () => {
        if (!isCurrent() || !await canPublish() || !isCurrent()) return false;
        // Cloning is synchronous and cannot have published anything.
        const snapshot = publication.persist == null ? publication.persist : clone(publication.persist);
        let accepted = false;
        let failed = false;
        let failure: unknown;
        // Generic stores cannot prove non-commit. The DataStore adapter records
        // the exact pre-publication/entered-publication boundary for each call.
        const receipt: DataStorePublicationReceipt = { state: "uncertain" };
        try {
          if (snapshot === null) await backing.delete(providerId, undefined, receipt);
          else if (snapshot !== undefined) await backing.write(providerId, snapshot, undefined, receipt);
          accepted = isCurrent() && await canPublish() && isCurrent();
        } catch (error) {
          // A rejected write may already have replaced the file. Keep ownership
          // until that uncertain entry is retired, including on IO rejection.
          failed = true;
          failure = error;
        }
        let preservePrevious = false;
        if (failed && receipt.state === "not-published") {
          try {
            preservePrevious = isCurrent() && await canPublish() && isCurrent();
          } catch {
            // Without current ownership evidence, retain the fail-closed path.
          }
        }
        if (!accepted && !preservePrevious && publication.persist !== undefined) {
          try {
            await retire(providerId);
          } catch (cleanupError) {
            if (failed) throw new CatalogPublicationError("Catalog publication and retirement failed.", [failure, cleanupError]);
            throw cleanupError;
          }
        }
        if (failed) throw failure;
        if (!accepted) return false;
        if (publication.persist !== undefined) quarantined.delete(providerId);
        publication.update?.();
        return true;
      }),
    }),
  };
}

const ownedStore = createOwnedPiModelsStore(createPiModelsBackingStore(store));
export const piModelsStore = ownedStore.modelsStore;
export const piProviderModelsStore = ownedStore.providerStore;
