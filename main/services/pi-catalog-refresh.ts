import type {
  CredentialStore,
  Models,
  Provider,
} from "@earendil-works/pi-ai";
import type { ProviderModelsStore } from "./pi-models-store.js";
import {
  isPiRemoteCatalogCacheFresh,
  isPiRemoteCatalogProvider,
} from "./pi-remote-catalog.js";

export interface RefreshPiCatalogsOptions {
  models: Models;
  credentials: CredentialStore;
  providerModelsStore: (providerId: string) => ProviderModelsStore;
  providerIds?: readonly string[];
  force?: boolean;
  signal?: AbortSignal;
}

export interface RefreshPiCatalogsResult {
  aborted: boolean;
  errors: ReadonlyMap<string, Error>;
}

export interface ProjectedPiCatalogRefreshError {
  providerId: string;
  message: string;
}

export function projectPiCatalogRefreshErrors(
  errors: ReadonlyMap<string, Error>,
): ProjectedPiCatalogRefreshError[] {
  return [...errors.keys()].slice(0, 32).map((providerId) => ({
    providerId: providerId.replace(/[^a-zA-Z0-9._:-]/gu, "").slice(0, 128) || "provider",
    // Never project upstream bodies or nested authentication failures across IPC.
    message: "Catalog refresh failed. Cached models were kept.",
  }));
}

/** Return only stale Aiden pi.dev overlays; provider-owned catalogs keep their own refresh policy. */
export async function staleCatalogProviderIds(
  providers: readonly Provider[],
  providerModelsStore: (providerId: string) => ProviderModelsStore,
): Promise<string[]> {
  const results = await Promise.all(providers.map(async (provider) => {
    if (!provider.refreshModels || !isPiRemoteCatalogProvider(provider)) return undefined;
    try {
      const entry = await providerModelsStore(provider.id).read();
      return isPiRemoteCatalogCacheFresh(provider, entry) ? undefined : provider.id;
    } catch {
      return provider.id;
    }
  }));
  return results.filter((providerId): providerId is string => providerId !== undefined);
}

function abortError(): Error {
  const error = new Error("Model catalog refresh was cancelled.");
  error.name = "AbortError";
  return error;
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * Backports provider-scoped catalog refresh to Aiden's pinned Pi runtime.
 * Pi 0.80 refreshes every dynamic provider; setup needs isolation so one
 * unrelated provider cannot make a newly configured provider appear broken.
 */
export async function refreshPiCatalogs({
  models,
  credentials,
  providerModelsStore,
  providerIds,
  force = true,
  signal,
}: RefreshPiCatalogsOptions): Promise<RefreshPiCatalogsResult> {
  if (providerIds === undefined) {
    const task = models.refresh({ force, signal });
    try {
      return await raceWithAbort(task, signal);
    } catch (error) {
      if (signal?.aborted) return { aborted: true, errors: new Map() };
      throw error;
    }
  }

  const errors = new Map<string, Error>();
  await Promise.all(
    [...new Set(providerIds)].map(async (providerId) => {
      const provider = models.getProvider(providerId);
      if (!provider?.refreshModels) return;
      try {
        const store = providerModelsStore(providerId);
        if (!force && isPiRemoteCatalogProvider(provider)) {
          const entry = await raceWithAbort(store.read(), signal);
          if (isPiRemoteCatalogCacheFresh(provider, entry)) return;
        }
        // checkAuth is explicitly non-refreshing for OAuth. Catalog refresh
        // must never outlive its timeout while secretly rotating credentials.
        const auth = await raceWithAbort(models.checkAuth(providerId), signal);
        if (!auth || signal?.aborted) return;
        const credential = await raceWithAbort(credentials.read(providerId), signal);
        const stored = await raceWithAbort(store.read(), signal);
        const effectiveSignal = signal ?? new AbortController().signal;
        await raceWithAbort(provider.refreshModels({
          credential,
          stored,
          publish: async (publication) => {
            if (publication.persist === null) await store.delete();
            else if (publication.persist !== undefined) await store.write(publication.persist);
            publication.update?.();
            return true;
          },
          allowNetwork: true,
          force,
          signal: effectiveSignal,
        }), signal);
      } catch (error) {
        errors.set(
          providerId,
          error instanceof Error ? error : new Error("Unknown model catalog refresh error."),
        );
      }
    }),
  );
  return { aborted: signal?.aborted ?? false, errors };
}
