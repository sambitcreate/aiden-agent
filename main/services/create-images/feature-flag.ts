export const CREATE_IMAGES_FEATURE_FLAG = "AIDEN_CREATE_IMAGES_ENABLED";

/**
 * Create Images remains fail-closed until its packaged release gates pass.
 * Every renderer route and main-process handler must check the same capability.
 */
export function createImagesEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[CREATE_IMAGES_FEATURE_FLAG]?.trim() === "1";
}

export function createWhenImagesEnabled<T>(
  factory: () => T,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): T | undefined {
  return createImagesEnabled(environment) ? factory() : undefined;
}
