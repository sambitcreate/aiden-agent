export const CREATE_IMAGES_POWER_FEATURES_KEY = "aiden.create-images.power-features.v1";

export function readCreateImagesPowerFeatures(storage: Pick<Storage, "getItem">): boolean {
  try {
    return storage.getItem(CREATE_IMAGES_POWER_FEATURES_KEY) === "enabled";
  } catch {
    return false;
  }
}

export function writeCreateImagesPowerFeatures(
  storage: Pick<Storage, "setItem">,
  enabled: boolean,
): void {
  try {
    storage.setItem(CREATE_IMAGES_POWER_FEATURES_KEY, enabled ? "enabled" : "disabled");
  } catch {
    // This device preference never changes workflow execution semantics.
  }
}
