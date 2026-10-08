/**
 * Lazy entry point. The provider object must exist when the provider
 * registry loads, but the service needs Electron's userData path, so every
 * service call is deferred to first use.
 */
import type { Api, Provider } from "@earendil-works/pi-ai";
import path from "node:path";

import { app } from "../../platform.js";
import { currentPlatformKey } from "../acp/harness.js";
import { createAcpHarnessProvider } from "../acp/provider.js";
import { createAntigravityDefinition } from "./definition.js";
import { AntigravityService } from "./service.js";

export const ANTIGRAVITY_DISABLE_FLAG = "AIDEN_DISABLE_ANTIGRAVITY";

/**
 * Antigravity is listed on macOS and Linux unless explicitly disabled. Being
 * listed costs nothing: no download, process or network request happens until
 * the user installs and signs in from Settings.
 */
export function antigravityEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "darwin" && platform !== "linux") return false;
  const value = environment[ANTIGRAVITY_DISABLE_FLAG]?.trim().toLowerCase();
  return value !== "1" && value !== "true";
}

let service: AntigravityService | undefined;

export function antigravityService(): AntigravityService {
  service ??= new AntigravityService({ baseDir: path.join(app.getPath("userData"), "acp", "antigravity") });
  return service;
}

/** Shut down only if the service was ever started. */
export async function shutdownAntigravity(): Promise<void> {
  await service?.shutdown();
}

export function antigravityProvider(): Provider<Api> {
  // Static parts (id, label, fallback catalog) need no paths.
  const definition = createAntigravityDefinition({ hasSignIn: async () => false });
  return createAcpHarnessProvider({
    definition,
    stream: (model, context, options) => antigravityService().runtime.stream(model, context, options),
    signIn: {
      name: "Google account",
      loginLabel: "Sign in with Google",
      signIn: (interaction) => antigravityService().signIn(interaction),
    },
    discoverModels: (signal) => antigravityService().discoverModels(signal),
  });
}

export function antigravitySupportedHere(): boolean {
  return currentPlatformKey() !== undefined;
}
