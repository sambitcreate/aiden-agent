import type { Api, Model } from "@earendil-works/pi-ai";

type PromptCacheModel = Pick<Model<Api>, "provider" | "id" | "api" | "promptCache"> & {
  name?: string;
  compat?: unknown;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * How long the provider keeps an unused prompt cache for Aiden's chat
 * requests, in milliseconds, or 0 when no concrete lifetime is documented.
 *
 * Aiden sends Pi's default "short" retention, so the lifetimes below are the
 * defaults for that request shape. Only providers that publish a fixed idle
 * lifetime that each cache read restarts are listed; best-effort ranges
 * ("5 to 10 minutes", "a few hours") and undocumented caches return 0 so no
 * guessed countdown is shown. Documented lifetimes are guarantees, so a
 * cache may outlive the countdown. Sources were checked on 2026-10-19:
 * - Claude: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *   (5 min, measured from request start, refreshed on each read; the same on
 *   Bedrock, Google Cloud and gateways that pass cache_control through, per
 *   https://openrouter.ai/docs/guides/best-practices/prompt-caching).
 * - Bedrock: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
 *   (5 min for Claude and Nova, reset by each hit).
 * - OpenAI GPT-5.6 and later: https://developers.openai.com/api/docs/guides/prompt-caching
 *   (30 min after the latest write or reuse); Azure OpenAI keeps them at
 *   least 30 min: https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/prompt-caching
 * - Moonshot Kimi K3: https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api
 *   (5 min default, each hit renews it; K2.6 and K2.7 do not write caches).
 * - MiniMax M2 series, explicit caching: https://platform.minimax.io/docs/api-reference/text-prompt-caching
 *   (5 min, renewed with continued use; automatic caching varies with load).
 * - GitHub Copilot: https://docs.github.com/en/enterprise-cloud@latest/copilot/tutorials/optimize-ai-usage
 *   (24 h idle for OpenAI models, 1 h for Claude).
 */
export function promptCacheTtlMs(model: PromptCacheModel): number {
  const declared = model.promptCache?.short;
  if (declared !== undefined) return Number.isFinite(declared) && declared > 0 ? declared * 1000 : 0;
  const id = model.id.toLowerCase();
  if (model.provider === "github-copilot") {
    if (isClaude(model)) return HOUR;
    if (/^(gpt-|o\d)/u.test(id)) return 24 * HOUR;
    return 0;
  }
  if (model.api === "bedrock-converse-stream") {
    return bedrockCaches(model) ? 5 * MINUTE : 0;
  }
  if (isClaude(model) && (model.api === "anthropic-messages" || cacheControlFormat(model) === "anthropic")) {
    return 5 * MINUTE;
  }
  // Explicit caching, which Pi's cache_control markers request, covers M2-series models only.
  if ((model.provider === "minimax" || model.provider === "minimax-cn") && model.api === "anthropic-messages" && /^minimax-m2(?:[.-]|$)/u.test(id)) {
    return 5 * MINUTE;
  }
  // Kimi documents cache writes, and so a lifetime, only for K3.
  if ((model.provider === "moonshotai" || model.provider === "moonshotai-cn") && /^kimi-k3(?:[.-]|$)/u.test(id)) return 5 * MINUTE;
  if ((model.provider === "openai" || model.provider === "azure") && isThirtyMinuteOpenAiModel(model)) {
    return 30 * MINUTE;
  }
  return 0;
}

function isClaude(model: PromptCacheModel): boolean {
  return model.id.toLowerCase().includes("claude") || (model.name ?? "").toLowerCase().includes("claude");
}

function cacheControlFormat(model: PromptCacheModel): unknown {
  return model.compat && typeof model.compat === "object"
    ? (model.compat as { cacheControlFormat?: unknown }).cacheControlFormat
    : undefined;
}

/** Mirrors where Pi adds Bedrock cache points; Nova caches on its own. */
function bedrockCaches(model: PromptCacheModel): boolean {
  const candidates = [model.id, model.name ?? ""].map((value) => value.toLowerCase());
  if (candidates.some((value) => value.includes("amazon.nova"))) return true;
  if (!candidates.some((value) => value.includes("claude"))) return false;
  return candidates.some((value) =>
    /fable-5|opus-5|sonnet-5|haiku-5|-4-|claude-3-7-sonnet|claude-3-5-haiku/u.test(value),
  );
}

/** GPT-5.6 and later use OpenAI's fixed 30-minute cache. */
function isThirtyMinuteOpenAiModel(model: PromptCacheModel): boolean {
  const compat = model.compat as { supportsExplicitPromptCacheMode?: unknown } | undefined;
  if (compat?.supportsExplicitPromptCacheMode === true) return true;
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/u.exec(model.id.toLowerCase());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}
