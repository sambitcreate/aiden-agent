import type {
  ModelsStore,
  ModelsStoreEntry,
} from "@earendil-works/pi-ai";

import { DataStore } from "./data-store.js";
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
export const piModelsStore: ModelsStore = {
  async read(providerId) {
    if (!validProviderId(providerId)) throw new Error("Invalid provider model catalog identifier.");
    const document = await store.load();
    const entry = document.entries[providerId];
    return entry ? clone(entry) : undefined;
  },

  async write(providerId, entry) {
    if (!validProviderId(providerId)) throw new Error("Invalid provider model catalog identifier.");
    await store.update((document) => {
      document.version = 1;
      document.entries[providerId] = clone(entry);
    });
  },

  async delete(providerId) {
    if (!validProviderId(providerId)) throw new Error("Invalid provider model catalog identifier.");
    await store.update((document) => {
      delete document.entries[providerId];
    });
  },
};

export interface ProviderModelsStore {
  read(): Promise<ModelsStoreEntry | undefined>;
  write(entry: ModelsStoreEntry): Promise<void>;
  delete(): Promise<void>;
}

/** Provider-scoped view used for explicit single-provider refreshes on pinned Pi. */
export function piProviderModelsStore(providerId: string): ProviderModelsStore {
  return {
    read: () => piModelsStore.read(providerId),
    write: (entry) => piModelsStore.write(providerId, entry),
    delete: () => piModelsStore.delete(providerId),
  };
}
