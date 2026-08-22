import { sameProviderConnection, type ProviderConnection } from "./provider-key-policy.js";
import {
  MAX_CONFIG_ID_LENGTH,
  MAX_PROVIDER_BASE_URL_LENGTH,
  MAX_PROVIDER_KEY_LENGTH,
} from "./types.js";

export interface PendingProviderCredentialRotationV1 {
  version: 1;
  providerId: string;
  previous: ProviderConnection | null;
  target: ProviderConnection | null;
  previousKey: string | null;
  targetKey: string | null;
}

export const MAX_PROVIDER_CREDENTIAL_ROTATION_JOURNAL_LENGTH =
  MAX_PROVIDER_KEY_LENGTH * 2 +
  MAX_PROVIDER_BASE_URL_LENGTH * 2 +
  MAX_CONFIG_ID_LENGTH * 3 +
  64 * 2 +
  1_024;

function isConnection(value: unknown): value is ProviderConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    record.id.length <= MAX_CONFIG_ID_LENGTH &&
    typeof record.kind === "string" &&
    record.kind.length > 0 &&
    record.kind.length <= 64 &&
    typeof record.baseUrl === "string" &&
    record.baseUrl.length > 0 &&
    record.baseUrl.length <= MAX_PROVIDER_BASE_URL_LENGTH &&
    typeof record.needsKey === "boolean"
  );
}

export function providerConnectionSnapshot(provider: ProviderConnection): ProviderConnection {
  return {
    id: provider.id,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    needsKey: provider.needsKey,
  };
}

export function parsePendingProviderCredentialRotation(
  value: unknown,
): PendingProviderCredentialRotationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid pending provider credential rotation.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.providerId !== "string" ||
    record.providerId.length === 0 ||
    record.providerId.length > MAX_CONFIG_ID_LENGTH ||
    (record.target !== null &&
      (!isConnection(record.target) || record.target.id !== record.providerId)) ||
    (record.previous !== null &&
      (!isConnection(record.previous) || record.previous.id !== record.providerId)) ||
    (record.previousKey !== null && typeof record.previousKey !== "string") ||
    (record.targetKey !== null && typeof record.targetKey !== "string") ||
    (typeof record.previousKey === "string" &&
      record.previousKey.length > MAX_PROVIDER_KEY_LENGTH) ||
    (typeof record.targetKey === "string" && record.targetKey.length > MAX_PROVIDER_KEY_LENGTH)
  ) {
    throw new Error("Invalid pending provider credential rotation.");
  }
  return {
    version: 1,
    providerId: record.providerId,
    previous: record.previous,
    target: record.target,
    previousKey: record.previousKey,
    targetKey: record.targetKey,
  };
}

export function serializePendingProviderCredentialRotation(
  value: PendingProviderCredentialRotationV1,
): string {
  const encoded = JSON.stringify(parsePendingProviderCredentialRotation(value));
  if (encoded.length > MAX_PROVIDER_CREDENTIAL_ROTATION_JOURNAL_LENGTH) {
    throw new Error("Pending provider credential rotation exceeds its durable journal bound.");
  }
  return encoded;
}

export function providerCredentialState(
  hasStoredKey: boolean,
  keyBoundToCurrentConnection: string | null,
): { previousKey: string | null; mismatched: boolean } {
  return {
    previousKey: keyBoundToCurrentConnection,
    mismatched: hasStoredKey && keyBoundToCurrentConnection === null,
  };
}

export function assertProviderCredentialLength(value: string): void {
  if (value.length > MAX_PROVIDER_KEY_LENGTH) {
    throw new Error(`Provider API keys cannot exceed ${MAX_PROVIDER_KEY_LENGTH} characters.`);
  }
}

export function normalizeProviderCredentialInput(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) {
    throw new Error("Provider credentials cannot contain control characters.");
  }
  const key = value.trim();
  assertProviderCredentialLength(key);
  return key;
}

export function credentialAfterProviderRotation(
  pending: PendingProviderCredentialRotationV1,
  current: ProviderConnection | null | undefined,
): { resolved: true; key: string | null } | { resolved: false } {
  if (current && pending.target && sameProviderConnection(current, pending.target)) {
    return { resolved: true, key: pending.targetKey };
  }
  if (current && pending.previous && sameProviderConnection(current, pending.previous)) {
    return { resolved: true, key: pending.previousKey };
  }
  // Config is authoritative and has moved beyond both journal snapshots (or
  // removed the provider). No staged key can be proven to belong to that
  // endpoint, so converge by clearing it instead of wedging every future save.
  return { resolved: true, key: null };
}
