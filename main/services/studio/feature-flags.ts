export const DESIGN_STUDIO_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_DESIGN_STUDIO";
export const CREATE_IMAGES_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_CREATE_IMAGES";

type Environment = Readonly<Record<string, string | undefined>>;

function flagOn(environment: Environment, name: string): boolean {
  const value = environment[name]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** Design Studio stays dark (no route, row, command, store or protocol) until explicitly enabled. */
export function designStudioEnabled(environment: Environment = process.env): boolean {
  return flagOn(environment, DESIGN_STUDIO_FEATURE_FLAG);
}

/** Create Images stays dark until explicitly enabled. */
export function createImagesEnabled(environment: Environment = process.env): boolean {
  return flagOn(environment, CREATE_IMAGES_FEATURE_FLAG);
}

/** The shared studio asset store and `aiden-asset:` protocol exist only for an enabled studio feature. */
export function studioAssetsEnabled(environment: Environment = process.env): boolean {
  return designStudioEnabled(environment) || createImagesEnabled(environment);
}

export function studioCapabilities(environment: Environment = process.env): {
  designStudio: boolean;
  createImages: boolean;
} {
  return {
    designStudio: designStudioEnabled(environment),
    createImages: createImagesEnabled(environment),
  };
}
