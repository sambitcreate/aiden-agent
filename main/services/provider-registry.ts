import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  Api,
  AuthInteraction,
  AuthType,
  Credential,
  CredentialStore,
  Model,
  Models,
  Provider as PiProvider,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { CodexProviderService, OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import { piCredentialStore } from "./pi-credential-store.js";
import { piModelsStore } from "./pi-models-store.js";
import { isCustomProviderId } from "./custom-provider-id.js";
import { secrets } from "./secrets.js";
import type { Provider, ProviderModelMetadata, StoredProvider } from "./types.js";
import {
  anthropicThinkingCanDisable,
  anthropicThinkingLevelsForModel,
} from "../../renderer/shared/anthropic-thinking.js";
import {
  googleThinkingCanDisable,
  googleThinkingLevelsForModel,
} from "../../renderer/shared/google-thinking.js";
import type { ProviderAuthBackend, ProviderLogoutBackend } from "./provider-auth-flow-core.js";

/** IDs used by Aiden before Pi became the provider authority. */
const LEGACY_API_KEY_PROVIDER_IDS: Readonly<Record<string, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  deepseek: "deepseek",
  moonshot: "moonshotai",
};

function metadataFor(providerId: string, model: Model<Api>): ProviderModelMetadata {
  const thinking =
    providerId === "anthropic"
      ? {
          thinkingLevels: anthropicThinkingLevelsForModel(model),
          thinkingCanDisable: anthropicThinkingCanDisable(model),
        }
      : providerId === "google"
        ? {
            thinkingLevels: googleThinkingLevelsForModel(model),
            thinkingCanDisable: googleThinkingCanDisable(model),
          }
        : {};
  return {
    source: "provider",
    name: model.name,
    type: "llm",
    vision: model.input.includes("image"),
    reasoning: model.reasoning,
    ...thinking,
    contextLength: model.contextWindow,
  };
}

function builtinProviderRecord(
  provider: PiProvider,
  models: readonly Model<Api>[] = provider.getModels(),
): StoredProvider {
  const modelIds = models.map((model) => model.id);
  return {
    id: provider.id,
    // This field survives the renderer's legacy DTO. It is never used to
    // choose a transport for Pi-owned providers.
    kind: "openai",
    label: provider.name,
    baseUrl: provider.baseUrl ?? "",
    models: modelIds,
    modelMetadata: Object.fromEntries(
      models.map((model) => [model.id, metadataFor(provider.id, model)]),
    ),
    defaultModel: modelIds[0],
    // Pi owns the exact auth semantics (including ambient credentials and
    // OAuth). The legacy boolean only controls old renderer availability code.
    needsKey: true,
    deployment: "hosted",
    isBuiltin: true,
  };
}

/** The process-wide Pi authority. Aiden custom endpoints never replace these providers. */
export class ProviderRegistry {
  readonly codex: CodexProviderService;
  private legacyCredentialMigration: Promise<void> | null = null;
  private catalogHydration: Promise<void> | null = null;

  constructor(
    readonly models: Models,
    private readonly credentials: CredentialStore,
  ) {
    this.codex = new CodexProviderService(models, credentials);
  }

  isBuiltinProvider(providerId: string): boolean {
    // This namespace is Aiden's durable escape hatch for local/private
    // connections. Prefer the persisted custom connection even if a future
    // Pi release happened to publish the same string.
    return !isCustomProviderId(providerId) && this.models.getProvider(providerId) !== undefined;
  }

  /** Pi built-ins except Codex, whose subscription sign-in has its own UI. */
  builtinProviders(): readonly PiProvider[] {
    return this.models
      .getProviders()
      .filter(
        (provider) => provider.id !== OPENAI_CODEX_PROVIDER_ID && !isCustomProviderId(provider.id),
      );
  }

  builtinProvider(providerId: string): StoredProvider | undefined {
    if (isCustomProviderId(providerId)) return undefined;
    const provider = this.models.getProvider(providerId);
    if (!provider || provider.id === OPENAI_CODEX_PROVIDER_ID) return undefined;
    return builtinProviderRecord(provider);
  }

  /** Provider metadata for selection-only consumers such as Scheduled Tasks. */
  async selectionProvider(providerId: string): Promise<StoredProvider | undefined> {
    if (isCustomProviderId(providerId)) return undefined;
    if (providerId === OPENAI_CODEX_PROVIDER_ID) {
      const snapshot = await this.codex.snapshot();
      return {
        id: snapshot.id,
        kind: "openai",
        label: snapshot.name,
        baseUrl: "",
        models: snapshot.models.map((model) => model.id),
        modelMetadata: Object.fromEntries(
          snapshot.models.map((model) => [
            model.id,
            {
              source: "provider" as const,
              name: model.name,
              type: "llm" as const,
              vision: model.vision,
              reasoning: model.reasoning,
              thinkingLevels: model.thinkingLevels,
              contextLength: model.contextWindow,
            },
          ]),
        ),
        defaultModel: snapshot.models[0]?.id,
        needsKey: true,
        deployment: "hosted",
        isBuiltin: true,
      };
    }
    await this.ensureBuiltinCatalogs();
    return this.builtinProvider(providerId);
  }

  getBuiltinModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.models.getModel(providerId, modelId);
  }

  /** Main-process-only auth for explicit non-chat Pi capabilities such as voice. */
  async getBuiltinRequestAuth(providerId: string) {
    await this.ensureBuiltinCatalogs();
    return this.models.getAuth(providerId);
  }

  /**
   * Main-process-only, non-secret credential metadata for capabilities that
   * must distinguish a stored API key from OAuth before resolving request
   * auth. This never exposes the credential value.
   */
  async getBuiltinCredentialKind(
    providerId: string,
  ): Promise<"api_key" | "oauth" | undefined> {
    await this.ensureBuiltinCatalogs();
    return (await this.credentials.list()).find((entry) => entry.providerId === providerId)?.type;
  }

  /**
   * Pi's provider-owned setup flows return full credentials (including
   * provider-specific fields such as Cloudflare account/gateway IDs). Keep
   * those values inside the main process and commit them only after the UI
   * coordinator has reached its point of no return.
   */
  authBackend(providerId: string, authType: AuthType): ProviderAuthBackend {
    if (isCustomProviderId(providerId)) {
      throw new Error("Custom connections do not use Pi-native authentication.");
    }
    if (providerId === OPENAI_CODEX_PROVIDER_ID) {
      if (authType !== "oauth") {
        throw new Error("ChatGPT / Codex uses its native OAuth sign-in.");
      }
      return this.codex;
    }

    const provider = this.models.getProvider(providerId);
    if (!provider) throw new Error("This Pi provider is no longer available.");
    const auth = authType === "api_key" ? provider.auth.apiKey : provider.auth.oauth;
    if (!auth?.login) {
      throw new Error(
        `${provider.name} does not offer interactive ${authType === "api_key" ? "API-key" : "OAuth"} setup.`,
      );
    }
    return {
      snapshot: async () =>
        (await this.listBuiltinProviders()).find((item) => item.id === providerId),
      authenticate: (interaction: AuthInteraction) => auth.login!(interaction),
      commitCredential: async (credential: unknown) => {
        await this.credentials.modify(providerId, async () => credential as Credential);
      },
      logout: () => this.credentials.delete(providerId),
    };
  }

  /** Credential removal is independent of which interactive setup method a provider offers. */
  logoutBackend(providerId: string): ProviderLogoutBackend {
    if (isCustomProviderId(providerId)) {
      throw new Error("Custom connections do not use Pi-native authentication.");
    }
    if (providerId === OPENAI_CODEX_PROVIDER_ID) {
      return {
        snapshot: () => this.codex.snapshot(),
        logout: () => this.codex.logout(),
        committedFallback: () => this.codex.committedLogoutSnapshot(),
      };
    }
    if (!this.models.getProvider(providerId)) {
      throw new Error("This Pi provider is no longer available.");
    }
    return {
      snapshot: async () =>
        (await this.listBuiltinProviders()).find((item) => item.id === providerId),
      logout: () => this.credentials.delete(providerId),
      committedFallback: () => ({ id: providerId, hasKey: null, canLogout: false }),
    };
  }

  /** Restore durable dynamic catalogs before exposing any Pi snapshot. */
  async ensureBuiltinCatalogs(): Promise<void> {
    if (!this.catalogHydration) {
      this.catalogHydration = this.models
        .refresh({ allowNetwork: false })
        .then(() => undefined)
        .catch(() => undefined);
    }
    await this.catalogHydration;
  }

  /** Refresh Pi-owned dynamic catalogs after valid setup or an explicit user action. */
  async refreshBuiltinCatalogs(): Promise<ReadonlyMap<string, Error>> {
    await this.ensureBuiltinCatalogs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    timeout.unref?.();
    try {
      const result = await this.models.refresh({ force: true, signal: controller.signal });
      return result.errors;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Reject stale/hidden Pi selections before an agent run accepts user input. */
  async assertBuiltinModelAvailable(providerId: string, modelId: string): Promise<void> {
    if (providerId === OPENAI_CODEX_PROVIDER_ID) return;
    await this.ensureBuiltinCatalogs();
    const available = await this.models.getAvailable(providerId);
    if (!available.some((model) => model.id === modelId)) {
      throw new Error(
        `Model "${modelId}" is not currently available through Pi's ${this.models.getProvider(providerId)?.name ?? providerId} provider. Refresh its setup or choose another model.`,
      );
    }
  }

  /**
   * A renderer-safe snapshot. `checkAuth` deliberately retains Pi's ambient
   * credential support rather than treating every provider as API-key-only.
   */
  async listBuiltinProviders(): Promise<Provider[]> {
    await this.ensureBuiltinCatalogs();
    const storedCredentialIds = new Set(
      (await this.credentials.list()).map((credential) => credential.providerId),
    );
    return Promise.all(
      this.builtinProviders().map(async (provider) => {
        let availableModels: readonly Model<Api>[] | undefined;
        let configured = false;
        try {
          configured = Boolean(await this.models.checkAuth(provider.id));
          if (configured) availableModels = await this.models.getAvailable(provider.id);
        } catch {
          // A corrupted credential is an actionable setup state, not a reason
          // to hide the provider or make the whole settings list fail.
        }
        const record = builtinProviderRecord(provider, availableModels ?? provider.getModels());
        const authMethods = [
          provider.auth.apiKey
            ? {
                type: "api_key" as const,
                label: provider.auth.apiKey.name,
                canLogin: Boolean(provider.auth.apiKey.login),
              }
            : undefined,
          provider.auth.oauth
            ? {
                type: "oauth" as const,
                label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
                canLogin: Boolean(provider.auth.oauth.login),
              }
            : undefined,
        ].filter(
          (method): method is { type: "api_key" | "oauth"; label: string; canLogin: boolean } =>
            method !== undefined,
        );
        return {
          ...record,
          hasKey: configured,
          canLogout: storedCredentialIds.has(provider.id),
          authMethods,
        };
      }),
    );
  }

  /** Route through Models so Pi resolves auth and dispatches its native API. */
  streamSimple: ProviderStreams["streamSimple"] = (model, context, options) =>
    this.models.streamSimple(model, context, options);

  /**
   * Copy one-release legacy key records into Pi's credential store. The old
   * encrypted file remains untouched for rollback; a current Pi credential
   * always wins. Repeated calls share one in-flight migration.
   */
  migrateLegacyApiKeys(): Promise<void> {
    if (!this.legacyCredentialMigration) {
      this.legacyCredentialMigration = Promise.all(
        Object.entries(LEGACY_API_KEY_PROVIDER_IDS).map(async ([legacyId, piId]) => {
          if (await this.credentials.read(piId)) return;
          const key = await secrets.getKey(legacyId);
          if (!key?.trim()) return;
          await this.credentials.modify(
            piId,
            async (current) => current ?? { type: "api_key", key: key.trim() },
          );
        }),
      )
        .then(() => undefined)
        .catch((error) => {
          // A transient keychain error must not permanently poison future
          // migration attempts in this process.
          this.legacyCredentialMigration = null;
          throw error;
        });
    }
    return this.legacyCredentialMigration;
  }
}

export const providerRegistry = new ProviderRegistry(
  builtinModels({ credentials: piCredentialStore, modelsStore: piModelsStore }),
  piCredentialStore,
);
