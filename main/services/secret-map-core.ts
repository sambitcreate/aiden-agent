export type SecretKeyMap = Record<string, unknown>;

export function parseSecretKeyMap(value: unknown): SecretKeyMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid encrypted secret map.");
  }
  return Object.fromEntries(Object.entries(value));
}

export function normalizeSecretKeyMap(value: unknown): SecretKeyMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

export function secretKeyEntry(
  map: Readonly<SecretKeyMap>,
  providerId: string,
): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(map, providerId) ? map[providerId] : undefined;
  return typeof value === "string" ? value : undefined;
}

export function setSecretKeyEntry(map: SecretKeyMap, providerId: string, value: string): void {
  Object.defineProperty(map, providerId, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function deleteSecretKeyEntry(map: SecretKeyMap, providerId: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(map, providerId)) return false;
  delete map[providerId];
  return true;
}

export interface SecretEntryPair {
  valueId: string;
  bindingId: string;
}

export function moveSecretEntryWithBindingIfVacant(
  map: SecretKeyMap,
  valueId: string,
  to: SecretEntryPair,
  encryptedBinding: string,
): boolean {
  const value = secretKeyEntry(map, valueId);
  if (
    value === undefined ||
    Object.prototype.hasOwnProperty.call(map, to.valueId) ||
    Object.prototype.hasOwnProperty.call(map, to.bindingId)
  ) {
    return false;
  }
  setSecretKeyEntry(map, to.valueId, value);
  setSecretKeyEntry(map, to.bindingId, encryptedBinding);
  deleteSecretKeyEntry(map, valueId);
  return true;
}

export function bindSecretEntryIfUnbound(
  map: SecretKeyMap,
  valueId: string,
  bindingId: string,
  encryptedBinding: string,
): boolean {
  if (
    secretKeyEntry(map, valueId) === undefined ||
    Object.prototype.hasOwnProperty.call(map, bindingId)
  ) {
    return false;
  }
  setSecretKeyEntry(map, bindingId, encryptedBinding);
  return true;
}

function completeSecretPair(
  map: Readonly<SecretKeyMap>,
  pair: SecretEntryPair,
): { value: string; binding: string } | null {
  const value = secretKeyEntry(map, pair.valueId);
  const binding = secretKeyEntry(map, pair.bindingId);
  return value !== undefined && binding !== undefined ? { value, binding } : null;
}

export function moveSecretEntryPairIfVacant(
  map: SecretKeyMap,
  from: SecretEntryPair,
  to: SecretEntryPair,
): boolean {
  const source = completeSecretPair(map, from);
  if (
    !source ||
    Object.prototype.hasOwnProperty.call(map, to.valueId) ||
    Object.prototype.hasOwnProperty.call(map, to.bindingId)
  ) {
    return false;
  }
  setSecretKeyEntry(map, to.valueId, source.value);
  setSecretKeyEntry(map, to.bindingId, source.binding);
  deleteSecretKeyEntry(map, from.valueId);
  deleteSecretKeyEntry(map, from.bindingId);
  return true;
}

export function swapSecretEntryPairs(
  map: SecretKeyMap,
  first: SecretEntryPair,
  second: SecretEntryPair,
): boolean {
  const firstValues = completeSecretPair(map, first);
  const secondValues = completeSecretPair(map, second);
  if (!secondValues) return false;

  setSecretKeyEntry(map, first.valueId, secondValues.value);
  setSecretKeyEntry(map, first.bindingId, secondValues.binding);
  if (firstValues) {
    setSecretKeyEntry(map, second.valueId, firstValues.value);
    setSecretKeyEntry(map, second.bindingId, firstValues.binding);
  } else {
    deleteSecretKeyEntry(map, second.valueId);
    deleteSecretKeyEntry(map, second.bindingId);
  }
  return true;
}
