import { logger } from "../platform.js";
import { configStore } from "./config-store.js";
import {
  credentialAfterProviderRotation,
  MAX_PROVIDER_CREDENTIAL_ROTATION_JOURNAL_LENGTH,
  normalizeProviderCredentialInput,
  parsePendingProviderCredentialRotation,
  providerCredentialState,
  providerConnectionSnapshot,
  serializePendingProviderCredentialRotation,
  type PendingProviderCredentialRotationV1,
} from "./provider-credential-rotation-core.js";
import { sameProviderConnection } from "./provider-key-policy.js";
import { secrets } from "./secrets.js";
import { mutatePortableConfigAndSync } from "./portable-credential-snapshot.js";
import type { StoredProvider } from "./types.js";

const JOURNAL_KEY = "__aiden_internal_provider_credential_rotation_v1__";
let rotationTail: Promise<void> = Promise.resolve();

function serialized<R>(operation: () => Promise<R>): Promise<R> {
  const result = rotationTail.then(operation, operation);
  rotationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function reconcilePendingProviderCredentialRotationNow(
  bindLegacy = true,
  reloadFromDisk = true,
): Promise<void> {
  const encoded = await secrets.getKeyStrict(JOURNAL_KEY);
  if (!encoded) {
    if (!bindLegacy) return;
    // There is no authoritative historical endpoint for pre-binding keys. A
    // portable config may have changed while Aiden was closed, so trusting the
    // current endpoint would risk sending an old key to a new host.
    for (const provider of await configStore.listProviders()) {
      await secrets.quarantineUnboundProviderKey(provider.id);
      await secrets.reconcileProviderKeyQuarantine(
        provider.id,
        JSON.stringify(providerConnectionSnapshot(provider)),
      );
    }
    return;
  }
  const pending = parsePendingProviderCredentialRotation(JSON.parse(encoded));
  const safe = reloadFromDisk
    ? await configStore.portableConfigSafeForCredentialReconciliation()
    : await configStore.cachedPortableConfigSafeForCredentialReconciliation();
  if (!safe) {
    throw new Error("Portable config is not safe for provider credential reconciliation.");
  }
  const current = await configStore.getProvider(pending.providerId);
  const resolution = credentialAfterProviderRotation(pending, current);
  if (!resolution.resolved) {
    throw new Error("Pending provider credential rotation no longer matches its provider.");
  }
  if (resolution.key) {
    if (!current) throw new Error("Cannot bind a provider key without its configuration.");
    await secrets.setProviderKey(
      pending.providerId,
      resolution.key,
      JSON.stringify(providerConnectionSnapshot(current)),
    );
  } else {
    await secrets.deleteKey(pending.providerId);
  }
  await secrets.deleteKey(JOURNAL_KEY);
}

export function reconcilePendingProviderCredentialRotation(): Promise<void> {
  return serialized(reconcilePendingProviderCredentialRotationNow);
}

export function saveProviderWithCredentialRotation(
  provider: StoredProvider,
  replacementKey: string | null,
  isCurrent: () => boolean = () => true,
): Promise<StoredProvider> {
  return mutatePortableConfigAndSync(() =>
    serialized(async () => {
      if (!isCurrent()) throw new Error("The renderer document is no longer active.");
      await reconcilePendingProviderCredentialRotationNow();
      const previous = await configStore.getProvider(provider.id);
      const connectionChanged = Boolean(previous && !sameProviderConnection(previous, provider));
      const hasStoredKey = await secrets.hasKey(provider.id);
      const { previousKey, mismatched } = providerCredentialState(
        hasStoredKey,
        previous
          ? await secrets.getProviderKey(
              provider.id,
              JSON.stringify(providerConnectionSnapshot(previous)),
            )
          : null,
      );
      const needsJournal =
        connectionChanged ||
        !provider.needsKey ||
        replacementKey !== null ||
        previousKey !== null ||
        mismatched;

      if (!needsJournal) {
        return configStore.saveProvider(provider, isCurrent);
      }

      const pending = parsePendingProviderCredentialRotation({
        version: 1,
        providerId: provider.id,
        previous: previous ? providerConnectionSnapshot(previous) : null,
        target: providerConnectionSnapshot(provider),
        previousKey,
        targetKey: provider.needsKey
          ? (replacementKey ?? (previous && !connectionChanged ? previousKey : null))
          : null,
      } satisfies PendingProviderCredentialRotationV1);
      await secrets.setInternalKey(
        JOURNAL_KEY,
        serializePendingProviderCredentialRotation(pending),
        MAX_PROVIDER_CREDENTIAL_ROTATION_JOURNAL_LENGTH,
        isCurrent,
      );
      if (connectionChanged || !provider.needsKey || !previous || mismatched) {
        await secrets.deleteKey(provider.id, isCurrent);
      }

      let saved: StoredProvider;
      try {
        saved = await configStore.saveProvider(provider, isCurrent);
      } catch (error) {
        // A failed file publication can have an indeterminate commit point. Keep
        // the encrypted journal intact; the next operation/startup reloads the
        // portable file from disk before choosing the authoritative endpoint.
        logger.warn(
          "providers",
          "Provider credential rotation remains pending after save failure.",
        );
        throw error;
      }
      await reconcilePendingProviderCredentialRotationNow();
      return saved;
    }),
  );
}

export function removeProviderWithCredentialCleanup(
  providerId: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  return mutatePortableConfigAndSync(() =>
    serialized(async () => {
      if (!isCurrent()) throw new Error("The renderer document is no longer active.");
      await reconcilePendingProviderCredentialRotationNow();
      const previous = await configStore.getProvider(providerId);
      const previousKey = previous
        ? await secrets.getProviderKey(
            providerId,
            JSON.stringify(providerConnectionSnapshot(previous)),
          )
        : null;
      const pending = parsePendingProviderCredentialRotation({
        version: 1,
        providerId,
        previous: previous ? providerConnectionSnapshot(previous) : null,
        target: null,
        previousKey,
        targetKey: null,
      } satisfies PendingProviderCredentialRotationV1);
      await secrets.setInternalKey(
        JOURNAL_KEY,
        serializePendingProviderCredentialRotation(pending),
        MAX_PROVIDER_CREDENTIAL_ROTATION_JOURNAL_LENGTH,
        isCurrent,
      );
      try {
        await configStore.removeProvider(providerId, isCurrent);
      } catch (error) {
        logger.warn(
          "providers",
          "Provider credential cleanup remains pending after remove failure.",
        );
        throw error;
      }
      await reconcilePendingProviderCredentialRotationNow();
    }),
  );
}

export function setProviderKeyWithCredentialRotation(
  providerId: string,
  key: string | null,
  isCurrent: () => boolean = () => true,
): Promise<{ hasKey: boolean; provider: StoredProvider }> {
  return serialized(async () => {
    if (!isCurrent()) throw new Error("The renderer document is no longer active.");
    await reconcilePendingProviderCredentialRotationNow();
    const provider = await configStore.getProvider(providerId);
    if (!provider) {
      throw new Error("This custom provider no longer exists.");
    }
    const boundedKey = normalizeProviderCredentialInput(key);
    if (!provider.needsKey || !boundedKey) {
      await secrets.deleteKey(providerId, isCurrent);
      return { hasKey: false, provider };
    }
    await secrets.setProviderKey(
      providerId,
      boundedKey,
      JSON.stringify(providerConnectionSnapshot(provider)),
      isCurrent,
    );
    return { hasKey: true, provider };
  });
}

export function reconcileExternalProviderCredentialChanges(
  previous: StoredProvider[],
  current: StoredProvider[],
): Promise<void> {
  return serialized(async () => {
    // The watcher already selected `current` from one authoritative reload.
    // Pending recovery must use that cached projection rather than consuming a
    // second disk edit behind the transition the watcher is about to commit.
    await reconcilePendingProviderCredentialRotationNow(false, false);
    const previousById = new Map(previous.map((provider) => [provider.id, provider]));
    const currentById = new Map(current.map((provider) => [provider.id, provider]));
    for (const providerId of new Set([...previousById.keys(), ...currentById.keys()])) {
      const before = previousById.get(providerId);
      const after = currentById.get(providerId);
      if (before && after && sameProviderConnection(before, after)) continue;
      // External config writes cannot participate in the encrypted-store queue.
      // Preserve the exact bound key in a bounded quarantine slot instead of
      // irreversibly deleting it from a potentially stale before/after pair.
      await secrets.reconcileProviderKeyQuarantine(
        providerId,
        after ? JSON.stringify(providerConnectionSnapshot(after)) : null,
      );
    }
  });
}
