export const CREATE_IMAGES_RECENT_OUTPUT_CUTOFF_KEY =
  "aiden.create-images.recent-output-cutoff.v1";

export function readCreateImagesRecentOutputCutoff(
  storage: Pick<Storage, "getItem">,
): number | undefined {
  try {
    const raw = storage.getItem(CREATE_IMAGES_RECENT_OUTPUT_CUTOFF_KEY);
    if (!raw || raw.length > 32) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 && value <= Date.now() + 60_000
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeCreateImagesRecentOutputCutoff(
  storage: Pick<Storage, "setItem" | "removeItem">,
  cutoff?: number,
): void {
  if (cutoff === undefined) {
    storage.removeItem(CREATE_IMAGES_RECENT_OUTPUT_CUTOFF_KEY);
    return;
  }
  if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > Date.now() + 60_000) {
    throw new Error("Invalid recent-image presentation cutoff.");
  }
  storage.setItem(CREATE_IMAGES_RECENT_OUTPUT_CUTOFF_KEY, String(cutoff));
}

export function visibleCreateImagesRecentOutputs<T extends { createdAt: string }>(
  items: readonly T[],
  cutoff?: number,
): T[] {
  if (cutoff === undefined) return [...items];
  return items.filter((item) => {
    const createdAt = Date.parse(item.createdAt);
    return Number.isFinite(createdAt) && createdAt > cutoff;
  });
}
