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

/** Design mode v2's live-app work (DESIGN.md first, then live apps); off by default. */
export const DESIGN_LIVE_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_DESIGN_LIVE";

/** Design flags accept 1, true, yes or on, trimmed and case-insensitive. */
export function designFlagOn(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** Read on every check, so a changed environment takes effect at the next turn. */
export function designLiveEnabled(environment: Environment = process.env): boolean {
  return designModeEnabled(environment) && designFlagOn(environment[DESIGN_LIVE_FEATURE_FLAG]);
}

/** The shared studio asset store and `aiden-asset:` protocol exist only while Create Images is on. */
export function studioAssetsEnabled(environment: Environment = process.env): boolean {
  return createImagesEnabled(environment);
}

export function studioCapabilities(environment: Environment = process.env): {
  createImages: boolean;
  designMode: boolean;
  /** DESIGN.md and live apps in design mode (`AIDEN_EXPERIMENTAL_DESIGN_LIVE`). */
  designLive: boolean;
} {
  return {
    createImages: createImagesEnabled(environment),
    designMode: designModeEnabled(environment),
    designLive: designLiveEnabled(environment),
  };
}
