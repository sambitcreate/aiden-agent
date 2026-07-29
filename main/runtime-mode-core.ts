import { AIDEN_RUNTIME_PROFILE_ENV } from "./runtime-profile-core.js";

export function isDevelopmentRuntime(
  environment: NodeJS.ProcessEnv,
  isPackaged: boolean,
): boolean {
  const profile = environment[AIDEN_RUNTIME_PROFILE_ENV]?.trim();
  if (profile === "development") return true;
  if (profile === "production") return false;
  return !isPackaged;
}
