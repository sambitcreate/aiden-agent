/**
 * The model Pi starts each built-in provider on, copied from the pinned
 * pi-coding-agent's `defaultModelPerProvider` (Pi 1.6.0). The CLI server takes
 * these defaults from Pi directly; the desktop does not depend on
 * pi-coding-agent, so it keeps this copy. Update it with every Pi upgrade.
 *
 * It is only the fallback for a provider that has no saved selection. It
 * never replaces a person's saved model or thinking level, and it never orders
 * or routes models by price.
 */
export const PI_DEFAULT_MODEL_PER_PROVIDER: Readonly<Record<string, string>> = {
  "amazon-bedrock": "us.anthropic.claude-opus-5-5",
  "ant-ling": "Ring-2.6-1T",
  anthropic: "claude-opus-5-5",
  openai: "gpt-6.2-sol",
  azure: "gpt-6.2-sol",
  "openai-codex": "gpt-6.2-sol",
  radius: "balanced",
  nvidia: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  deepseek: "deepseek-v4-pro",
  google: "gemini-4-argon",
  "google-vertex": "gemini-4-argon",
  "github-copilot": "gpt-6.1-sol",
  openrouter: "moonshotai/kimi-k2.7-code",
  "vercel-ai-gateway": "zai/glm-5.3",
  xai: "grok-4.7",
  groq: "openai/gpt-oss-120b",
  cerebras: "gpt-oss-120b",
  zai: "glm-5.3",
  "zai-coding-cn": "glm-5.3",
  mistral: "devstral-medium-latest",
  minimax: "MiniMax-M3",
  "minimax-cn": "MiniMax-M3",
  moonshotai: "kimi-k2.7-code",
  "moonshotai-cn": "kimi-k2.7-code",
  huggingface: "moonshotai/Kimi-K2.7-Code",
  fireworks: "accounts/fireworks/models/kimi-k3",
  together: "moonshotai/Kimi-K3",
  baseten: "zai-org/GLM-5.3",
  opencode: "kimi-k2.7-code",
  "opencode-go": "kimi-k3.1-pro",
  "kimi-coding": "kimi-for-coding",
  meta: "muse-spark-1.3",
  "cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.7-code",
  "cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.7-code",
  "qwen-token-plan": "qwen3.8-max",
  "qwen-token-plan-cn": "qwen3.8-max",
  "qwen-token-plan-individual": "qwen3.8-max",
  "qwen-token-plan-individual-cn": "qwen3.8-max",
  xiaomi: "mimo-v2.6-pro",
  "xiaomi-token-plan-cn": "mimo-v2.6-pro",
  "xiaomi-token-plan-ams": "mimo-v2.6-pro",
  "xiaomi-token-plan-sgp": "mimo-v2.6-pro",
};

/** Pi's default for the provider when the provider still serves it, otherwise its first model. */
export function piDefaultModelFor(
  providerId: string,
  modelIds: readonly string[],
): string | undefined {
  const piDefault = Object.prototype.hasOwnProperty.call(PI_DEFAULT_MODEL_PER_PROVIDER, providerId)
    ? PI_DEFAULT_MODEL_PER_PROVIDER[providerId]
    : undefined;
  return piDefault && modelIds.includes(piDefault) ? piDefault : modelIds[0];
}
