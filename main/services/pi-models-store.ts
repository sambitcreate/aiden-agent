import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";

import { DataStore } from "./data-store.js";

interface PiModelsDocument {
  version: 1;
  entries: Record<string, ModelsStoreEntry>;
}

const store = new DataStore<PiModelsDocument>("pi-provider-models.json", {
  version: 1,
  entries: {},
});

function validProviderId(providerId: string): boolean {
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(providerId);
}

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
