import type { ModelInfo } from "./types";

const FORMAT_RE = /[\s._:-](MLX|GGUF|GGML|FP16|BF16|F16|INT8|AWQ|GPTQ|Q\d(?:_[A-Z0-9]+)*)$/iu;
const SPLIT_VERSION_FAMILIES = /\b(claude|gemini|gpt|llama|mistral|qwen)-(\d+)-(\d+)(?=-|$)/giu;
const JOINED_VERSION_FAMILIES = /\b(gemma|llama|mixtral|phi|qwen)(\d)/giu;
const DATE_SEGMENT = /(?:^|[-_])20\d{6}(?=$|[-_])/gu;

const CANONICAL_TOKEN = new Map<string, string>([
  ["ai", "AI"],
  ["claude", "Claude"],
  ["deepseek", "DeepSeek"],
  ["gemini", "Gemini"],
  ["gemma", "Gemma"],
  ["glm", "GLM"],
  ["gpt", "GPT"],
  ["kimi", "Kimi"],
  ["llama", "Llama"],
  ["minimax", "MiniMax"],
  ["mistral", "Mistral"],
  ["mtp", "MTP"],
  ["moonshot", "Moonshot"],
  ["qat", "QAT"],
  ["qwen", "Qwen"],
  ["ud", "UD"],
  ["vl", "VL"],
]);

function formatToken(value: string): string {
  const lower = value.toLocaleLowerCase();
  const canonical = CANONICAL_TOKEN.get(lower);
  if (canonical) return canonical;
  if (/^\d+(?:\.\d+)?[bkm]$/iu.test(value)) {
    return value.slice(0, -1) + value.slice(-1).toLocaleUpperCase();
  }
  if (/^[a-z]\d+(?:\.\d+)?[bm]$/iu.test(value)) {
    return value.charAt(0).toLocaleUpperCase() +
      value.slice(1, -1) +
      value.slice(-1).toLocaleUpperCase();
  }
  if (/^[vkmq]\d+(?:\.\d+)?$/iu.test(value)) return value.toLocaleUpperCase();
  return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
}

/** Human-readable fallback for local or newly released IDs absent from the snapshot. */
export function humanizeModelId(modelId: string): string {
  const leaf = modelId.slice(modelId.lastIndexOf("/") + 1);
  const withoutDate = leaf.replace(DATE_SEGMENT, "-");
  const withVersions = withoutDate
    .replace(SPLIT_VERSION_FAMILIES, "$1-$2.$3")
    .replace(JOINED_VERSION_FAMILIES, "$1-$2");
  const words = withVersions.split(/[-_:]+/u).filter(Boolean);
  return words.map(formatToken).join(" ") || modelId;
}

export interface ModelDisplay {
  label: string;
  format: string | null;
}

/** Prefer models.dev's canonical name while retaining local quantization tags. */
export function resolveModelDisplay(
  modelId: string,
  info?: Pick<ModelInfo, "name">,
): ModelDisplay {
  const match = modelId.match(FORMAT_RE);
  const baseId = match?.index === undefined ? modelId : modelId.slice(0, match.index);
  const officialName = info?.name?.trim();
  return {
    label: officialName || humanizeModelId(baseId),
    format: match?.[1]?.toLocaleUpperCase() ?? null,
  };
}
