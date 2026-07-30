import { createHash } from "node:crypto";
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_DEFAULT_MODELS } from "./anthropic-provider.js";
import { customProviderId, isCustomProviderId } from "./custom-provider-id.js";
import {
  GOOGLE_BASE_URL,
  GOOGLE_DEFAULT_MODEL,
  GOOGLE_PROVIDER_ID,
  googleProviderModelMetadata,
  googleProviderModelIds,
} from "./google-provider.js";
import { MAX_CONFIG_ID_LENGTH, type AppSettings, type StoredProvider } from "./types.js";
import { migrateLegacyPiProviderId } from "../../renderer/shared/google-provider.js";

/** IDs Aiden persisted before Pi became the cloud-provider authority. */
const LEGACY_PI_PROVIDER_IDS = new Set([
  "openai",
  "anthropic",
  GOOGLE_PROVIDER_ID,
  "gemini",
  "deepseek",
  "moonshot",
]);

const LEGACY_PI_BASE_URLS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: GOOGLE_BASE_URL,
  gemini: GOOGLE_BASE_URL,
  deepseek: "https://api.deepseek.com/v1",
  moonshot: "https://api.moonshot.ai/v1",
};

const LEGACY_PRESET_MODELS: Readonly<Record<string, readonly string[]>> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
  anthropic: ANTHROPIC_DEFAULT_MODELS,
  google: googleProviderModelIds(),
  gemini: googleProviderModelIds(),
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  moonshot: ["kimi-k2-0711-preview", "moonshot-v1-128k", "moonshot-v1-32k"],
};

/** The only older stock list we can safely recognize as Aiden's own preset. */
const LEGACY_ANTHROPIC_PRESET_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-latest",
  "claude-3-5-haiku-latest",
] as const;

const LEGACY_PRESET_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  openai: "gpt-4o",
  anthropic: ANTHROPIC_DEFAULT_MODEL,
  google: GOOGLE_DEFAULT_MODEL,
  gemini: GOOGLE_DEFAULT_MODEL,
  deepseek: "deepseek-chat",
  moonshot: "kimi-k2-0711-preview",
};

const LEGACY_PRESET_LABELS: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic (Claude)",
  google: "Google Gemini",
  gemini: "Google Gemini",
  deepseek: "DeepSeek",
  moonshot: "Moonshot (Kimi)",
};

export interface ProviderConfigMigrationShape {
  providers: StoredProvider[];
  settings: Pick<AppSettings, "lastProviderId">;
  /** Legacy custom ID -> reserved custom ID. Persisted so every consumer agrees. */
  providerIdAliases?: Record<string, string>;
}

function exactlyEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasOnlyExpectedMetadata(provider: StoredProvider): boolean {
  if (provider.id === GOOGLE_PROVIDER_ID || provider.id === "gemini") {
    return JSON.stringify(provider.modelMetadata) === JSON.stringify(googleProviderModelMetadata());
  }
  return !provider.modelMetadata || Object.keys(provider.modelMetadata).length === 0;
}

function hasExpectedPresetModels(provider: StoredProvider, models: readonly string[]): boolean {
  if (exactlyEqual(provider.models, models)) return true;
  return (
    provider.id === "anthropic" &&
    provider.defaultModel === LEGACY_ANTHROPIC_PRESET_MODELS[0] &&
    exactlyEqual(provider.models, LEGACY_ANTHROPIC_PRESET_MODELS)
  );
}

function hasExpectedPresetDefault(provider: StoredProvider, expected: string): boolean {
  return (
    provider.defaultModel === expected ||
    (provider.id === "anthropic" && provider.defaultModel === LEGACY_ANTHROPIC_PRESET_MODELS[0])
  );
}

/**
 * Remove only a byte-for-byte logical seeded preset. A user-saved model list,
 * default, label, auth requirement, deployment, or metadata is a real custom
 * connection even when it still points at the vendor's canonical URL.
 */
function isUntouchedPiPreset(provider: StoredProvider): boolean {
  const id = provider.id;
  const models = LEGACY_PRESET_MODELS[id];
  return Boolean(
    provider.isPreset === true &&
    provider.baseUrl === LEGACY_PI_BASE_URLS[id] &&
    provider.label === LEGACY_PRESET_LABELS[id] &&
    hasExpectedPresetDefault(provider, LEGACY_PRESET_DEFAULT_MODELS[id]) &&
    provider.needsKey === true &&
    provider.deployment === "hosted" &&
    models &&
    hasExpectedPresetModels(provider, models) &&
    hasOnlyExpectedMetadata(provider),
  );
}

function uniqueCustomId(sourceId: string, usedIds: Set<string>): string {
  const unbounded = customProviderId(sourceId);
  const digest = createHash("sha256").update(unbounded).digest("hex").slice(0, 12);
  const base =
    unbounded.length <= MAX_CONFIG_ID_LENGTH
      ? unbounded
      : `${unbounded.slice(0, MAX_CONFIG_ID_LENGTH - digest.length - 1)}-${digest}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    const collisionSuffix = `-${suffix++}`;
    candidate = `${base.slice(0, MAX_CONFIG_ID_LENGTH - collisionSuffix.length)}${collisionSuffix}`;
  }
  usedIds.add(candidate);
  return candidate;
}

function setAlias(aliases: Record<string, string>, source: string, target: string): void {
  Object.defineProperty(aliases, source, {
    value: target,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function ownAlias(aliases: Readonly<Record<string, string>>, source: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(aliases, source) ? aliases[source] : undefined;
}

function terminalAlias(
  aliases: Readonly<Record<string, string>>,
  source: string,
): string | undefined {
  let cursor = source;
  let target = ownAlias(aliases, cursor);
  if (target === undefined) return undefined;
  const visited = new Set([source]);
  while (target !== undefined) {
    if (visited.has(target)) return undefined;
    visited.add(target);
    cursor = target;
    target = ownAlias(aliases, cursor);
  }
  return cursor;
}

function flattenAliasTargets(aliases: Record<string, string>): void {
  for (const source of Object.keys(aliases)) {
    const terminal = terminalAlias(aliases, source);
    if (terminal !== undefined) setAlias(aliases, source, terminal);
  }
}

/**
 * Remove old cloud presets so Pi is their sole authority. Every retained
 * connection gets an Aiden-reserved ID, preventing a future Pi provider from
 * claiming its endpoint or historical chats.
 */
export function migratePiProviderConfig(config: ProviderConfigMigrationShape): boolean {
  const beforeProviders = JSON.stringify(config.providers);
  const beforeAliases = JSON.stringify(config.providerIdAliases ?? {});
  const aliases = Object.fromEntries(Object.entries(config.providerIdAliases ?? {}));
  const usedIds = new Set([
    ...config.providers.map((provider) => provider.id),
    ...Object.keys(aliases),
    ...Object.values(aliases),
  ]);

  config.providers = config.providers.flatMap((provider) => {
    const isLegacyPiProvider = LEGACY_PI_PROVIDER_IDS.has(provider.id);
    if (isLegacyPiProvider && isUntouchedPiPreset(provider)) return [];

    // Old localhost entries and all historic custom connections must be moved
    // into the reserved namespace. A retained edited preset is custom too.
    if (!isCustomProviderId(provider.id)) {
      const sourceId = provider.id;
      const customId = uniqueCustomId(
        isLegacyPiProvider ? `${sourceId}-legacy` : sourceId,
        usedIds,
      );
      setAlias(aliases, sourceId, customId);
      return [
        {
          ...provider,
          id: customId,
          label: isLegacyPiProvider ? `${provider.label} (custom)` : provider.label,
          isPreset: false,
          isBuiltin: false,
        },
      ];
    }

    return [{ ...provider, isPreset: false, isBuiltin: false }];
  });
  // Preserve every historical source while compressing its route to the same
  // terminal provider. This keeps a maximum-depth accepted graph inside the
  // schema when migration adds one final legacy-provider alias.
  flattenAliasTargets(aliases);

  const previousProviderId = config.settings.lastProviderId;
  const migratedProviderId =
    (previousProviderId ? terminalAlias(aliases, previousProviderId) : undefined) ??
    migrateLegacyPiProviderId(previousProviderId);
  if (migratedProviderId !== previousProviderId)
    config.settings.lastProviderId = migratedProviderId;
  config.providerIdAliases = aliases;

  return (
    migratedProviderId !== previousProviderId ||
    JSON.stringify(config.providers) !== beforeProviders ||
    JSON.stringify(aliases) !== beforeAliases
  );
}
