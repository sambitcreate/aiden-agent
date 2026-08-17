import {
  MAX_PROVIDER_FAILURE_ATTEMPTS,
  PROVIDER_FAILURE_VERSION,
  type ProviderFailureV1,
} from "../../renderer/shared/provider-failure.js";

export type ProviderFailureReason =
  | "request-failed"
  | "context-overflow"
  | "compaction-failed"
  | "output-limit"
  | "interrupted";

/** Structural subset of Pi's provider-failed terminal outcome. */
export interface ProviderFailedTerminalOutcome {
  kind: "provider_failed";
  reason: ProviderFailureReason;
  attempts: number;
  finalMessage?: {
    stopReason?: string;
    errorMessage?: string;
  };
}

const AUTHENTICATION =
  /(?:\b40[13]\b|unauthori[sz]ed|forbidden|authentication (?:failed|required|error)|invalid[_ -]?(?:api[_ -]?)?key|api[_ -]?key (?:is )?not valid|incorrect (?:api[_ -]?)?key|invalid_grant|token (?:expired|invalid))/iu;
const QUOTA =
  /(?:insufficient[_ -]?quota|quota (?:exceeded|exhausted)|billing (?:limit|issue|required)|credit(?:s)? (?:exhausted|balance))/iu;
const RATE_LIMIT =
  /(?:\b429\b|rate[_ -]?limit|too many requests|requests? per (?:minute|second|day))/iu;
const TIMEOUT =
  /(?:\bETIMEDOUT\b|timed? out|timeout|deadline[_ -]?exceeded|headers timeout)/iu;
const SERVICE_UNAVAILABLE =
  /(?:\b50[0234]\b|service unavailable|temporarily unavailable|bad gateway|gateway timeout|overloaded)/iu;
const NETWORK =
  /(?:\bE(?:CONNRESET|CONNREFUSED|HOSTUNREACH|NETUNREACH|NETDOWN|PIPE|AI_AGAIN|NOTFOUND)\b|network error|fetch failed|getaddrinfo|upstream connect|reset before headers|other side closed|connection (?:closed|error|failed|lost|refused|reset)|socket (?:connection (?:was )?closed|closed|hang up))/iu;
const CONTEXT_WINDOW =
  /(?:context (?:window|length)|maximum context|too many (?:input )?tokens|request (?:is )?too large)/iu;
const INVALID_REQUEST =
  /(?:\b400\b|invalid[_ -]?request|malformed request|unprocessable (?:request|entity)|unsupported parameter)/iu;

function requestFailureCategory(
  message: string,
): ProviderFailureV1["category"] {
  // More specific provider categories must win over their common HTTP status.
  if (AUTHENTICATION.test(message)) return "authentication";
  if (QUOTA.test(message)) return "quota";
  if (RATE_LIMIT.test(message)) return "rate_limit";
  if (CONTEXT_WINDOW.test(message)) return "context_window";
  if (TIMEOUT.test(message)) return "timeout";
  if (SERVICE_UNAVAILABLE.test(message)) return "service_unavailable";
  if (NETWORK.test(message)) return "network";
  if (INVALID_REQUEST.test(message)) return "invalid_request";
  return "unknown";
}

/**
 * Collapse a terminal outcome to closed metadata before it reaches chat
 * persistence. The raw message is inspected only for classification and is
 * never returned.
 */
export function providerFailureFromTerminalOutcome(
  outcome: ProviderFailedTerminalOutcome,
): ProviderFailureV1 {
  const attempts = Number.isSafeInteger(outcome.attempts)
    ? Math.min(
        MAX_PROVIDER_FAILURE_ATTEMPTS,
        Math.max(0, outcome.attempts),
      )
    : 0;
  const category: ProviderFailureV1["category"] =
    outcome.reason === "context-overflow"
      ? "context_window"
      : outcome.reason === "compaction-failed"
        ? "context_management"
        : outcome.reason === "output-limit" ||
            outcome.finalMessage?.stopReason === "length"
          ? "output_limit"
          : outcome.reason === "interrupted" ||
              outcome.finalMessage?.stopReason === "aborted"
            ? "interrupted"
            : requestFailureCategory(outcome.finalMessage?.errorMessage ?? "");
  return {
    version: PROVIDER_FAILURE_VERSION,
    category,
    attempts,
    retryExhausted: attempts > 1,
  };
}

/** Convenient append payload for the foreground persistence adapter. */
export function providerFailureChatMetadata(
  outcome: ProviderFailedTerminalOutcome,
): { providerFailure: ProviderFailureV1 } {
  return { providerFailure: providerFailureFromTerminalOutcome(outcome) };
}

const CLOSED_NON_PROVIDER_ERRORS = new Set([
  "The app cancelled the model operation.",
  "The local agent runtime failed.",
]);

/**
 * Recover the safe part of a pre-V1 persisted Pi terminal. Legacy payloads did
 * not retain the outer attempt count, so zero explicitly means unavailable.
 */
export function providerFailureFromLegacyPiMessage(
  value: unknown,
): ProviderFailureV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.role !== "assistant") return undefined;
  const stopReason = candidate.stopReason;
  const errorMessage =
    typeof candidate.errorMessage === "string" ? candidate.errorMessage : undefined;
  if (errorMessage && CLOSED_NON_PROVIDER_ERRORS.has(errorMessage)) return undefined;
  const reason: ProviderFailureReason | undefined =
    stopReason === "length"
      ? "output-limit"
      : stopReason === "aborted" && errorMessage
        ? "interrupted"
        : stopReason === "error" && errorMessage
          ? "request-failed"
          : undefined;
  if (!reason) return undefined;
  return providerFailureFromTerminalOutcome({
    kind: "provider_failed",
    reason,
    attempts: 0,
    finalMessage: {
      ...(typeof stopReason === "string" ? { stopReason } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    },
  });
}

/** Closed log metadata; raw compaction/provider text is deliberately ignored. */
export function compactionFailureLogMetadata(value: {
  reason: "threshold" | "overflow" | "manual";
  errorMessage?: string;
}): { reason: "threshold" | "overflow" | "manual" } {
  return { reason: value.reason };
}
