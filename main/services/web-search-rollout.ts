/**
 * Startup-bound Web Search rollout policy.
 *
 * The provider zoo is a release capability, not a user setting. The only
 * control is read from the main-process environment once when this module is
 * evaluated. Keeping the policy immutable makes a running generation
 * deterministic: changing the environment requires an app restart and cannot
 * widen or change a destination after a route snapshot has been admitted.
 */

import {
  WEB_SEARCH_PROVIDER_IDS,
  type WebSearchCredentialMode,
  type WebSearchProviderId,
  type WebSearchSettingsV2,
} from "./web-search-provider-registry-core.js";

/** Exact-zero keeps the recoverable baseline available for emergency rollback. */
export const WEB_SEARCH_PROVIDER_ZOO_ENABLED_ENV = "AIDEN_WEB_SEARCH_PROVIDER_ZOO_ENABLED";

/** Compatibility names for callers that describe this as a rollout flag. */
export const WEB_SEARCH_PROVIDER_ZOO_ROLLOUT_ENV = WEB_SEARCH_PROVIDER_ZOO_ENABLED_ENV;
export const WEB_SEARCH_PROVIDER_ZOO_FEATURE_FLAG = WEB_SEARCH_PROVIDER_ZOO_ENABLED_ENV;

export type WebSearchRolloutMode = "provider-zoo" | "exa-baseline";

/** Main-owned settings operation names used by the rollback mutation fence. */
export type WebSearchRolloutMutation =
  | "set-enabled"
  | "set-selection"
  | "set-automatic-route"
  | "set-provider-config"
  | "set-credential"
  | "existing-auth";

export interface WebSearchRolloutPolicy {
  readonly providerZooEnabled: boolean;
  readonly mode: WebSearchRolloutMode;
}

/**
 * Resolve the startup flag from a supplied environment for deterministic
 * tests. Unknown values intentionally retain the default-on rollout, matching
 * the other Aiden emergency flags whose only disabling value is exact zero.
 */
export function webSearchProviderZooEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[WEB_SEARCH_PROVIDER_ZOO_ENABLED_ENV]?.trim() !== "0";
}

export function resolveWebSearchRolloutPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WebSearchRolloutPolicy {
  const providerZooEnabled = webSearchProviderZooEnabled(environment);
  return Object.freeze({
    providerZooEnabled,
    mode: providerZooEnabled ? "provider-zoo" : "exa-baseline",
  });
}

/** Pin an injected policy so a test seam or future caller cannot hot-mutate it. */
export function pinWebSearchRolloutPolicy(policy: WebSearchRolloutPolicy): WebSearchRolloutPolicy {
  const providerZooEnabled = policy.providerZooEnabled === true;
  return Object.freeze({
    providerZooEnabled,
    mode: providerZooEnabled ? "provider-zoo" : "exa-baseline",
  });
}

/** The process-wide policy is captured at main startup and never hot-reloaded. */
export const webSearchRollout = resolveWebSearchRolloutPolicy();

/**
 * Keep a rollback projection from becoming a destructive settings editor.
 * The projected renderer only knows about Exa, but an older/stale renderer
 * can still send generic IPC calls for the hidden route and provider config.
 * Those calls are rejected while the provider zoo is disabled; the durable
 * document therefore remains recoverable for the next rollout-enabled boot.
 */
export function webSearchRolloutMutationAllowed(
  mutation: WebSearchRolloutMutation,
  providerId?: WebSearchProviderId,
  policy: WebSearchRolloutPolicy = webSearchRollout,
): boolean {
  if (policy.providerZooEnabled) return true;
  if (mutation === "set-enabled") return true;
  return mutation === "set-credential" && providerId === "exa";
}

export function assertWebSearchRolloutMutationAllowed(
  mutation: WebSearchRolloutMutation,
  providerId?: WebSearchProviderId,
  policy: WebSearchRolloutPolicy = webSearchRollout,
): void {
  if (webSearchRolloutMutationAllowed(mutation, providerId, policy)) return;
  throw new Error(
    "Web Search provider-zoo rollback is active; only the global switch and Exa credential may change until restart.",
  );
}

function cloneSettings(settings: WebSearchSettingsV2): WebSearchSettingsV2 {
  const providerConfig: WebSearchSettingsV2["providerConfig"] = {};
  for (const [providerId, config] of Object.entries(settings.providerConfig)) {
    if (config !== undefined) providerConfig[providerId as WebSearchProviderId] = { ...config };
  }
  return {
    version: settings.version,
    enabled: settings.enabled,
    selection:
      settings.selection.mode === "fixed"
        ? {
            mode: "fixed",
            providerId: settings.selection.providerId,
            credentialMode: settings.selection.credentialMode,
          }
        : {
            mode: "automatic",
            route: settings.selection.route.map((entry) => ({ ...entry })),
            fallbackOn: [...settings.selection.fallbackOn],
          },
    providerConfig,
  };
}

function exaCredentialMode(
  settings: WebSearchSettingsV2,
): Extract<WebSearchCredentialMode, "anonymous" | "api-key"> {
  const exaEntry =
    settings.selection.mode === "fixed"
      ? settings.selection.providerId === "exa"
        ? settings.selection
        : undefined
      : settings.selection.route.find((entry) => entry.providerId === "exa");
  // A saved Exa key is deliberately not enough to select keyed traffic. Only
  // a route that already named Exa's API-key mode is retained as keyed during
  // rollback; a dormant key therefore cannot be spent by the kill switch.
  return exaEntry?.credentialMode === "api-key" ? "api-key" : "anonymous";
}

/**
 * Project durable settings into the active process policy without mutating or
 * persisting the durable document. Rollback always uses Exa and never chooses
 * a paid provider as a substitute. The route is fixed so no hidden fallback
 * or fan-out survives the collapse.
 */
export function webSearchSettingsForRollout(
  settings: WebSearchSettingsV2,
  policy: WebSearchRolloutPolicy = webSearchRollout,
): WebSearchSettingsV2 {
  const cloned = cloneSettings(settings);
  if (policy.providerZooEnabled) return cloned;
  return {
    ...cloned,
    selection: {
      mode: "fixed",
      providerId: "exa",
      credentialMode: exaCredentialMode(settings),
    },
  };
}

/** Only Exa remains visible while the release capability is rolled back. */
export function webSearchVisibleProviderIds(
  policy: WebSearchRolloutPolicy = webSearchRollout,
): readonly WebSearchProviderId[] {
  return policy.providerZooEnabled ? WEB_SEARCH_PROVIDER_IDS : ["exa"];
}

export function webSearchProviderVisible(
  providerId: WebSearchProviderId,
  policy: WebSearchRolloutPolicy = webSearchRollout,
): boolean {
  return policy.providerZooEnabled || providerId === "exa";
}
