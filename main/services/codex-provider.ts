import type { Api, AuthInteraction, Model, Models } from "@earendil-works/pi-ai";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export interface CodexModelSummary {
  id: string;
  name: string;
  api: "openai-codex-responses";
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
}

export interface CodexProviderSnapshot {
  id: typeof OPENAI_CODEX_PROVIDER_ID;
  name: string;
  authName: string;
  /** Configuration-only status. Request-time refresh may still require re-login. */
  configured: boolean;
  models: CodexModelSummary[];
}

function summarizeModel(model: Model<Api>): CodexModelSummary {
  if (model.api !== "openai-codex-responses") {
    throw new Error(`Unexpected API for OpenAI Codex model "${model.id}".`);
  }
  return {
    id: model.id,
    name: model.name,
    api: "openai-codex-responses",
    reasoning: model.reasoning,
    vision: model.input.includes("image"),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export class CodexProviderService {
  constructor(private readonly models: Models) {
    const provider = models.getProvider(OPENAI_CODEX_PROVIDER_ID);
    if (!provider?.auth.oauth) {
      throw new Error("The installed Pi release does not provide OpenAI Codex OAuth.");
    }
  }

  async snapshot(): Promise<CodexProviderSnapshot> {
    const provider = this.models.getProvider(OPENAI_CODEX_PROVIDER_ID);
    if (!provider?.auth.oauth) throw new Error("OpenAI Codex provider is unavailable.");
    const auth = await this.models.checkAuth(OPENAI_CODEX_PROVIDER_ID);
    return {
      id: OPENAI_CODEX_PROVIDER_ID,
      name: provider.name,
      authName: provider.auth.oauth.name,
      configured: auth?.type === "oauth",
      models: this.models.getModels(OPENAI_CODEX_PROVIDER_ID).map(summarizeModel),
    };
  }

  login(interaction: AuthInteraction) {
    return this.models.login(OPENAI_CODEX_PROVIDER_ID, "oauth", interaction);
  }

  logout(): Promise<void> {
    return this.models.logout(OPENAI_CODEX_PROVIDER_ID);
  }

  getModel(modelId: string): Model<Api> | undefined {
    return this.models.getModel(OPENAI_CODEX_PROVIDER_ID, modelId);
  }

  async getAvailableModels(): Promise<readonly Model<Api>[]> {
    return this.models.getAvailable(OPENAI_CODEX_PROVIDER_ID);
  }

  streamSimple: Models["streamSimple"] = (model, context, options) =>
    this.models.streamSimple(model, context, options);
}
