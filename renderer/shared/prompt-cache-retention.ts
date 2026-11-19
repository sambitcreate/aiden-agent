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
 *   (1-hour TTL for the 4.5 and later Claude models only).
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

const BEDROCK_HOUR_CLAUDE = /claude-(?:fable|opus|sonnet|haiku)-(?:5|4-[5-9])(?:[-.:@]|$)/u;

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
