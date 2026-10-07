/**
 * A pi-ai Provider backed by an ACP harness.
 *
 * The agent owns its real credentials (inside its isolated profile). Pi's
 * credential store holds only a non-secret marker so the provider shows as
 * configured and Aiden's existing sign-in/sign-out flows apply unchanged.
 * Catalog discovery starts the agent, so it runs only after a sign-in or an
 * explicit refresh, never on the background catalog timer.
 */
import type {
  Api,
  AuthInteraction,
  Model,
  ModelsStoreEntry,
  Provider,
  RefreshModelsContext,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type { AcpHarnessDefinition } from "./harness.js";
import type { AcpHarnessRuntime } from "./runtime.js";

export const ACP_MANAGED_CREDENTIAL = "aiden-acp:managed-by-agent";

export interface AcpProviderSignIn {
  /** Display name of the sign-in method. */
  name: string;
  loginLabel: string;
  /** Interactive sign-in; resolves once the agent holds a working credential. */
  signIn(interaction: AuthInteraction): Promise<void>;
}

export interface AcpHarnessProviderOptions {
  definition: AcpHarnessDefinition;
  runtime: AcpHarnessRuntime;
  signIn: AcpProviderSignIn;
  /** Authenticated catalog discovery (starts the agent). */
  discoverModels(signal: AbortSignal): Promise<Model<Api>[]>;
}

function isModel(value: unknown, providerId: string): value is Model<Api> {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<Model<Api>>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    record.provider === providerId &&
    typeof record.api === "string" &&
    typeof record.contextWindow === "number"
  );
}

export function createAcpHarnessProvider(options: AcpHarnessProviderOptions): Provider<Api> {
  const { definition, runtime } = options;
  let models: Model<Api>[] = definition.fallbackModels();
  let discoveryDue = false;

  return {
    id: definition.id,
    name: definition.label,
    auth: {
      oauth: {
        name: options.signIn.name,
        loginLabel: options.signIn.loginLabel,
        async login(interaction) {
          await options.signIn.signIn(interaction);
          discoveryDue = true;
          return {
            type: "oauth",
            refresh: ACP_MANAGED_CREDENTIAL,
            access: ACP_MANAGED_CREDENTIAL,
            expires: Number.MAX_SAFE_INTEGER,
          };
        },
        async refresh(credential) {
          return credential;
        },
        async toAuth() {
          return { apiKey: ACP_MANAGED_CREDENTIAL };
        },
      },
    },
    getModels: () => models,
    async refreshModels(context: RefreshModelsContext) {
      const stored = (context.stored?.models ?? []).filter((model): model is Model<Api> =>
        isModel(model, definition.id),
      );
      // Restore the catalog the last discovery persisted.
      if (stored.length > 0) await context.publish({ update: () => (models = stored) });
      if (!context.allowNetwork || !context.credential) return;
      if (!discoveryDue && !context.force) return;
      let discovered: Model<Api>[];
      try {
        discovered = await options.discoverModels(context.signal);
      } catch {
        // Keep the previous catalog: a failed discovery must not hide models.
        return;
      }
      if (discovered.length === 0) return;
      discoveryDue = false;
      const entry: ModelsStoreEntry = { models: discovered, checkedAt: Date.now() };
      await context.publish({ persist: entry, update: () => (models = discovered) });
    },
    stream(model, context, streamOptions) {
      return runtime.stream(model, context, streamOptions as SimpleStreamOptions | undefined);
    },
    streamSimple(model, context, streamOptions) {
      return runtime.stream(model, context, streamOptions);
    },
  };
}
