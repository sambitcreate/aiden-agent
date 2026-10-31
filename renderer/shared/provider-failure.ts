export const PROVIDER_FAILURE_VERSION = 1 as const;
export const MAX_PROVIDER_FAILURE_ATTEMPTS = 16;

export const PROVIDER_FAILURE_CATEGORIES = [
  "network",
  "timeout",
  "service_unavailable",
  "rate_limit",
  "authentication",
  "quota",
  "invalid_request",
  "context_window",
  "output_limit",
  "interrupted",
  "context_management",
  "unknown",
] as const;

export type ProviderFailureCategoryV1 =
  (typeof PROVIDER_FAILURE_CATEGORIES)[number];

/**
 * Renderer-safe terminal failure metadata. Provider-authored text and
 * diagnostics are intentionally not part of this contract.
 */
export interface ProviderFailureV1 {
  version: typeof PROVIDER_FAILURE_VERSION;
  category: ProviderFailureCategoryV1;
  attempts: number;
  retryExhausted: boolean;
}

const CATEGORY_SET = new Set<string>(PROVIDER_FAILURE_CATEGORIES);

/** Fail closed when persisted or IPC data does not match the closed schema. */
export function parseProviderFailureV1(
  value: unknown,
): ProviderFailureV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== PROVIDER_FAILURE_VERSION ||
    typeof candidate.category !== "string" ||
    !CATEGORY_SET.has(candidate.category) ||
    !Number.isSafeInteger(candidate.attempts) ||
    (candidate.attempts as number) < 0 ||
    (candidate.attempts as number) > MAX_PROVIDER_FAILURE_ATTEMPTS ||
    typeof candidate.retryExhausted !== "boolean" ||
    candidate.retryExhausted !== ((candidate.attempts as number) > 1)
  ) {
    return undefined;
  }
  return {
    version: PROVIDER_FAILURE_VERSION,
    category: candidate.category as ProviderFailureCategoryV1,
    attempts: candidate.attempts as number,
    retryExhausted: candidate.retryExhausted,
  };
}

export interface ProviderFailurePresentation {
  title: string;
  description: string;
}

/** Fixed renderer-owned copy. Never interpolate provider-authored data here. */
export function providerFailurePresentation(
  failure: ProviderFailureV1,
): ProviderFailurePresentation {
  const retryDescriptions: Partial<
    Record<ProviderFailureCategoryV1, string>
  > = {
    network: "Aiden still couldn’t reach the model provider after retrying. Check the connection and try again.",
    timeout: "The model provider still did not respond in time after retrying. Try again.",
    service_unavailable: "The model provider remained unavailable after retrying. Try again later.",
  };
  const description = failure.retryExhausted
    ? retryDescriptions[failure.category]
    : undefined;

  return {
    title: "Generation failed",
    description:
      description ??
      {
        network: "Aiden couldn’t reach the model provider. Check the connection and try again.",
        timeout: "The model provider did not respond in time. Try again.",
        service_unavailable: "The model provider is unavailable. Try again later.",
        rate_limit: "The model provider is receiving too many requests. Wait a moment and try again.",
        authentication: "The model provider rejected the current authentication. Review the connection in Settings.",
        quota: "The model provider reported that this account has no available quota.",
        invalid_request: "The model provider could not accept this request. Review the selected model and provider settings.",
        context_window: "This conversation exceeded the model’s context window.",
        output_limit: "The model reached its output limit. Any partial response above was saved.",
        interrupted: "The model response was interrupted before it completed.",
        context_management: "Aiden could not safely reduce this conversation’s context.",
        unknown: "The model provider could not complete this response.",
      }[failure.category],
  };
}

/** The one next step a failure card offers, chosen from the failure's cause. */
export type ProviderFailureAction = "try_again" | "open_providers" | "continue" | "compact";

const FAILURE_ACTIONS: Record<ProviderFailureCategoryV1, ProviderFailureAction> = {
  network: "try_again",
  timeout: "try_again",
  service_unavailable: "try_again",
  rate_limit: "try_again",
  interrupted: "try_again",
  unknown: "try_again",
  authentication: "open_providers",
  quota: "open_providers",
  invalid_request: "open_providers",
  output_limit: "continue",
  context_window: "compact",
  context_management: "compact",
};

export function providerFailureAction(failure: ProviderFailureV1): ProviderFailureAction {
  return FAILURE_ACTIONS[failure.category];
}

export const PROVIDER_FAILURE_ACTION_LABELS: Record<ProviderFailureAction, string> = {
  try_again: "Try again",
  open_providers: "Open Providers",
  continue: "Continue",
  compact: "Compact and try again",
};

/** The visible follow-up turn a failure card sends for Try again and Continue. */
export const PROVIDER_FAILURE_FOLLOW_UPS = {
  try_again: "Try that again.",
  continue: "Continue from where you stopped.",
} as const satisfies Partial<Record<ProviderFailureAction, string>>;
