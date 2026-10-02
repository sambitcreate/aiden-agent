import { resolveProviderDeployment } from "./provider-deployment.js";

export interface LocalClassifierProviderFields {
  id?: string;
  kind?: string;
  baseUrl?: string;
  deployment?: "local" | "hosted";
  isBuiltin?: boolean;
  llamaCppClassifierEnabled?: unknown;
}

/** Capability is user-authored intent; an OpenAI-compatible URL alone never enables it. */
export function validateLocalClassifierPreference(provider: LocalClassifierProviderFields): void {
  const enabled = provider.llamaCppClassifierEnabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("The llama.cpp classifier option must be a boolean.");
  }
  if (enabled === true && (
    !provider.id?.startsWith("custom:") || provider.id.length <= 7 ||
    provider.isBuiltin || provider.kind !== "openai" || resolveProviderDeployment(provider) !== "local"
  )) {
    throw new Error("llama.cpp classification requires a custom local OpenAI-compatible provider.");
  }
}
