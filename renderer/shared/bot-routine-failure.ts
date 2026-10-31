/**
 * Why a Bot routine run failed, in the closed vocabulary the healing features
 * use: retries, auto-pause and the health card all group by `kind`, never by
 * provider prose.
 *
 * The classifier's precedence is authority, then session reason, then the
 * provider category recovered from Pi's detail text, then Pi's own reason
 * code. Only redacted, bounded text is kept on the failure.
 */

import type { BotSessionErrorReason } from "../../main/services/bot-runtime/bot-session-service.js";
import type { BotRuntimeAuthorityFailure } from "../../main/services/bot-runtime-authority.js";
import { providerFailureFromLegacyPiMessage } from "../../main/services/provider-failure.js";
import { redactCredentialTokens } from "../../main/shared/redaction.js";
import type { ProviderFailureCategoryV1 } from "./provider-failure.js";

export type BotRoutineFailureKind =
  | "temporary"
  | "sign_in"
  | "access_changed"
  | "model_setup"
  | "tool_error"
  | "stalled"
  | "other";

export interface BotRoutineFailure {
  kind: BotRoutineFailureKind;
  /** The stable cause inside the kind, such as `authentication` or `model_changed`. */
  code: string;
  /** Redacted provider text, at most {@link BOT_ROUTINE_FAILURE_DETAIL_CHARS} code points. */
  detail?: string;
  /** The tool a `tool_error` came from. */
  toolName?: string;
}

export const BOT_ROUTINE_FAILURE_DETAIL_CHARS = 500;
const FAILURE_CODE_CHARS = 120;
const FAILURE_TOOL_NAME_CHARS = 120;

const FAILURE_KINDS: ReadonlySet<string> = new Set<BotRoutineFailureKind>([
  "temporary",
  "sign_in",
  "access_changed",
  "model_setup",
  "tool_error",
  "stalled",
  "other",
]);

/** Authority failures that the person can fix by reviewing the Bot's setup. */
const ACCESS_CHANGED_AUTHORITY: ReadonlySet<BotRuntimeAuthorityFailure> = new Set<BotRuntimeAuthorityFailure>([
  "model_changed",
  "capability_changed",
  "access_unavailable",
  "provider_mismatch",
  "managed_home_changed",
]);

const SESSION_REASON_KINDS: Partial<Record<BotSessionErrorReason, BotRoutineFailureKind>> = {
  needs_model: "model_setup",
  access_changed: "access_changed",
};

const PROVIDER_CATEGORY_KINDS: Partial<Record<ProviderFailureCategoryV1, BotRoutineFailureKind>> = {
  network: "temporary",
  timeout: "temporary",
  service_unavailable: "temporary",
  rate_limit: "temporary",
  interrupted: "temporary",
  authentication: "sign_in",
  quota: "model_setup",
};

/** Pi reason codes that say something on their own. */
const PI_REASON_KINDS: Partial<Record<string, BotRoutineFailureKind>> = {
  no_model: "model_setup",
  interrupted: "temporary",
};

/** Cut by code point so a cut never splits a surrogate pair. */
function bounded(text: string, maximum: number): string {
  const points = [...text];
  return points.length > maximum ? points.slice(0, maximum).join("") : text;
}

/** Redacted, bounded provider text; undefined when there is nothing to keep. */
function safeDetail(detail: string | undefined): string | undefined {
  const trimmed = detail?.trim();
  if (!trimmed) return undefined;
  return bounded(redactCredentialTokens(trimmed, "[redacted]"), BOT_ROUTINE_FAILURE_DETAIL_CHARS).trim() || undefined;
}

/**
 * The provider category inside Pi's detail text. The raw text is inspected only
 * for classification; it is never returned.
 */
function providerCategory(detail: string | undefined): ProviderFailureCategoryV1 | undefined {
  if (!detail) return undefined;
  return providerFailureFromLegacyPiMessage({
    role: "assistant",
    stopReason: "error",
    errorMessage: detail,
  })?.category;
}

export function classifyBotRoutineFailure(input: {
  /** Pi reason: model_error, no_model, restart_limit, run_failed, … */
  reason?: string;
  /** Pi detail text (the provider's message). */
  detail?: string;
  /** A `BOT_RUNTIME_AUTHORITY_FAILURE_MESSAGES` key. */
  authority?: string;
  /** A `BotSessionErrorReason`. */
  sessionReason?: string;
}): BotRoutineFailure {
  const detail = safeDetail(input.detail);
  const withDetail = (failure: { kind: BotRoutineFailureKind; code: string }): BotRoutineFailure =>
    detail ? { ...failure, detail } : failure;

  if (input.authority && ACCESS_CHANGED_AUTHORITY.has(input.authority as BotRuntimeAuthorityFailure)) {
    return withDetail({ kind: "access_changed", code: input.authority });
  }
  const sessionKind = input.sessionReason
    ? SESSION_REASON_KINDS[input.sessionReason as BotSessionErrorReason]
    : undefined;
  if (sessionKind && input.sessionReason) {
    return withDetail({ kind: sessionKind, code: input.sessionReason });
  }
  const category = providerCategory(input.detail);
  if (category) {
    // Categories without a kind of their own (context, output limit, invalid
    // request) stay actionable through their code.
    return withDetail({ kind: PROVIDER_CATEGORY_KINDS[category] ?? "other", code: category });
  }
  if (input.reason) {
    return withDetail({ kind: PI_REASON_KINDS[input.reason] ?? "other", code: input.reason });
  }
  return withDetail({ kind: "other", code: "unknown" });
}

/**
 * Fail closed on a stored or IPC failure: an unknown kind or a missing code
 * drops the field instead of reaching a healing decision. Text is bounded here
 * so nothing longer than the contract is persisted or projected.
 */
export function parseBotRoutineFailure(value: unknown): BotRoutineFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.kind !== "string" || !FAILURE_KINDS.has(candidate.kind)) return undefined;
  if (typeof candidate.code !== "string" || !candidate.code.trim()) return undefined;
  const detail = typeof candidate.detail === "string" ? safeDetail(candidate.detail) : undefined;
  const toolName = typeof candidate.toolName === "string" && candidate.toolName.trim()
    ? bounded(candidate.toolName.trim(), FAILURE_TOOL_NAME_CHARS)
    : undefined;
  return {
    kind: candidate.kind as BotRoutineFailureKind,
    code: bounded(candidate.code.trim(), FAILURE_CODE_CHARS),
    ...(detail ? { detail } : {}),
    ...(toolName ? { toolName } : {}),
  };
}
