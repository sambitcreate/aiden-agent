// Encrypted per-provider API key storage using the OS keychain via safeStorage.
// Keys are stored as base64-encoded ciphertext and are NEVER returned to the renderer.

import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { app, logger } from "../platform.js";
import { secureStorage } from "./secure-storage.js";
import {
  bindSecretEntryIfUnbound,
  deleteSecretKeyEntry,
  moveSecretEntryPairIfVacant,
  moveSecretEntryWithBindingIfVacant,
  parseSecretKeyMap,
  secretKeyEntry,
  setSecretKeyEntry,
  swapSecretEntryPairs,
  type SecretKeyMap,
} from "./secret-map-core.js";
import { readRegularUtf8File } from "./regular-file-read.js";
import { MAX_PROVIDER_KEY_LENGTH } from "./types.js";
import { assertProviderCredentialLength } from "./provider-credential-rotation-core.js";
import { invalidateBotRuntimeInventoryAuthority } from "./bot-runtime-inventory-lease.js";

const FILE = "provider-keys.json";
const PROVIDER_BINDING_PREFIX = "__aiden_internal_provider_binding_v1__:";
const PROVIDER_QUARANTINE_KEY_PREFIX = "__aiden_internal_provider_quarantine_key_v1__:";
const PROVIDER_QUARANTINE_BINDING_PREFIX = "__aiden_internal_provider_quarantine_binding_v1__:";
const PROVIDER_LEGACY_QUARANTINE_KEY_PREFIX =
  "__aiden_internal_provider_legacy_quarantine_key_v1__:";
const PROVIDER_LEGACY_QUARANTINE_BINDING_PREFIX =
  "__aiden_internal_provider_legacy_quarantine_binding_v1__:";
const LEGACY_UNBOUND_PROVIDER_BINDING = "__aiden_legacy_unbound_provider_key_v1__";

type KeyMap = SecretKeyMap; // providerId -> base64 ciphertext
type MutationGuard = () => boolean;
let mutationTail: Promise<void> = Promise.resolve();

function assertMutationCurrent(isCurrent: MutationGuard): void {
  if (!isCurrent()) throw new Error("The renderer document is no longer active.");
}

async function filePath(): Promise<string> {
  const userDataPath = app.getPath("userData");
  await fs.mkdir(userDataPath, { recursive: true });
  return path.join(userDataPath, FILE);
}

async function readMap(): Promise<KeyMap> {
  try {
    const data = await readRegularUtf8File(await filePath());
    return parseSecretKeyMap(JSON.parse(data));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeMap(map: KeyMap, isCurrent: MutationGuard = () => true): Promise<void> {
  const destination = await filePath();
  const staged = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(staged, JSON.stringify(map, null, 2), { encoding: "utf-8", mode: 0o600 });
    const stagedHandle = await fs.open(staged, "r");
    try {
      await stagedHandle.sync();
    } finally {
      await stagedHandle.close();
    }
    assertMutationCurrent(isCurrent);
    invalidateBotRuntimeInventoryAuthority("provider_credential");
    await fs.rename(staged, destination);
    invalidateBotRuntimeInventoryAuthority("provider_credential");
    const directoryHandle = await fs.open(path.dirname(destination), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await fs.rm(staged, { force: true }).catch(() => undefined);
  }
}

function serialized<R>(operation: () => Promise<R>): Promise<R> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function getKeyStrict(providerId: string): Promise<string | null> {
  await mutationTail;
  const b64 = secretKeyEntry(await readMap(), providerId);
  if (!b64) return null;
  return secureStorage.decryptString(Buffer.from(b64, "base64"));
}

async function encryptValue(value: string): Promise<string> {
  const encrypted = await secureStorage.encryptString(value);
  return Buffer.from(encrypted).toString("base64");
}

async function decryptedEntry(map: KeyMap, id: string): Promise<string | null> {
  const b64 = secretKeyEntry(map, id);
  return b64 ? secureStorage.decryptString(Buffer.from(b64, "base64")) : null;
}

function setKeyWithBound(
  providerId: string,
  key: string,
  maxLength: number,
  isCurrent: MutationGuard,
): Promise<void> {
  return serialized(async () => {
    assertMutationCurrent(isCurrent);
    if (key.length > maxLength) {
      throw new Error(`Encrypted values cannot exceed ${maxLength} characters.`);
    }
    if (!secureStorage.isEncryptionAvailable()) {
      throw new Error(`${secureStorage.unavailableMessage()} Cannot save the API key.`);
    }
    const map = await readMap();
    assertMutationCurrent(isCurrent);
    const encrypted = await secureStorage.encryptString(key);
    assertMutationCurrent(isCurrent);
    setSecretKeyEntry(map, providerId, Buffer.from(encrypted).toString("base64"));
    await writeMap(map, isCurrent);
  });
}

export const secrets = {
  async setKey(
    providerId: string,
    key: string,
    isCurrent: MutationGuard = () => true,
  ): Promise<void> {
    return setKeyWithBound(providerId, key, MAX_PROVIDER_KEY_LENGTH, isCurrent);
  },

  /** Internal durable records have their own validated whole-record bounds. */
  async setInternalKey(
    providerId: string,
    value: string,
    maxLength: number,
    isCurrent: MutationGuard = () => true,
  ): Promise<void> {
    return setKeyWithBound(providerId, value, maxLength, isCurrent);
  },

  async getKey(providerId: string): Promise<string | null> {
    try {
      return await getKeyStrict(providerId);
    } catch (error) {
      logger.error("secrets", `Could not read key for provider ${providerId}`, error);
      return null;
    }
  },

  /** Internal transaction reads must distinguish absent keys from unreadable storage. */
  getKeyStrict,

  async getProviderKey(providerId: string, binding: string): Promise<string | null> {
    try {
      await mutationTail;
      const map = await readMap();
      const storedBinding = await decryptedEntry(map, `${PROVIDER_BINDING_PREFIX}${providerId}`);
      if (storedBinding !== binding) return null;
      return decryptedEntry(map, providerId);
    } catch (error) {
      logger.error("secrets", `Could not read bound key for provider ${providerId}`, error);
      return null;
    }
  },

  /**
   * Adopt a pre-binding credential only after the caller has independently
   * constrained the endpoint it may reach. This is used for built-in MCP
   * presets whose official HTTPS origin is validated before this call.
   */
  async getOrBindLegacyProviderKey(providerId: string, binding: string): Promise<string | null> {
    try {
      return await serialized(async () => {
        const map = await readMap();
        const bindingId = `${PROVIDER_BINDING_PREFIX}${providerId}`;
        if (Object.prototype.hasOwnProperty.call(map, bindingId)) {
          return (await decryptedEntry(map, bindingId)) === binding
            ? decryptedEntry(map, providerId)
            : null;
        }
        const key = await decryptedEntry(map, providerId);
        if (key === null) return null;
        assertProviderCredentialLength(key);
        if (!bindSecretEntryIfUnbound(map, providerId, bindingId, await encryptValue(binding))) {
          return null;
        }
        await writeMap(map);
        return key;
      });
    } catch (error) {
      logger.error("secrets", `Could not migrate legacy key for provider ${providerId}`, error);
      return null;
    }
  },

  async setProviderKey(
    providerId: string,
    key: string,
    binding: string,
    isCurrent: MutationGuard = () => true,
  ): Promise<void> {
    return serialized(async () => {
      assertMutationCurrent(isCurrent);
      assertProviderCredentialLength(key);
      if (!secureStorage.isEncryptionAvailable()) {
        throw new Error(`${secureStorage.unavailableMessage()} Cannot save the API key.`);
      }
      const map = await readMap();
      assertMutationCurrent(isCurrent);
      const [encryptedKey, encryptedBinding] = await Promise.all([
        encryptValue(key),
        encryptValue(binding),
      ]);
      assertMutationCurrent(isCurrent);
      setSecretKeyEntry(map, providerId, encryptedKey);
      setSecretKeyEntry(map, `${PROVIDER_BINDING_PREFIX}${providerId}`, encryptedBinding);
      await writeMap(map, isCurrent);
    });
  },

  /**
   * Preflight every alias-derived provider key, then move and bind the complete
   * unambiguous set in one durable publication. Converging, future-shaped, or
   * conflicting records leave the entire map untouched.
   */
  async migrateProviderKeysWithBindings(
    migrations: ReadonlyArray<{
      legacyProviderId: string;
      providerId: string;
      binding: string;
    }>,
  ): Promise<boolean> {
    return serialized(async () => {
      const map = await readMap();
      const sourceTargets = new Map<string, string>();
      const byTarget = new Map<
        string,
        {
          binding: string;
          sources: string[];
        }
      >();
      for (const migration of migrations) {
        const existingTarget = sourceTargets.get(migration.legacyProviderId);
        if (existingTarget && existingTarget !== migration.providerId) return false;
        sourceTargets.set(migration.legacyProviderId, migration.providerId);
        const target = byTarget.get(migration.providerId);
        if (target && target.binding !== migration.binding) return false;
        if (target) target.sources.push(migration.legacyProviderId);
        else {
          byTarget.set(migration.providerId, {
            binding: migration.binding,
            sources: [migration.legacyProviderId],
          });
        }
      }

      const pending: Array<{
        source: string;
        providerId: string;
        bindingId: string;
        binding: string;
      }> = [];
      for (const [providerId, target] of byTarget) {
        const bindingId = `${PROVIDER_BINDING_PREFIX}${providerId}`;
        const presentSources = target.sources.filter((source) =>
          Object.prototype.hasOwnProperty.call(map, source),
        );
        if (presentSources.length > 1) return false;
        if (presentSources.length === 1) {
          const [source] = presentSources;
          if (
            secretKeyEntry(map, source) === undefined ||
            Object.prototype.hasOwnProperty.call(map, providerId) ||
            Object.prototype.hasOwnProperty.call(map, bindingId)
          ) {
            return false;
          }
          pending.push({ source, providerId, bindingId, binding: target.binding });
          continue;
        }

        const hasProvider = Object.prototype.hasOwnProperty.call(map, providerId);
        const hasBinding = Object.prototype.hasOwnProperty.call(map, bindingId);
        if (!hasProvider && !hasBinding) continue;
        if (
          secretKeyEntry(map, providerId) === undefined ||
          secretKeyEntry(map, bindingId) === undefined
        ) {
          return false;
        }
        if ((await decryptedEntry(map, bindingId)) !== target.binding) return false;
      }

      for (const migration of pending) {
        const encryptedBinding = await encryptValue(migration.binding);
        if (
          !moveSecretEntryWithBindingIfVacant(
            map,
            migration.source,
            { valueId: migration.providerId, bindingId: migration.bindingId },
            encryptedBinding,
          )
        ) {
          throw new Error("Provider credential aliases changed after migration preflight.");
        }
      }
      if (pending.length > 0) await writeMap(map);
      return true;
    });
  },

  async quarantineUnboundProviderKey(providerId: string): Promise<void> {
    return serialized(async () => {
      const map = await readMap();
      if (!secretKeyEntry(map, providerId)) return;
      const bindingId = `${PROVIDER_BINDING_PREFIX}${providerId}`;
      // A known string binding belongs to this version. An unknown structured
      // binding belongs to a future version and must remain untouched; runtime
      // reads already fail closed because it is not a string.
      if (Object.prototype.hasOwnProperty.call(map, bindingId)) return;
      const quarantine = {
        valueId: `${PROVIDER_LEGACY_QUARANTINE_KEY_PREFIX}${providerId}`,
        bindingId: `${PROVIDER_LEGACY_QUARANTINE_BINDING_PREFIX}${providerId}`,
      };
      const encryptedLegacyBinding = await encryptValue(LEGACY_UNBOUND_PROVIDER_BINDING);
      if (
        !moveSecretEntryWithBindingIfVacant(map, providerId, quarantine, encryptedLegacyBinding)
      ) {
        throw new Error(
          "A legacy provider key could not be quarantined without overwriting recovery data.",
        );
      }
      await writeMap(map);
    });
  },

  /**
   * Keep externally rotated keys endpoint-bound and recoverable. A matching
   * quarantined key is swapped back into the active slot; otherwise the active
   * pair moves aside only when the bounded quarantine slot is vacant.
   */
  async reconcileProviderKeyQuarantine(
    providerId: string,
    desiredBinding: string | null,
  ): Promise<void> {
    return serialized(async () => {
      const map = await readMap();
      const active = {
        valueId: providerId,
        bindingId: `${PROVIDER_BINDING_PREFIX}${providerId}`,
      };
      const quarantine = {
        valueId: `${PROVIDER_QUARANTINE_KEY_PREFIX}${providerId}`,
        bindingId: `${PROVIDER_QUARANTINE_BINDING_PREFIX}${providerId}`,
      };
      const [activeBinding, quarantinedBinding] = await Promise.all([
        decryptedEntry(map, active.bindingId),
        decryptedEntry(map, quarantine.bindingId),
      ]);
      if (desiredBinding !== null && activeBinding === desiredBinding) return;

      const changed =
        desiredBinding !== null && quarantinedBinding === desiredBinding
          ? swapSecretEntryPairs(map, active, quarantine)
          : moveSecretEntryPairIfVacant(map, active, quarantine);
      if (changed) await writeMap(map);
    });
  },

  async hasKey(providerId: string): Promise<boolean> {
    await mutationTail;
    try {
      return Boolean(secretKeyEntry(await readMap(), providerId));
    } catch (error) {
      logger.error("secrets", "Could not read the encrypted provider key store.", error);
      return false;
    }
  },

  async deleteKey(providerId: string, isCurrent: MutationGuard = () => true): Promise<void> {
    return serialized(async () => {
      assertMutationCurrent(isCurrent);
      const map = await readMap();
      assertMutationCurrent(isCurrent);
      const removedKey = deleteSecretKeyEntry(map, providerId);
      const removedBinding = deleteSecretKeyEntry(map, `${PROVIDER_BINDING_PREFIX}${providerId}`);
      const changed = removedKey || removedBinding;
      if (changed) {
        await writeMap(map, isCurrent);
      }
    });
  },

  async clearAll(isCurrent: MutationGuard = () => true): Promise<void> {
    return serialized(async () => {
      assertMutationCurrent(isCurrent);
      await writeMap({}, isCurrent);
    });
  },

  async migrateKeys(migrate: (map: KeyMap) => boolean): Promise<void> {
    return serialized(async () => {
      const map = await readMap();
      if (migrate(map)) await writeMap(map);
    });
  },
};
