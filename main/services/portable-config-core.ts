// Splits Aiden's persisted configuration into a portable half and a
// machine-local half, and migrates existing installs into that layout once.
//
//   <portable root>/config.json          portable: provider intent, aliases,
//                                        MCP servers, skills. The user's to edit.
//   <local root>/settings.json           UI preferences for this machine.
//   <local root>/config.json             workspaces + seeding/migration markers.
//   <local root>/provider-model-cache.json  regenerable model discovery results.
//
// Secrets (provider-keys.json, pi-provider-credentials.json, mcp-oauth.json)
// are safeStorage-bound and never leave the local root, so a portable config
// carried to a second machine lists its providers with `hasKey: false` until the
// keys are re-entered there. That is intended, not a defect.
//
// Platform-independent by design: both roots are injected, so the whole
// migration is exercisable against temp directories without Electron.

import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { DataStore, DataStoreExternalChangeError } from "./data-store.js";
import { isGenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import { assistantConfigFrom } from "../handlers/assistant-parse.js";
import { parseGoogleThinkingPreferences } from "../../renderer/shared/google-thinking.js";
import { parseCodexThinkingPreferences } from "../../renderer/shared/codex-thinking.js";
import { parseAnthropicThinkingPreferences } from "../../renderer/shared/anthropic-thinking.js";
import type {
  AppSettings,
  McpServer,
  ProviderModelMetadata,
  Skill,
  StoredProvider,
  Workspace,
} from "./types.js";
import { MAX_CONFIG_ID_LENGTH, MAX_PROVIDER_BASE_URL_LENGTH } from "./types.js";
import { decodeUtf8, readRegularFile } from "./regular-file-read.js";

/** A provider minus the caches that model discovery refills. */
export type PortableProvider = Omit<StoredProvider, "models" | "modelMetadata">;

/** The hand-editable file. Keep every field here machine-independent. */
export interface PortableConfigShape {
  providers: PortableProvider[];
  /** Historic custom ID -> reserved custom ID. Never expose a Pi collision again. */
  providerIdAliases: Record<string, string>;
  mcpServers: McpServer[];
  skills: Skill[];
}

export interface SettingsShape {
  settings: AppSettings;
}

export interface LocalConfigShape {
  /** Absolute folder paths and git identities — meaningful only on this machine. */
  workspaces: Workspace[];
  /** True once the first-ever launch reset the provider list. Predates ~/.aiden. */
  seeded: boolean;
  /** Set once the ~/.aiden split has run. Deliberately not `seeded`. */
  aidenDirMigratedAt?: number;
}

export interface ProviderModelCacheEntry {
  models?: string[];
  modelMetadata?: Record<string, ProviderModelMetadata>;
}

export interface ProviderModelCacheShape {
  byProvider: Record<string, ProviderModelCacheEntry>;
}

export function mergeProviderModelCacheEntries(
  fallback: ProviderModelCacheEntry | undefined,
  preferred: ProviderModelCacheEntry | undefined,
): ProviderModelCacheEntry {
  const merged: ProviderModelCacheEntry = {};
  if (fallback?.models !== undefined) merged.models = fallback.models;
  if (preferred?.models !== undefined) merged.models = preferred.models;
  if (fallback?.modelMetadata !== undefined || preferred?.modelMetadata !== undefined) {
    merged.modelMetadata = {
      ...fallback?.modelMetadata,
      ...preferred?.modelMetadata,
    };
  }
  return merged;
}

/** Shape of the pre-split config.json. Every field optional on read. */
interface LegacyConfigShape {
  providers?: StoredProvider[];
  providerIdAliases?: Record<string, string>;
  settings?: AppSettings;
  mcpServers?: McpServer[];
  skills?: Skill[];
  workspaces?: Workspace[];
  seeded?: boolean;
}

export const PORTABLE_CONFIG_FILENAME = "config.json";
export const SETTINGS_FILENAME = "settings.json";
export const LOCAL_CONFIG_FILENAME = "config.json";
export const PROVIDER_MODEL_CACHE_FILENAME = "provider-model-cache.json";
export const PORTABLE_README_FILENAME = "README.md";
/** Where the pre-split config.json is parked once its contents are consumed. */
export const LEGACY_CONFIG_ARCHIVE_SUFFIX = ".pre-aiden-dir";

export function emptyPortableConfig(): PortableConfigShape {
  return { providers: [], providerIdAliases: {}, mcpServers: [], skills: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function ownStringEntry(record: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function ownRecordEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function setRecordEntry<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function hasUniqueIds(values: ReadonlyArray<{ id: string }>): boolean {
  return new Set(values.map(({ id }) => id)).size === values.length;
}

export const MAX_PROVIDER_ALIAS_COUNT = 4_096;
export const MAX_PROVIDER_ALIAS_DEPTH = 256;

function providerAliasResolutions(
  aliases: Readonly<Record<string, string>>,
): Map<string, { terminal: string; depth: number }> | null {
  const resolved = new Map<string, { terminal: string; depth: number }>();
  const resolving = new Set<string>();
  const visit = (source: string, depth: number): { terminal: string; depth: number } | null => {
    const cached = resolved.get(source);
    if (cached) return cached;
    if (depth > MAX_PROVIDER_ALIAS_DEPTH || resolving.has(source)) return null;
    const target = ownStringEntry(aliases, source);
    if (target === undefined) return { terminal: source, depth: 0 };
    resolving.add(source);
    const downstream = visit(target, depth + 1);
    resolving.delete(source);
    if (!downstream || downstream.depth + 1 > MAX_PROVIDER_ALIAS_DEPTH) return null;
    const result = { terminal: downstream.terminal, depth: downstream.depth + 1 };
    resolved.set(source, result);
    return result;
  };

  for (const source of Object.keys(aliases)) {
    if (!visit(source, 0)) return null;
  }
  return resolved;
}

export function isProviderAliasMap(value: unknown): value is Record<string, string> {
  if (!isStringMap(value)) return false;
  const aliases = value;
  const entries = Object.entries(aliases);
  if (entries.length > MAX_PROVIDER_ALIAS_COUNT) return false;
  for (const [source, target] of entries) {
    if (
      !source.trim() ||
      !target.trim() ||
      source.length > MAX_CONFIG_ID_LENGTH ||
      target.length > MAX_CONFIG_ID_LENGTH ||
      source === target
    ) {
      return false;
    }
  }
  return providerAliasResolutions(aliases) !== null;
}

/** Resolve an accepted alias chain without consulting inherited object keys. */
export function resolveProviderAlias(
  aliases: Readonly<Record<string, string>>,
  providerId: string,
): string | undefined {
  let cursor = providerId;
  let target: string | undefined;
  let depth = 0;
  const visited = new Set<string>();
  while ((target = ownStringEntry(aliases, cursor)) !== undefined) {
    if (visited.has(cursor) || depth >= MAX_PROVIDER_ALIAS_DEPTH) return undefined;
    visited.add(cursor);
    cursor = target;
    depth += 1;
  }
  return cursor === providerId ? undefined : cursor;
}

export function resolvedProviderAliasRoutes(
  aliases: Readonly<Record<string, string>>,
): Array<readonly [source: string, target: string, depth: number]> {
  const resolutions = providerAliasResolutions(aliases);
  if (!resolutions) return [];
  return [...resolutions].map(([source, { terminal, depth }]) => [source, terminal, depth]);
}

export function providerAliasSourcesAreInactive(
  aliases: Readonly<Record<string, string>>,
  providers: ReadonlyArray<{ id: string }>,
): boolean {
  const active = new Set(providers.map(({ id }) => id));
  return Object.keys(aliases).every((source) => !active.has(source));
}

function isManagedWorktree(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.repositoryPath === "string" &&
    path.isAbsolute(value.repositoryPath) &&
    typeof value.worktreePath === "string" &&
    path.isAbsolute(value.worktreePath) &&
    typeof value.branch === "string" &&
    typeof value.createdFromHead === "string" &&
    (value.worktreeGitDir === undefined ||
      (typeof value.worktreeGitDir === "string" && path.isAbsolute(value.worktreeGitDir))) &&
    (value.ownershipToken === undefined || typeof value.ownershipToken === "string") &&
    (value.worktreeDevice === undefined ||
      (typeof value.worktreeDevice === "number" &&
        Number.isSafeInteger(value.worktreeDevice) &&
        value.worktreeDevice >= 0)) &&
    (value.worktreeInode === undefined ||
      (typeof value.worktreeInode === "number" &&
        Number.isSafeInteger(value.worktreeInode) &&
        value.worktreeInode >= 0))
  );
}

function isWorkspace(value: unknown): value is Workspace {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.name === "string" &&
    (value.permission === "full" || value.permission === "ask" || value.permission === "none") &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    (value.folderPath === undefined ||
      (typeof value.folderPath === "string" && path.isAbsolute(value.folderPath))) &&
    (value.managedWorktree === undefined || isManagedWorktree(value.managedWorktree))
  );
}

export function isMcpServer(value: unknown): value is McpServer {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    value.id.length <= MAX_CONFIG_ID_LENGTH &&
    typeof value.name === "string" &&
    (value.transport === "stdio" || value.transport === "http" || value.transport === "sse") &&
    typeof value.enabled === "boolean" &&
    (value.command === undefined || typeof value.command === "string") &&
    (value.args === undefined ||
      (Array.isArray(value.args) && value.args.every((entry) => typeof entry === "string"))) &&
    (value.env === undefined || isStringMap(value.env)) &&
    (value.url === undefined || typeof value.url === "string") &&
    (value.headers === undefined || isStringMap(value.headers)) &&
    (value.oauth === undefined || typeof value.oauth === "boolean") &&
    (value.presetId === undefined || typeof value.presetId === "string")
  );
}

export function isSkill(value: unknown): value is Skill {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.instructions === "string" &&
    typeof value.enabled === "boolean"
  );
}

export function isMcpServerList(value: unknown): value is McpServer[] {
  return Array.isArray(value) && value.every(isMcpServer) && hasUniqueIds(value);
}

export function isSkillList(value: unknown): value is Skill[] {
  return Array.isArray(value) && value.every(isSkill) && hasUniqueIds(value);
}

function isProviderBaseUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_PROVIDER_BASE_URL_LENGTH
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function hasSensitiveProviderUrl(value: unknown): boolean {
  if (!isRecord(value) || typeof value.baseUrl !== "string") return false;
  try {
    const url = new URL(value.baseUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      Boolean(url.username || url.password || url.search || url.hash)
    );
  } catch {
    return false;
  }
}

/** Runtime guard for the provider intent that crosses the portable-file boundary. */
export function isPortableProvider(value: unknown): value is PortableProvider {
  if (!isRecord(value)) return false;
  const provider = value as Partial<PortableProvider>;
  return (
    typeof provider.id === "string" &&
    provider.id.trim().length > 0 &&
    provider.id.length <= MAX_CONFIG_ID_LENGTH &&
    (provider.kind === "openai" || provider.kind === "anthropic") &&
    typeof provider.label === "string" &&
    provider.label.trim().length > 0 &&
    isProviderBaseUrl(provider.baseUrl) &&
    typeof provider.needsKey === "boolean" &&
    (provider.defaultModel === undefined || typeof provider.defaultModel === "string") &&
    (provider.deployment === undefined ||
      provider.deployment === "local" ||
      provider.deployment === "hosted") &&
    (provider.isPreset === undefined || typeof provider.isPreset === "boolean") &&
    (provider.isBuiltin === undefined || typeof provider.isBuiltin === "boolean")
  );
}

/** A provider list is only safe when every connection has one unambiguous identity. */
export function isPortableProviderList(value: unknown): value is PortableProvider[] {
  if (!Array.isArray(value) || !value.every(isPortableProvider)) return false;
  return hasUniqueIds(value);
}

function isProviderModelMetadata(value: unknown): value is ProviderModelMetadata {
  if (!isRecord(value)) return false;
  return (
    (value.source === "lmstudio" || value.source === "ollama" || value.source === "provider") &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.type === undefined || value.type === "llm" || value.type === "embedding") &&
    (value.vision === undefined || typeof value.vision === "boolean") &&
    (value.toolCall === undefined || typeof value.toolCall === "boolean") &&
    (value.reasoning === undefined || typeof value.reasoning === "boolean") &&
    (value.thinkingLevels === undefined ||
      (Array.isArray(value.thinkingLevels) &&
        value.thinkingLevels.every(isGenerationThinkingLevel))) &&
    (value.thinkingCanDisable === undefined || typeof value.thinkingCanDisable === "boolean") &&
    (value.contextLength === undefined ||
      (typeof value.contextLength === "number" &&
        Number.isFinite(value.contextLength) &&
        value.contextLength >= 0)) &&
    (value.parameterCount === undefined || typeof value.parameterCount === "string") &&
    (value.format === undefined || typeof value.format === "string")
  );
}

function normalizeProviderModelMetadataMap(
  value: unknown,
): Record<string, ProviderModelMetadata> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  const safeEntries = entries.filter((entry): entry is [string, ProviderModelMetadata] =>
    isProviderModelMetadata(entry[1]),
  );
  if (entries.length > 0 && safeEntries.length === 0) return undefined;
  return Object.fromEntries(safeEntries);
}

function normalizeModelIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Array.from(
    new Set(
      value.filter(
        (model): model is string => typeof model === "string" && model.trim().length > 0,
      ),
    ),
  );
}

function runtimeAssistantSettings(settings: AppSettings): AppSettings["assistant"] {
  return Object.fromEntries(
    Object.entries(assistantConfigFrom(settings)).filter(([, entry]) => entry !== undefined),
  ) as AppSettings["assistant"];
}

function normalizeStoredProvider(value: unknown): StoredProvider | undefined {
  if (!isRecord(value) || !isPortableProvider(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const models = normalizeModelIds(raw.models) ?? [];
  const modelMetadata = normalizeProviderModelMetadataMap(raw.modelMetadata);
  const { modelMetadata: _metadata, models: _models, ...intent } = raw;
  return {
    ...(intent as PortableProvider),
    models,
    ...(modelMetadata !== undefined ? { modelMetadata } : {}),
  };
}

function normalizeLegacyMcpServers(value: unknown): McpServer[] {
  if (!Array.isArray(value)) return [];
  const valid = value.filter(isMcpServer);
  const counts = new Map<string, number>();
  for (const server of valid) counts.set(server.id, (counts.get(server.id) ?? 0) + 1);
  return valid.filter((server) => counts.get(server.id) === 1);
}

function normalizeLegacySkills(value: unknown): Skill[] {
  if (!Array.isArray(value)) return [];
  const valid = value.filter(isSkill);
  const counts = new Map<string, number>();
  for (const skill of valid) counts.set(skill.id, (counts.get(skill.id) ?? 0) + 1);
  return valid.filter((skill) => counts.get(skill.id) === 1);
}

function normalizeSettingsShape(value: unknown): SettingsShape {
  const root = isRecord(value) ? structuredClone(value) : {};
  const { settings, ...rest } = root;
  if (!isRecord(settings)) return { ...rest, settings: {} };

  const normalized = structuredClone(settings);
  const keepString = (key: keyof AppSettings): void => {
    if (typeof settings[key] !== "string") delete normalized[key];
  };
  const keepBoolean = (key: keyof AppSettings): void => {
    if (typeof settings[key] !== "boolean") delete normalized[key];
  };
  for (const key of [
    "lastProviderId",
    "lastModel",
    "voiceModel",
    "localVoiceModel",
    "shortcutAccelerator",
    "dictationAccelerator",
    "scheduledDefaultTimezone",
    "profileName",
  ] as const) {
    keepString(key);
  }
  for (const key of [
    "exaEnabled",
    "shortcutEnabled",
    "dictationEnabled",
    "computerUseEnabled",
    "scheduledTasksEnabled",
    "scheduledDefaultMcpEnabled",
    "scheduledDefaultNotify",
  ] as const) {
    keepBoolean(key);
  }
  for (const key of [
    "voiceProvider",
    "chatTitleProviderId",
    "scheduledDefaultMode",
    "scheduledDefaultPermission",
  ] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "string") {
      delete normalized[key];
    }
  }
  // Assistant, appearance, and keybindings are versioned/tolerant nested
  // documents. Runtime consumers project supported values separately; the
  // persistence normalizer must retain every raw property and future value.
  if (settings.assistant !== undefined) {
    if (isRecord(settings.assistant)) normalized.assistant = structuredClone(settings.assistant);
    else delete normalized.assistant;
  }
  for (const key of [
    "googleThinkingByModel",
    "codexThinkingByModel",
    "anthropicThinkingByModel",
  ] as const) {
    if (settings[key] !== undefined && !isRecord(settings[key])) delete normalized[key];
  }
  return {
    ...rest,
    settings: normalized as AppSettings,
  };
}

/** Safe projection for consumers; persistence retains unknown nested future data. */
export function runtimeSettingsFrom(settings: AppSettings): AppSettings {
  const runtime = structuredClone(settings);
  const retainKnownValue = (key: keyof AppSettings, allowed: readonly string[]): void => {
    const value = settings[key];
    if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
      delete runtime[key];
    }
  };
  retainKnownValue("voiceProvider", ["openai", "gemini", "local"]);
  retainKnownValue("chatTitleProviderId", ["automatic", "apple-foundation-models", "chat-model"]);
  retainKnownValue("scheduledDefaultMode", ["llm", "script"]);
  retainKnownValue("scheduledDefaultPermission", ["read-only", "full"]);
  if (settings.assistant !== undefined) {
    runtime.assistant = runtimeAssistantSettings(settings);
  }
  const projectThinkingMap = (
    key: "googleThinkingByModel" | "codexThinkingByModel" | "anthropicThinkingByModel",
    parse: (input: unknown) => Record<string, string>,
  ): void => {
    if (settings[key] === undefined) return;
    if (!isRecord(settings[key])) {
      delete runtime[key];
      return;
    }
    const safeEntries = Object.entries(settings[key])
      .slice(0, 256)
      .flatMap(([modelId, value]) => {
        try {
          return [[modelId, parse({ [modelId]: value })[modelId]]] as const;
        } catch {
          return [];
        }
      });
    if (safeEntries.length === 0) {
      delete runtime[key];
    } else {
      runtime[key] = Object.fromEntries(safeEntries) as never;
    }
  };
  projectThinkingMap("googleThinkingByModel", parseGoogleThinkingPreferences);
  projectThinkingMap("codexThinkingByModel", parseCodexThinkingPreferences);
  projectThinkingMap("anthropicThinkingByModel", parseAnthropicThinkingPreferences);
  return runtime;
}

function normalizeLocalConfigShape(value: unknown): LocalConfigShape {
  const root = isRecord(value) ? structuredClone(value) : {};
  const { workspaces, seeded, aidenDirMigratedAt, ...rest } = root;
  const validWorkspaces = Array.isArray(workspaces) ? workspaces.filter(isWorkspace) : [];
  const workspaceIdCounts = new Map<string, number>();
  for (const workspace of validWorkspaces) {
    workspaceIdCounts.set(workspace.id, (workspaceIdCounts.get(workspace.id) ?? 0) + 1);
  }
  return {
    ...rest,
    workspaces: validWorkspaces.filter((workspace) => workspaceIdCounts.get(workspace.id) === 1),
    seeded: seeded === true,
    ...(typeof aidenDirMigratedAt === "number" ? { aidenDirMigratedAt } : {}),
  };
}

function isLocalConfigShapeSafe(value: unknown): boolean {
  if (!isRecord(value) || value.workspaces === undefined) return true;
  return (
    Array.isArray(value.workspaces) &&
    value.workspaces.every(isWorkspace) &&
    hasUniqueIds(value.workspaces)
  );
}

function normalizeProviderModelCacheShape(value: unknown): ProviderModelCacheShape {
  const root = isRecord(value) ? structuredClone(value) : {};
  const { byProvider, ...rest } = root;
  const safeByProviderEntries: Array<[string, ProviderModelCacheEntry]> = [];
  if (isRecord(byProvider)) {
    for (const [providerId, rawEntry] of Object.entries(byProvider)) {
      if (!isRecord(rawEntry)) continue;
      const entry: ProviderModelCacheEntry = {};
      const models = normalizeModelIds(rawEntry.models);
      if (models !== undefined) entry.models = models;
      const modelMetadata = normalizeProviderModelMetadataMap(rawEntry.modelMetadata);
      if (modelMetadata !== undefined) {
        entry.modelMetadata = modelMetadata;
      }
      if (entry.models !== undefined || entry.modelMetadata !== undefined) {
        safeByProviderEntries.push([providerId, entry]);
      }
    }
  }
  return { ...rest, byProvider: Object.fromEntries(safeByProviderEntries) };
}

function sameProviderConnection(left: PortableProvider, right: PortableProvider): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.baseUrl === right.baseUrl &&
    left.needsKey === right.needsKey &&
    left.deployment === right.deployment
  );
}

async function fileEqualsContents(contents: Buffer, target: string): Promise<boolean> {
  try {
    return contents.equals(await readRegularFile(target));
  } catch {
    return false;
  }
}

async function writeFileAtomicallyIfAbsent(
  contents: Buffer,
  destination: string,
): Promise<boolean> {
  if (await exists(destination)) return false;
  const staged = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  let published = false;
  try {
    await fs.writeFile(staged, contents, { flag: "wx" });
    const stagedHandle = await fs.open(staged, "r");
    try {
      await stagedHandle.sync();
    } finally {
      await stagedHandle.close();
    }
    try {
      // A hard link publishes the fully copied sibling in one no-overwrite
      // operation. A crash before this point leaves only a disposable temp;
      // after it, the final archive necessarily names the complete file.
      await fs.link(staged, destination);
      published = true;
      const directoryHandle = await fs.open(path.dirname(destination), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await fs.rm(staged, { force: true }).catch(() => undefined);
  }
  return published;
}

async function ensureCompleteLegacyArchive(
  sourceContents: Buffer,
  destination: string,
): Promise<string> {
  if (await fileEqualsContents(sourceContents, destination)) return destination;
  if (await writeFileAtomicallyIfAbsent(sourceContents, destination)) return destination;
  if (await fileEqualsContents(sourceContents, destination)) return destination;

  // An older non-atomic migration may already have left the canonical archive
  // truncated, empty, or replaced by a non-file. Never overwrite it; preserve
  // the current complete source under a second atomically published name.
  const directory = path.dirname(destination);
  const recoveryPrefix = `${path.basename(destination)}.recovery-`;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith(recoveryPrefix)) continue;
    const candidate = path.join(directory, entry.name);
    if (await fileEqualsContents(sourceContents, candidate)) return candidate;
  }
  const recovery = `${destination}.recovery-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}-${randomUUID()}`;
  if (!(await writeFileAtomicallyIfAbsent(sourceContents, recovery))) {
    throw new Error("Could not preserve the legacy config recovery archive.");
  }
  return recovery;
}

async function legacyArchiveState(
  source: string,
  destination: string,
): Promise<{ hasUsableSnapshot: boolean; matchesSource: boolean }> {
  const candidates = [destination];
  const directory = path.dirname(destination);
  const recoveryPrefix = `${path.basename(destination)}.recovery-`;
  try {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(recoveryPrefix)) {
        candidates.push(path.join(directory, entry.name));
      }
    }
  } catch {
    // The canonical candidate below still establishes the ordinary state.
  }
  let hasUsableSnapshot = false;
  let sourceBytes: Buffer;
  try {
    sourceBytes = await readRegularFile(source);
  } catch {
    return { hasUsableSnapshot: false, matchesSource: false };
  }
  for (const candidate of candidates) {
    try {
      const candidateBytes = await readRegularFile(candidate);
      if (sourceBytes.equals(candidateBytes)) {
        return { hasUsableSnapshot: true, matchesSource: true };
      }
      const parsed = JSON.parse(decodeUtf8(candidateBytes));
      if (isRecord(parsed)) hasUsableSnapshot = true;
    } catch {
      // Truncated, linked, and special candidates do not prove a prior
      // authoritative snapshot and therefore cannot justify resurrection.
    }
  }
  return { hasUsableSnapshot, matchesSource: false };
}

// ── Provider intent / cache split ─────────────────────────────────────────────

/**
 * Separate a provider into portable intent and regenerable cache, carrying only
 * the keys the caller actually supplied so an upsert keeps the merge semantics
 * it had when all of this lived in one object.
 */
export function splitStoredProvider(provider: StoredProvider): {
  intent: PortableProvider;
  cache: ProviderModelCacheEntry;
} {
  const { models, modelMetadata, ...intent } = provider;
  const cache: ProviderModelCacheEntry = {};
  if ("models" in provider) cache.models = models;
  if ("modelMetadata" in provider) cache.modelMetadata = modelMetadata;
  return { intent, cache };
}

/** Recombine portable intent with this machine's discovery cache. */
export function composeStoredProvider(
  intent: PortableProvider,
  cache: ProviderModelCacheEntry | undefined,
): StoredProvider {
  // Runtime objects can come from hand-authored JSON despite the compile-time
  // Omit above. Never let portable cache fields bypass the validated local cache.
  const {
    models: _portableModels,
    modelMetadata: _portableMetadata,
    ...safeIntent
  } = intent as PortableProvider & Partial<StoredProvider>;
  const composed: StoredProvider = { ...safeIntent, models: cache?.models ?? [] };
  if (cache?.modelMetadata) composed.modelMetadata = cache.modelMetadata;
  return composed;
}

// ── Seeded README ─────────────────────────────────────────────────────────────

/**
 * Written next to config.json on first run. A template here rather than a repo
 * file because it documents a folder the user owns.
 */
export function portableReadme(): string {
  return `# ~/.aiden

This folder is yours. Aiden creates it on first run and re-reads it whenever the
window regains focus, so you can edit anything here by hand and the app picks the
change up without a restart.

## config.json

Your portable configuration. Copy it to another machine to take your setup with
you.

| Field | What it holds |
| --- | --- |
| \`providers\` | Custom provider connections: \`id\`, \`kind\`, \`label\`, \`baseUrl\`, \`needsKey\`, \`defaultModel\`, \`deployment\`. |
| \`providerIdAliases\` | Append-only record of provider IDs Aiden has renamed. Leave it alone unless you know why it exists. |
| \`mcpServers\` | MCP server definitions. |
| \`skills\` | Inline skills: \`name\`, \`description\`, \`instructions\`, \`enabled\`. |

Aiden rewrites this file when you change those settings in the UI, so it round
trips in both directions. Invalid JSON is ignored in favour of the built-in
defaults, and nothing is written back until you next change one of these settings
from the UI.

## What is deliberately not here

**API keys and OAuth tokens.** They are encrypted against this machine's keychain
and stay in Aiden's application-support folder. After copying \`config.json\` to a
new machine your providers appear with no key attached; re-enter them there.

**Model lists.** \`providers[].models\` is discovery output rather than
configuration, so it is cached per machine and refilled when you refresh a
provider's models.

**Workspaces, UI preferences, and chat history.** Workspaces point at absolute
folder paths and git worktrees that exist on one machine only, so they stay
machine-local along with your theme, sidebar, and window state.

## skill/ and skills/

Folder-based Agent Skills, one folder per skill with a \`SKILL.md\` inside:

\`\`\`
~/.aiden/skills/my-skill/SKILL.md
\`\`\`

These are separate from the \`skills\` array in \`config.json\`. The array holds
skills typed into Aiden's UI; these folders hold skills that live as files and can
be version-controlled. Both are offered to the agent.

## scripts/

Executables that scheduled tasks may run by name.
`;
}

// ── Store bundle ──────────────────────────────────────────────────────────────

export type PortableConfigStores = ReturnType<typeof createPortableConfigStores>;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

function appendMissingById<T extends { id: string }>(current: T[], recovered: T[]): T[] {
  const ids = new Set(current.map((item) => item.id));
  return [...current, ...recovered.filter((item) => !ids.has(item.id))];
}

function appendMissingSettings(
  current: Record<string, unknown>,
  recovered: Record<string, unknown>,
): Record<string, unknown> {
  const merged = structuredClone(current);
  for (const [key, recoveredValue] of Object.entries(recovered)) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      setRecordEntry(merged, key, structuredClone(recoveredValue));
      continue;
    }
    const currentValue = current[key];
    if (isRecord(currentValue) && isRecord(recoveredValue)) {
      setRecordEntry(merged, key, appendMissingSettings(currentValue, recoveredValue));
    }
  }
  return merged;
}

/**
 * Build the four stores plus the one-time migration that fills them.
 *
 * `localRoot` is left undefined by the Electron binding so DataStore falls back
 * to `app.getPath("userData")`; tests pass a temp directory instead.
 */
export function createPortableConfigStores(
  portableRoot: () => string,
  localRoot?: () => string,
  testHooks: {
    beforeLocalProtectedPublish?: () => Promise<void>;
    beforeLegacyArchive?: () => Promise<void>;
  } = {},
) {
  const portable = new DataStore<PortableConfigShape>(
    PORTABLE_CONFIG_FILENAME,
    emptyPortableConfig(),
    portableRoot,
    // This is the one file a person edits by hand, so a JSON typo must not be
    // silently overwritten with defaults the next time anything writes.
    {
      preserveCorruptFile: true,
      reloadBeforeWrite: true,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
      rejectExternalChanges: true,
    },
  );
  const settings = new DataStore<SettingsShape>(SETTINGS_FILENAME, { settings: {} }, localRoot, {
    normalize: normalizeSettingsShape,
    preserveCorruptFile: true,
    reloadBeforeWrite: true,
    rejectCorruptWrite: true,
    rejectExternalChanges: true,
  });
  const local = new DataStore<LocalConfigShape>(
    LOCAL_CONFIG_FILENAME,
    { workspaces: [], seeded: false },
    localRoot,
    {
      normalize: normalizeLocalConfigShape,
      isSafe: isLocalConfigShapeSafe,
      reloadBeforeWrite: true,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
      rejectExternalChanges: true,
      beforeProtectedPublish: testHooks.beforeLocalProtectedPublish,
    },
  );
  const modelCache = new DataStore<ProviderModelCacheShape>(
    PROVIDER_MODEL_CACHE_FILENAME,
    { byProvider: {} },
    localRoot,
    { normalize: normalizeProviderModelCacheShape },
  );

  let migrationPromise: Promise<boolean> | null = null;

  /** Seed the README if absent. Never overwrites a copy the user has edited. */
  async function ensureReadme(): Promise<void> {
    const target = path.join(portableRoot(), PORTABLE_README_FILENAME);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(target, portableReadme(), { encoding: "utf-8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  async function runMigration(): Promise<boolean> {
    const legacyPath = await local.path();
    const archivePath = `${legacyPath}${LEGACY_CONFIG_ARCHIVE_SUFFIX}`;
    // The legacy file *is* <localRoot>/config.json, so this read sees the
    // pre-split superset. The extra keys survive the cast and are picked off
    // below before the file is slimmed.
    const loaded = (await local.load()) as LocalConfigShape & LegacyConfigShape;
    if ((await local.loadedFromCorruptFile()) || (await local.loadedFromUnsafeFile())) {
      await ensureReadme();
      return false;
    }
    const loadedLegacyContents = await local.loadedDiskContents();
    if (typeof loaded.aidenDirMigratedAt === "number") return true;
    const legacy: LegacyConfigShape = loaded;

    const portablePath = await portable.path();
    const portableExists = await exists(portablePath);
    const loadedPortable = portableExists ? await portable.load() : {};
    if (portableExists && (await portable.loadedFromCorruptFile())) {
      await ensureReadme();
      return false;
    }
    if (portableExists && !isRecord(loadedPortable)) {
      await ensureReadme();
      return false;
    }
    const existingPortable = loadedPortable as Partial<PortableConfigShape>;
    const has = (key: string) => Object.prototype.hasOwnProperty.call(existingPortable, key);
    const existingProviders = existingPortable.providers;
    const validExistingProviders = isPortableProviderList(existingProviders)
      ? existingProviders
      : undefined;
    if (has("providers") && !validExistingProviders) {
      await ensureReadme();
      return false;
    }
    const existingAliases = existingPortable.providerIdAliases;
    const safeExistingAliases = isProviderAliasMap(existingAliases) ? existingAliases : undefined;
    if (has("providerIdAliases") && !safeExistingAliases) {
      await ensureReadme();
      return false;
    }
    if (
      safeExistingAliases &&
      validExistingProviders &&
      !providerAliasSourcesAreInactive(safeExistingAliases, validExistingProviders)
    ) {
      await ensureReadme();
      return false;
    }
    const safeExistingMcpServers = isMcpServerList(existingPortable.mcpServers)
      ? existingPortable.mcpServers
      : undefined;
    if (has("mcpServers") && !safeExistingMcpServers) {
      await ensureReadme();
      return false;
    }
    const safeExistingSkills = isSkillList(existingPortable.skills)
      ? existingPortable.skills
      : undefined;
    if (has("skills") && !safeExistingSkills) {
      await ensureReadme();
      return false;
    }

    // Do not archive a connection string containing embedded credentials or
    // URL-only state that the portable schema intentionally forbids.
    if (Array.isArray(legacy.providers) && legacy.providers.some(hasSensitiveProviderUrl)) {
      await ensureReadme();
      return false;
    }
    const structurallyValidLegacyProviders = Array.isArray(legacy.providers)
      ? legacy.providers.flatMap((candidate) => {
          const normalized = normalizeStoredProvider(candidate);
          return normalized ? [normalized] : [];
        })
      : [];
    const legacyProviderIdCounts = new Map<string, number>();
    for (const candidate of structurallyValidLegacyProviders) {
      legacyProviderIdCounts.set(candidate.id, (legacyProviderIdCounts.get(candidate.id) ?? 0) + 1);
    }
    const legacyProviders = structurallyValidLegacyProviders.filter(
      (candidate) => legacyProviderIdCounts.get(candidate.id) === 1,
    );
    const legacySplit = legacyProviders.map((provider) => splitStoredProvider(provider));
    // If an earlier attempt published the portable split and archived snapshot
    // A, but a descriptor edit changed the still-live legacy source to B before
    // slimming, the retry must surface B's non-conflicting additions instead of
    // merely filing them away in a recovery archive.
    const archiveState = await legacyArchiveState(legacyPath, archivePath);
    const recoveringLateLegacyEdit =
      portableExists && archiveState.hasUsableSnapshot && !archiveState.matchesSource;
    const recoveredProviderIntents = legacySplit.map(({ intent }) => intent);
    const portableProviders = validExistingProviders
      ? recoveringLateLegacyEdit
        ? appendMissingById(validExistingProviders, recoveredProviderIntents)
        : validExistingProviders
      : recoveredProviderIntents;
    if (
      safeExistingAliases &&
      !providerAliasSourcesAreInactive(safeExistingAliases, portableProviders)
    ) {
      await ensureReadme();
      return false;
    }
    const recoveredMcpServers = normalizeLegacyMcpServers(legacy.mcpServers);
    const recoveredSkills = normalizeLegacySkills(legacy.skills);
    const nextPortable: PortableConfigShape = {
      ...existingPortable,
      providers: portableProviders,
      providerIdAliases: safeExistingAliases
        ? safeExistingAliases
        : isProviderAliasMap(legacy.providerIdAliases) &&
            providerAliasSourcesAreInactive(legacy.providerIdAliases, portableProviders)
          ? legacy.providerIdAliases
          : {},
      mcpServers: safeExistingMcpServers
        ? recoveringLateLegacyEdit
          ? appendMissingById(safeExistingMcpServers, recoveredMcpServers)
          : safeExistingMcpServers
        : recoveredMcpServers,
      skills: safeExistingSkills
        ? recoveringLateLegacyEdit
          ? appendMissingById(safeExistingSkills, recoveredSkills)
          : safeExistingSkills
        : recoveredSkills,
    };
    if (JSON.stringify(nextPortable) !== JSON.stringify(existingPortable)) {
      await portable.save(nextPortable);
    }

    const portableProviderById = new Map(portableProviders.map((intent) => [intent.id, intent]));
    const cacheable = legacySplit.flatMap(({ intent, cache }, index) =>
      !portableProviderById.has(legacyProviders[index].id) ||
      !sameProviderConnection(portableProviderById.get(legacyProviders[index].id)!, intent) ||
      (cache.models === undefined && cache.modelMetadata === undefined)
        ? []
        : [[legacyProviders[index].id, cache] as const],
    );
    if (cacheable.length > 0)
      await modelCache.update((draft) => {
        for (const [id, cache] of cacheable) {
          setRecordEntry(
            draft.byProvider,
            id,
            mergeProviderModelCacheEntries(cache, ownRecordEntry(draft.byProvider, id)),
          );
        }
      });

    if (!(await exists(await settings.path()))) {
      await settings.save(normalizeSettingsShape({ settings: legacy.settings }));
    } else if (recoveringLateLegacyEdit && isRecord(legacy.settings)) {
      await settings.update((document) => {
        const recovered = normalizeSettingsShape({
          // The split settings file may have received a still-newer edit after
          // the interrupted migration. Recover only missing legacy fields;
          // the already-split value wins every conflict.
          settings: appendMissingSettings(
            document.settings as unknown as Record<string, unknown>,
            legacy.settings as unknown as Record<string, unknown>,
          ),
        });
        document.settings = recovered.settings;
      });
    }

    await ensureReadme();

    // Consume the legacy file. Archiving is not a courtesy copy: if the
    // pre-split superset stayed at config.json, then a user who deleted the
    // portable file to start clean would have every provider, MCP server, and
    // skill they had since removed resurrected from it. Retiring it is what
    // makes an absent portable file mean "use defaults".
    //
    // Copy-then-overwrite rather than rename, so no crash window leaves the
    // legacy fields existing in neither file. A rename that succeeded before the
    // slimmed write landed would lose the user's workspaces: the next launch
    // would find config.json missing, fall back to defaults, and only the
    // archive would still hold them. With a copy, an interrupted run finds the
    // original still in place and simply converges on the next attempt.
    // Never overwrite an archive that already exists: on a retry the file at
    // legacyPath may already be the slimmed version, and copying that over the
    // archive would destroy the only remaining copy of the legacy fields.
    if (await exists(legacyPath)) {
      if (loadedLegacyContents === null) {
        throw new Error("Cannot archive a legacy config that was not loaded from disk.");
      }
      await testHooks.beforeLegacyArchive?.();
      await ensureCompleteLegacyArchive(loadedLegacyContents, archivePath);
    }

    try {
      const nextLocal = structuredClone(loaded) as unknown as Record<string, unknown>;
      // Consume only fields that this split explicitly owns. Unknown local
      // fields may belong to a newer Aiden and must remain active, not merely
      // survive in the migration archive.
      delete nextLocal.providers;
      delete nextLocal.providerIdAliases;
      delete nextLocal.settings;
      delete nextLocal.mcpServers;
      delete nextLocal.skills;
      nextLocal.workspaces = Array.isArray(legacy.workspaces) ? legacy.workspaces : [];
      nextLocal.seeded = legacy.seeded === true;
      nextLocal.aidenDirMigratedAt = Date.now();
      await local.save(nextLocal as unknown as LocalConfigShape);
    } catch (error) {
      if (error instanceof DataStoreExternalChangeError) return false;
      throw error;
    }
    return true;
  }

  /** Migrate onto the split layout, exactly once per process. */
  function ensureMigrated(): Promise<boolean> {
    if (!migrationPromise) {
      migrationPromise = runMigration().then(
        (completed) => {
          if (!completed) migrationPromise = null;
          return completed;
        },
        () => {
          migrationPromise = null;
          // An unreadable/uncreatable portable root is a recoverable, read-only
          // startup state. The stores return defaults and all writes remain
          // protected until the filesystem is repaired.
          return false;
        },
      );
    }
    return migrationPromise;
  }

  return { portable, settings, local, modelCache, ensureMigrated, ensureReadme };
}
