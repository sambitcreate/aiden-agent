/**
 * Antigravity model catalog projection.
 *
 * Adapted from pi-antigravity-acp-provider src/models.ts @ 07e369b (MIT).
 * Antigravity publishes one model id per effort tier (`gemini-3.8-flash-low`,
 * `…-medium`, `…-high`). Aiden shows one model and selects the tier through
 * its thinking control, so effort variants collapse into a single entry whose
 * `thinkingLevelMap` holds the exact native ids.
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { Api, Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_API = "antigravity-acp" as Api;

type Effort = "low" | "medium" | "high";
type Variants = Partial<Record<Effort, string>>;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface NativeModelChoice {
  value: string;
  name: string;
}

function baseModel(id: string, name: string, thinkingLevelMap?: ThinkingLevelMap): Model<Api> {
  return {
    id,
    name,
    api: ANTIGRAVITY_API,
    provider: ANTIGRAVITY_PROVIDER_ID,
    baseUrl: "",
    reasoning: thinkingLevelMap !== undefined,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  };
}

function reasoningModel(id: string, name: string, variants: Variants): Model<Api> {
  return baseModel(id, name, {
    off: null,
    minimal: null,
    low: variants.low ?? null,
    medium: variants.medium ?? null,
    high: variants.high ?? null,
    xhigh: null,
    max: null,
  });
}

/** Shown until the first authenticated discovery replaces it. */
export function fallbackAntigravityModels(): Model<Api>[] {
  return [
    reasoningModel("gemini-3.8-flash", "Gemini 3.8 Flash", {
      low: "gemini-3.8-flash-low",
      medium: "gemini-3.8-flash-medium",
      high: "gemini-3.8-flash-high",
    }),
    reasoningModel("gemini-3.1-pro", "Gemini 3.1 Pro", {
      low: "gemini-3.1-pro-low",
      high: "gemini-pro-agent",
    }),
  ];
}

function validId(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false;
  return Array.from(id).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  });
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .map((part) => (part === "gemini" ? "Gemini" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function effortOf(choice: NativeModelChoice): { base: string; effort: Effort } | undefined {
  const byName = choice.name.trim().match(/^(.+?)\s*\((low|medium|high)\)$/iu);
  if (byName?.[1] && byName[2]) return { base: byName[1].trim(), effort: byName[2].toLowerCase() as Effort };
  const byId = choice.value.match(/^(.+)-(low|medium|high)$/u);
  if (byId?.[1] && byId[2]) return { base: titleFromId(byId[1]), effort: byId[2] as Effort };
  return undefined;
}

function canonicalId(name: string, variants: Variants): string {
  const bases = Object.values(variants)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/-(?:low|medium|high)$/u, ""));
  if (bases.length > 0 && bases.every((value) => value === bases[0])) return bases[0]!;
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function projectNativeModels(choices: readonly NativeModelChoice[]): Model<Api>[] {
  const safe = choices.filter((choice) => validId(choice.value.trim()));
  const groups = new Map<string, { name: string; variants: Variants; members: string[] }>();
  for (const choice of safe) {
    const parsed = effortOf(choice);
    if (!parsed) continue;
    const key = parsed.base.toLowerCase();
    const group = groups.get(key) ?? { name: parsed.base, variants: {}, members: [] };
    group.variants[parsed.effort] = choice.value.trim();
    group.members.push(choice.value.trim());
    groups.set(key, group);
  }
  const emittedGroups = new Set<string>();
  const emitted = new Set<string>();
  const output: Model<Api>[] = [];
  for (const choice of safe) {
    const id = choice.value.trim();
    if (emitted.has(id)) continue;
    const parsed = effortOf(choice);
    const key = parsed?.base.toLowerCase();
    const group = key ? groups.get(key) : undefined;
    if (key && group && Object.keys(group.variants).length >= 2) {
      if (emittedGroups.has(key)) continue;
      emittedGroups.add(key);
      for (const member of group.members) emitted.add(member);
      output.push(reasoningModel(canonicalId(group.name, group.variants), group.name, group.variants));
      continue;
    }
    emitted.add(id);
    output.push(baseModel(id, choice.name.trim() || id));
  }
  return output;
}

export function modelChoicesFromConfig(options: readonly SessionConfigOption[]): {
  configId?: string;
  choices: NativeModelChoice[];
} {
  const option = options.find(
    (candidate) => (candidate.category === "model" || candidate.id === "model") && candidate.type === "select",
  );
  if (!option || option.type !== "select") return { choices: [] };
  const choices: NativeModelChoice[] = [];
  for (const entry of option.options) {
    if ("value" in entry) choices.push({ value: entry.value, name: entry.name });
    else for (const nested of entry.options) choices.push({ value: nested.value, name: nested.name });
  }
  return { configId: option.id, choices };
}

/** The exact native id for Aiden's model and thinking level; unsupported tiers clamp to the nearest. */
export function nativeAntigravityModelId(model: Model<Api>, reasoning: ThinkingLevel | undefined): string {
  const map = model.thinkingLevelMap;
  if (!model.reasoning || !map) return model.id;
  const preferred: Effort =
    reasoning === "minimal" || reasoning === "low"
      ? "low"
      : reasoning === "high" || reasoning === "xhigh" || reasoning === "max"
        ? "high"
        : "medium";
  const order: Effort[] =
    preferred === "low"
      ? ["low", "medium", "high"]
      : preferred === "high"
        ? ["high", "medium", "low"]
        : ["medium", "high", "low"];
  for (const effort of order) {
    const value = map[effort];
    if (typeof value === "string" && value) return value;
  }
  return model.id;
}
