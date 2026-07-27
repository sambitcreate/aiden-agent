import { resolveProviderIconSlug, type ProviderIconSlug } from "../lib/pi-provider-display";
import { cn } from "../lib/ui-utils";

const PROVIDER_ICON_URLS: Readonly<Record<ProviderIconSlug, string>> = {
  "amazon-bedrock": new URL("../assets/provider-logos/amazon-bedrock.svg", import.meta.url).href,
  "ant-ling": new URL("../assets/provider-logos/ant-ling.svg", import.meta.url).href,
  anthropic: new URL("../assets/provider-logos/anthropic.svg", import.meta.url).href,
  "apple-foundation-models": new URL(
    "../assets/provider-logos/apple-foundation-models.svg",
    import.meta.url,
  ).href,
  "azure-openai-responses": new URL(
    "../assets/provider-logos/azure-openai-responses.svg",
    import.meta.url,
  ).href,
  cerebras: new URL("../assets/provider-logos/cerebras.svg", import.meta.url).href,
  claude: new URL("../assets/provider-logos/claude.svg", import.meta.url).href,
  "cloudflare-ai-gateway": new URL(
    "../assets/provider-logos/cloudflare-ai-gateway.svg",
    import.meta.url,
  ).href,
  "cloudflare-workers-ai": new URL(
    "../assets/provider-logos/cloudflare-workers-ai.svg",
    import.meta.url,
  ).href,
  deepseek: new URL("../assets/provider-logos/deepseek.svg", import.meta.url).href,
  fireworks: new URL("../assets/provider-logos/fireworks.svg", import.meta.url).href,
  "github-copilot": new URL("../assets/provider-logos/github-copilot.svg", import.meta.url).href,
  google: new URL("../assets/provider-logos/google.svg", import.meta.url).href,
  "google-vertex": new URL("../assets/provider-logos/google-vertex.svg", import.meta.url).href,
  grok: new URL("../assets/provider-logos/grok.svg", import.meta.url).href,
  groq: new URL("../assets/provider-logos/groq.svg", import.meta.url).href,
  huggingface: new URL("../assets/provider-logos/huggingface.svg", import.meta.url).href,
  "kimi-coding": new URL("../assets/provider-logos/kimi-coding.svg", import.meta.url).href,
  lmstudio: new URL("../assets/provider-logos/lmstudio.svg", import.meta.url).href,
  minimax: new URL("../assets/provider-logos/minimax.svg", import.meta.url).href,
  "minimax-cn": new URL("../assets/provider-logos/minimax-cn.svg", import.meta.url).href,
  mistral: new URL("../assets/provider-logos/mistral.svg", import.meta.url).href,
  moonshotai: new URL("../assets/provider-logos/moonshotai.svg", import.meta.url).href,
  "moonshotai-cn": new URL("../assets/provider-logos/moonshotai-cn.svg", import.meta.url).href,
  nvidia: new URL("../assets/provider-logos/nvidia.svg", import.meta.url).href,
  ollama: new URL("../assets/provider-logos/ollama.svg", import.meta.url).href,
  openai: new URL("../assets/provider-logos/openai.svg", import.meta.url).href,
  "openai-codex": new URL("../assets/provider-logos/openai-codex.svg", import.meta.url).href,
  opencode: new URL("../assets/provider-logos/opencode.svg", import.meta.url).href,
  "opencode-go": new URL("../assets/provider-logos/opencode-go.svg", import.meta.url).href,
  openrouter: new URL("../assets/provider-logos/openrouter.svg", import.meta.url).href,
  together: new URL("../assets/provider-logos/together.svg", import.meta.url).href,
  "vercel-ai-gateway": new URL("../assets/provider-logos/vercel-ai-gateway.svg", import.meta.url)
    .href,
  xai: new URL("../assets/provider-logos/xai.svg", import.meta.url).href,
  xiaomi: new URL("../assets/provider-logos/xiaomi.svg", import.meta.url).href,
  "xiaomi-token-plan-ams": new URL(
    "../assets/provider-logos/xiaomi-token-plan-ams.svg",
    import.meta.url,
  ).href,
  "xiaomi-token-plan-cn": new URL(
    "../assets/provider-logos/xiaomi-token-plan-cn.svg",
    import.meta.url,
  ).href,
  "xiaomi-token-plan-sgp": new URL(
    "../assets/provider-logos/xiaomi-token-plan-sgp.svg",
    import.meta.url,
  ).href,
  zai: new URL("../assets/provider-logos/zai.svg", import.meta.url).href,
  "zai-coding-cn": new URL("../assets/provider-logos/zai-coding-cn.svg", import.meta.url).href,
};

const MULTICOLOR_PROVIDER_ICON_SLUGS = new Set<ProviderIconSlug>([
  "ant-ling",
  "fireworks",
  "groq",
  "opencode",
  "opencode-go",
  "together",
  "zai",
  "zai-coding-cn",
]);

export function ProviderIcon({
  providerId,
  providerLabel,
  modelId,
  className,
}: {
  providerId: string;
  providerLabel: string;
  modelId?: string;
  className?: string;
}) {
  const slug = resolveProviderIconSlug(providerId, modelId);
  const iconUrl = slug ? PROVIDER_ICON_URLS[slug] : undefined;

  if (!iconUrl) {
    const initial = providerLabel.trim().charAt(0).toLocaleUpperCase() || "?";
    return (
      <span
        aria-hidden="true"
        data-provider-icon-fallback={providerId}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-[28%] bg-control text-[0.62em] font-semibold leading-none text-secondary",
          className,
        )}
      >
        {initial}
      </span>
    );
  }

  if (slug && MULTICOLOR_PROVIDER_ICON_SLUGS.has(slug)) {
    return (
      <img
        alt=""
        aria-hidden="true"
        data-provider-icon={slug}
        draggable={false}
        src={iconUrl}
        className={cn("shrink-0 object-contain", className)}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      data-provider-icon={slug}
      className={cn("inline-block shrink-0", className)}
      style={{
        backgroundColor: "currentColor",
        WebkitMaskImage: `url("${iconUrl}")`,
        maskImage: `url("${iconUrl}")`,
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}
