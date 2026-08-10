import { logger, shell } from "../platform.js";
import { providerRegistry } from "./provider-registry.js";
import { ProviderAuthFlowCoordinator } from "./provider-auth-flow-core.js";

export const providerAuthFlow = new ProviderAuthFlowCoordinator({
  backendFor: (providerId, authType) => providerRegistry.authBackend(providerId, authType),
  logoutBackendFor: (providerId) => providerRegistry.logoutBackend(providerId),
  openExternal: async (url) => shell.openExternal(url),
  diagnostic: ({ operation, providerId, errorName, errorCode }) => {
    logger.warn("provider-auth", "Provider authentication operation failed", {
      operation,
      providerId,
      errorName,
      ...(errorCode ? { errorCode } : {}),
    });
  },
});

export function shutdownProviderAuthFlow(): Promise<void> {
  return providerAuthFlow.shutdown();
}
