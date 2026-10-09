export interface LanguageCapableModel {
  languages: readonly string[];
  capabilities: { autoDetect: boolean; translateToEnglish: boolean };
}

const ALIASES: Record<string, string> = { nb: "no", fil: "tl", iw: "he", in: "id" };

export function normalizeLanguageIntent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  if (lower === "auto") return "auto";
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(lower) ? lower : undefined;
}

function autoChoice(model: LanguageCapableModel): string | null {
  if (model.capabilities.autoDetect) return null;
  return model.languages.includes("en") ? "en" : (model.languages[0] ?? "en");
}

/** Resolve a user's language intent for one model at the point of use; never persisted. */
export function effectiveLanguage(
  model: LanguageCapableModel,
  intent: string | undefined,
): { language: string | null; fallback: string | null } {
  const normalized = normalizeLanguageIntent(intent) ?? "auto";
  if (normalized === "auto") return { language: autoChoice(model), fallback: null };
  const base = normalized.split("-")[0]!;
  for (const candidate of [normalized, base, ALIASES[base]]) {
    if (candidate && model.languages.includes(candidate)) return { language: candidate, fallback: null };
  }
  const chosen = autoChoice(model);
  return { language: chosen, fallback: chosen ?? "auto" };
}

export function effectiveTask(
  model: LanguageCapableModel,
  translate: boolean,
  source: string | null,
): "transcribe" | "translate" {
  return translate && model.capabilities.translateToEnglish && source !== null && source !== "en"
    ? "translate"
    : "transcribe";
}
