/**
 * Which providers can keep a chat's prompt cache for an hour instead of the
 * default few minutes. Kept beside the provider capabilities so Settings and
 * the request path read one list.
 *
 * Pi sends long retention as Anthropic's `cache_control.ttl: "1h"` and as
 * Bedrock's `cachePoint.ttl: ONE_HOUR`. Both providers charge more to write
 * an hour-long entry (Anthropic: twice the base input price instead of 1.25
 * times), and reads cost the same, so it pays off only when a chat is resumed
 * after the default lifetime has passed but within the hour.
 * - Anthropic: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *   (1-hour cache duration for every current Claude model).
 * - Bedrock: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
 *   (checked 2026-11-19). Its table lists a 1-hour TTL for Claude Haiku 4.5,
 *   Opus 4.5 and later, Sonnet 4.6 and later, and every Claude 5 model; not
 *   for Sonnet 4.5, Sonnet 4 or Opus 4.1. A `ttl` on a model without it can be
 *   rejected with a ValidationException, so a model outside the table keeps the
 *   default lifetime.
 */
export const LONG_PROMPT_CACHE_PROVIDER_IDS: readonly string[] = Object.freeze(["anthropic", "amazon-bedrock"]);

export const LONG_PROMPT_CACHE_TTL_MS = 60 * 60_000;

export function providerSupportsLongPromptCache(providerId: string): boolean {
  return LONG_PROMPT_CACHE_PROVIDER_IDS.includes(providerId);
}

interface RetentionModel {
  provider: string;
  id: string;
  api: string;
  name?: string;
  compat?: unknown;
}

// Pi 1.5.2 sends the hour for any caching Claude on Bedrock, so this is the only gate.
const BEDROCK_HOUR_CLAUDE = /claude-(?:(?:opus|haiku)-(?:4-[5-9]|5)|sonnet-(?:4-[6-9]|5)|(?:fable|mythos)-5)(?:[-.:@]|$)/u;

/** Whether Pi sends an hour-long cache for this resolved model when asked for "long". */
export function supportsLongPromptCacheRetention(model: RetentionModel): boolean {
  if (!providerSupportsLongPromptCache(model.provider)) return false;
  const names = [model.id, model.name ?? ""].map((value) => value.toLowerCase());
  if (model.provider === "anthropic") {
    const compat = model.compat && typeof model.compat === "object"
      ? (model.compat as { supportsLongCacheRetention?: unknown }).supportsLongCacheRetention
      : undefined;
    return model.api === "anthropic-messages" && compat !== false && names.some((value) => value.includes("claude"));
  }
  return model.api === "bedrock-converse-stream" && names.some((value) => BEDROCK_HOUR_CLAUDE.test(value));
}

/** The retention a foreground chat request asks for under the person's setting. */
export function chatPromptCacheRetention(
  settings: { longPromptCacheRetention?: boolean },
  model: RetentionModel,
): "short" | "long" {
  return settings.longPromptCacheRetention === true && supportsLongPromptCacheRetention(model) ? "long" : "short";
}
