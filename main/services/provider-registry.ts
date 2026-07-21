import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import { CodexProviderService } from "./codex-provider.js";
import { piCredentialStore } from "./pi-credential-store.js";

/** The process-wide Pi authority. Focused provider services are views over this collection. */
export class ProviderRegistry {
  readonly codex: CodexProviderService;

  constructor(
    readonly models: Models,
    credentials: CredentialStore,
  ) {
    this.codex = new CodexProviderService(models, credentials);
  }
}

export const providerRegistry = new ProviderRegistry(
  builtinModels({ credentials: piCredentialStore }),
  piCredentialStore,
);
