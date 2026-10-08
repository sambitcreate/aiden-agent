/** Ids are untrusted keys: "constructor" is a valid id and must never resolve to an inherited member. */
export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
