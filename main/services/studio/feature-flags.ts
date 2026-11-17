export const CREATE_IMAGES_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_CREATE_IMAGES";
/** Design mode is on by default; `AIDEN_DESIGN_MODE=0` turns it off. */
export const DESIGN_MODE_KILL_SWITCH = "AIDEN_DESIGN_MODE";

type Environment = Readonly<Record<string, string | undefined>>;

function flagOn(environment: Environment, name: string): boolean {
  const value = environment[name]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** Create Images stays dark until explicitly enabled. */
export function createImagesEnabled(environment: Environment = process.env): boolean {
  return flagOn(environment, CREATE_IMAGES_FEATURE_FLAG);
}

function flagOff(environment: Environment, name: string): boolean {
  const value = environment[name]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

/** Design mode (chat beside a design canvas) is on unless the kill switch turns it off. */
export function designModeEnabled(environment: Environment = process.env): boolean {
  return !flagOff(environment, DESIGN_MODE_KILL_SWITCH);
}

/** The shared studio asset store and `aiden-asset:` protocol exist only while Create Images is on. */
export function studioAssetsEnabled(environment: Environment = process.env): boolean {
  return createImagesEnabled(environment);
}

export function studioCapabilities(environment: Environment = process.env): {
  createImages: boolean;
  designMode: boolean;
} {
  return {
    createImages: createImagesEnabled(environment),
    designMode: designModeEnabled(environment),
  };
}
