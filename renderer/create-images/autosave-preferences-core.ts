export const CREATE_IMAGES_AUTOSAVE_KEY = "aiden.create-images.autosave.v1";

export const CREATE_IMAGES_AUTOSAVE_PREFERENCE_EVENT =
  "aiden:create-images-autosave-preference-changed";

export function readCreateImagesAutosaveEnabled(
  storage: Pick<Storage, "getItem">,
): boolean {
  try {
    return storage.getItem(CREATE_IMAGES_AUTOSAVE_KEY) !== "disabled";
  } catch {
    return true;
  }
}

export function writeCreateImagesAutosaveEnabled(
  storage: Pick<Storage, "setItem">,
  enabled: boolean,
): void {
  try {
    storage.setItem(
      CREATE_IMAGES_AUTOSAVE_KEY,
      enabled ? "enabled" : "disabled",
    );
  } catch {
    // A failed device preference write must not change workflow data.
  }
}

export function announceCreateImagesAutosavePreference(enabled: boolean): void {
  window.dispatchEvent(
    new CustomEvent<boolean>(CREATE_IMAGES_AUTOSAVE_PREFERENCE_EVENT, {
      detail: enabled,
    }),
  );
}
