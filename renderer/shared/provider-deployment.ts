import { isAcpHarnessProvider } from "./acp-harness.js";

/** Whether a provider runs on this machine (or a marked private host) vs a cloud API. */
export type ProviderDeployment = "local" | "hosted";

export interface ProviderDeploymentFields {
  id?: string;
  baseUrl?: string;
  deployment?: ProviderDeployment;
}

/** Loopback hosts are treated as local when no explicit deployment is stored. */
export function isLoopbackProviderBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, "")
      .replace(/\.$/u, "");
    return (
      hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Explicit `deployment` wins. Otherwise infer from the base URL loopback check.
 * Preset ids alone are not enough — a remote URL on the lmstudio/ollama preset
 * is hosted unless the user marks it local.
 */
export function resolveProviderDeployment(
  provider: ProviderDeploymentFields,
): ProviderDeployment {
  if (provider.deployment === "local" || provider.deployment === "hosted") {
    return provider.deployment;
  }
  return isLoopbackProviderBaseUrl(provider.baseUrl) ? "local" : "hosted";
}

export function isLocalProviderDeployment(provider: ProviderDeploymentFields): boolean {
  return resolveProviderDeployment(provider) === "local";
}

/**
 * Where a picker entry's model runs, as the short tag after the provider name
 * and the matching phrase in its accessible description. Agent-backed providers
 * run a full agent (with its own tools) on this computer, which is neither a
 * local model nor a hosted API call.
 */
export function providerDeploymentLabel(
  providerId: string,
  isLocal: boolean,
): { tag: "Agent" | "Local" | "Hosted"; description: string } {
  if (isAcpHarnessProvider(providerId)) return { tag: "Agent", description: "Deployment agent on this computer" };
  return isLocal ? { tag: "Local", description: "Deployment local" } : { tag: "Hosted", description: "Deployment hosted" };
}
