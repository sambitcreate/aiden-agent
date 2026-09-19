import { isDeepStrictEqual } from "node:util";
import { createModels } from "@earendil-works/pi-ai";
import type {
  AuthContext,
  Credential,
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
  /** Pass the same context used to create models; omit only for Pi's default context. */
  authContext?: AuthContext;
  credentials: CredentialStore;
  providerModelsStore: (providerId: string) => ProviderModelsStore;
  providerIds?: readonly string[];
  force?: boolean;
  allowNetwork?: boolean;
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

const refreshAttempts = new WeakMap<Models, Map<string, AbortController>>();

function beginRefresh(models: Models, provider: Provider, signal?: AbortSignal) {
  let attempts = refreshAttempts.get(models);
  if (!attempts) {
    attempts = new Map();
    refreshAttempts.set(models, attempts);
  }
  attempts.get(provider.id)?.abort();
  const controller = new AbortController();
  attempts.set(provider.id, controller);
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    isCurrent: () => attempts.get(provider.id) === controller && models.getProvider(provider.id) === provider,
    abort: () => controller.abort(),
    finish: () => { if (attempts.get(provider.id) === controller) attempts.delete(provider.id); },
  };
}

function publicationOwnership(
  credentials: CredentialStore,
  providerId: string,
  snapshot: Credential | undefined,
  signal: AbortSignal,
  isCurrent: () => boolean,
) {
  return async () => {
    if (signal.aborted || !isCurrent()) return false;
    try {
      const current = await raceWithAbort(credentials.read(providerId, { signal }), signal);
      return !signal.aborted && isCurrent() && isDeepStrictEqual(snapshot, current);
    } catch (error) {
      if (signal.aborted) return false;
      throw error;
    }
  };
}

/**
 * Keep Pi's exact full-refresh OAuth/ambient-auth behavior in a per-call SDK
 * collection. Observe its credential reads and committed refreshes, then route
 * provider publications through Aiden's shared ownership queue. Custom-context
 * callers supply the same AuthContext used to create their source collection;
 * Pi has no public context getter. The production registry uses Pi's default.
 * Provider state stays on the original provider objects; no catalog is copied.
 */
async function refreshNativeCatalogs(options: RefreshPiCatalogsOptions): Promise<RefreshPiCatalogsResult> {
  const { models, authContext, credentials, providerModelsStore, providerIds, signal, force = true, allowNetwork = true } = options;
  const snapshots = new Map<string, Credential | undefined>();
  const observedCredentials: CredentialStore = {
    read: async (id, authOptions) => {
      const credential = await credentials.read(id, authOptions);
      snapshots.set(id, structuredClone(credential));
      return credential;
    },
    modify: async (id, modify, authOptions) => {
      const credential = await credentials.modify(id, modify, authOptions);
      snapshots.set(id, structuredClone(credential));
      return credential;
    },
    list: (authOptions) => credentials.list(authOptions),
    delete: (id, authOptions) => credentials.delete(id, authOptions),
  };
  const native = createModels({
    authContext,
    credentials: observedCredentials,
    modelsStore: {
      read: (id) => providerModelsStore(id).read(),
      write: (id, entry) => providerModelsStore(id).write(entry),
      delete: (id) => providerModelsStore(id).delete(),
    },
  });
  const attempts: { providerId: string; attempt: ReturnType<typeof beginRefresh> }[] = [];
  for (const provider of models.getProviders()) {
    if (!provider.refreshModels || (providerIds && !providerIds.includes(provider.id))) continue;
    const attempt = beginRefresh(models, provider, signal);
    attempts.push({ providerId: provider.id, attempt });
    native.setProvider({
      ...provider,
      refreshModels: async (context) => {
        const effectiveSignal = AbortSignal.any([context.signal, attempt.signal]);
        const isCurrent = () => !effectiveSignal.aborted && attempt.isCurrent();
        const canPublish = publicationOwnership(
          credentials, provider.id, snapshots.get(provider.id), effectiveSignal, isCurrent,
        );
        // A missing snapshot means Pi's initial credential read failed. Pi
        // rethrows that saved auth error after the offline phase; aborting here
        // would suppress it as cancellation. Unknown ownership cannot hydrate.
        if (!snapshots.has(provider.id)) return;
        if (!await canPublish() || !isCurrent()) {
          attempt.abort();
          return;
        }
        await provider.refreshModels!({
          ...context,
          signal: effectiveSignal,
          publish: (publication) => providerModelsStore(provider.id).publish(publication, canPublish, isCurrent),
        });
      },
    });
  }
  const results = await Promise.all(attempts.map(async ({ providerId, attempt }) => {
    try {
      return await native.refresh({ providers: [providerId], force, allowNetwork, signal: attempt.signal });
    } finally {
      attempt.finish();
    }
  }));
  return {
    aborted: signal?.aborted ?? false,
    errors: new Map(results.flatMap((result) => [...result.errors])),
  };
}

/** Scoped setup checks auth without rotation; full/manual refresh retains Pi OAuth resolution. */
export async function refreshPiCatalogs({
  models,
  authContext,
  credentials,
  providerModelsStore,
  providerIds,
  force = true,
  allowNetwork = true,
  signal,
}: RefreshPiCatalogsOptions): Promise<RefreshPiCatalogsResult> {
  if (signal?.aborted) return { aborted: true, errors: new Map() };
  if (providerIds === undefined || !allowNetwork) {
    return refreshNativeCatalogs({ models, authContext, credentials, providerModelsStore, providerIds, force, allowNetwork, signal });
  }

  const errors = new Map<string, Error>();
  await Promise.all(
    [...new Set(providerIds)].map(async (providerId) => {
      const provider = models.getProvider(providerId);
      if (!provider?.refreshModels) return;
      const attempt = beginRefresh(models, provider, signal);
      const effectiveSignal = attempt.signal;
      try {
        const store = providerModelsStore(providerId);
        if (!force && isPiRemoteCatalogProvider(provider)) {
          const entry = await raceWithAbort(store.read(), effectiveSignal);
          if (isPiRemoteCatalogCacheFresh(provider, entry)) return;
        }
        // checkAuth is explicitly non-refreshing for OAuth. Catalog refresh
        // must never outlive its timeout while secretly rotating credentials.
        const auth = await raceWithAbort(models.checkAuth(providerId, { signal: effectiveSignal }), effectiveSignal);
        if (!auth || effectiveSignal.aborted) return;
        const credential = await raceWithAbort(credentials.read(providerId, { signal: effectiveSignal }), effectiveSignal);
        const stored = await raceWithAbort(store.read(), effectiveSignal);
        const isCurrent = () => !effectiveSignal.aborted && attempt.isCurrent();
        const canPublish = publicationOwnership(credentials, providerId, credential, effectiveSignal, isCurrent);
        if (!await canPublish() || !isCurrent()) return;
        await raceWithAbort(provider.refreshModels({
          credential,
          stored,
          publish: (publication) => store.publish(publication, canPublish, isCurrent),
          allowNetwork: true,
          force,
          signal: effectiveSignal,
        }), effectiveSignal);
      } catch (error) {
        errors.set(
          providerId,
          error instanceof Error ? error : new Error("Unknown model catalog refresh error."),
        );
      } finally {
        attempt.finish();
      }
    }),
  );
  return { aborted: signal?.aborted ?? false, errors };
}
