export const CREATE_IMAGES_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_CREATE_IMAGES";

type Environment = Readonly<Record<string, string | undefined>>;

function flagOn(environment: Environment, name: string): boolean {
  const value = environment[name]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** Create Images stays dark until explicitly enabled. */
export function createImagesEnabled(environment: Environment = process.env): boolean {
  return flagOn(environment, CREATE_IMAGES_FEATURE_FLAG);
}

/** The shared studio asset store and `aiden-asset:` protocol exist only while Create Images is on. */
export function studioAssetsEnabled(environment: Environment = process.env): boolean {
  return createImagesEnabled(environment);
}

export function studioCapabilities(environment: Environment = process.env): {
  createImages: boolean;
} {
  return {
    createImages: createImagesEnabled(environment),
  };
}
