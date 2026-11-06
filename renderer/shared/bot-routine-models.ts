/** Owner-reviewed routine-only model choices. IDs belong to the Bot capability catalog. */
export const BOT_ROUTINE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type BotRoutineThinkingLevel = typeof BOT_ROUTINE_THINKING_LEVELS[number];
export interface BotRoutineModelChoice { providerId: string; modelId: string; thinkingLevel: BotRoutineThinkingLevel }
export type BotRoutineModelSelection = { mode: "inherit" } | { mode: "selected"; primary: BotRoutineModelChoice; fallback?: BotRoutineModelChoice };
export interface BotRoutineModelSettings { botId: string; routineId: string; revision: string; selection: BotRoutineModelSelection; updatedAt: number; lastMutationId?: string }
export interface BotRoutineModelSave { botId: string; routineId: string; mutationId: string; expectedRevision: string; catalogRevision: string; selection: BotRoutineModelSelection }
export interface BotRoutineModelOption { id: string; label: string; available: boolean; supportsImages: boolean; thinkingLevels: BotRoutineThinkingLevel[] }
export interface BotRoutineModelProvider { id: string; label: string; available: boolean; models: BotRoutineModelOption[] }
export interface BotRoutineModelCatalog { revision: string; providers: BotRoutineModelProvider[] }
export type BotRoutineModelResult = { ok: true; settings: BotRoutineModelSettings; mutationId: string; replayed: boolean } | { ok: false; code: "conflict" | "invalid" | "unavailable" | "not_found" | "history_full"; error: string; settings?: BotRoutineModelSettings };
export interface BotRoutineRunModel {
  chosen: BotRoutineModelChoice;
  actual: BotRoutineModelChoice;
  providerLabel: string;
  modelLabel: string;
  chosenProviderLabel: string;
  chosenModelLabel: string;
  fallbackReason?: "model_unavailable" | "credentials_unavailable";
}
export interface BotRoutineModelRun { runId: string; submissionId?: string; admittedAt: number; startedAt?: number; scheduledFor?: number; timezone?: string; triggerKind: "scheduled" | "manual" | "event" | "retry" | "catch_up"; model: BotRoutineRunModel }
export const BOT_ROUTINE_MODEL_LIMITS = { publicBytes: 900 * 1024, mutationBytes: 16 * 1024, providers: 64, models: 512, runs: 64, labelScalars: 160, labelBytes: 640 } as const;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid routine model settings.");
  return value as Record<string, unknown>;
}
export function parseBotRoutineModelId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) throw new Error("Invalid routine model identity."); return value;
}
export function parseBotRoutineModelChoice(value: unknown): BotRoutineModelChoice {
  const row = object(value, ["providerId", "modelId", "thinkingLevel"]);
  if (!BOT_ROUTINE_THINKING_LEVELS.includes(row.thinkingLevel as BotRoutineThinkingLevel)) throw new Error("Invalid routine thinking level.");
  return { providerId: parseBotRoutineModelId(row.providerId), modelId: parseBotRoutineModelId(row.modelId), thinkingLevel: row.thinkingLevel as BotRoutineThinkingLevel };
}
export function parseBotRoutineModelSelection(value: unknown): BotRoutineModelSelection {
  const row = object(value, ["mode", "primary", "fallback"]);
  if (row.mode === "inherit" && Object.keys(row).length === 1) return { mode: "inherit" };
  if (row.mode !== "selected") throw new Error("Invalid routine model selection.");
  return { mode: "selected", primary: parseBotRoutineModelChoice(row.primary), ...(row.fallback === undefined ? {} : { fallback: parseBotRoutineModelChoice(row.fallback) }) };
}
export function parseBotRoutineModelSave(value: unknown): BotRoutineModelSave {
  const row = object(value, ["botId", "routineId", "mutationId", "expectedRevision", "catalogRevision", "selection"]);
  if (typeof row.mutationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(row.mutationId)) throw new Error("Invalid routine model mutation identity.");
  return { botId: parseBotRoutineModelId(row.botId), routineId: parseBotRoutineModelId(row.routineId), mutationId: row.mutationId, expectedRevision: parseBotRoutineModelId(row.expectedRevision), catalogRevision: parseBotRoutineModelId(row.catalogRevision), selection: parseBotRoutineModelSelection(row.selection) };
}
export function parseBotRoutineModelSettings(value: unknown): BotRoutineModelSettings {
  const row = object(value, ["botId", "routineId", "revision", "selection", "updatedAt", "lastMutationId"]);
  if (!Number.isSafeInteger(row.updatedAt) || (row.updatedAt as number) < 0) throw new Error("Invalid routine model timestamp.");
  return { botId: parseBotRoutineModelId(row.botId), routineId: parseBotRoutineModelId(row.routineId), revision: parseBotRoutineModelId(row.revision), selection: parseBotRoutineModelSelection(row.selection), updatedAt: row.updatedAt as number, ...(row.lastMutationId === undefined ? {} : { lastMutationId: uuid(row.lastMutationId) }) };
}
function uuid(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw new Error("Invalid routine model mutation identity."); return value; }
function bounded(value: unknown): void { const text = JSON.stringify(value); if (new TextEncoder().encode(text).length > BOT_ROUTINE_MODEL_LIMITS.publicBytes) throw new Error("Routine model response is too large."); }
function label(value: unknown): string { if (typeof value !== "string" || !value.trim() || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) || value.includes("\0") || [...value].length > 160 || new TextEncoder().encode(value).length > 640) throw new Error("Invalid routine model label."); return value; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("Invalid routine model availability."); return value; }
function timestamp(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid routine model timestamp."); return value as number; }
export function parseBotRoutineModelCatalog(value: unknown): BotRoutineModelCatalog {
  bounded(value); const row = object(value, ["revision", "providers"]); let count = 0;
  if (!Array.isArray(row.providers) || row.providers.length > 64) throw new Error("Invalid routine model providers.");
  const providers = row.providers.map((input) => {
    const provider = object(input, ["id", "label", "available", "models"]);
    if (!Array.isArray(provider.models) || (count += provider.models.length) > 512) throw new Error("Invalid routine model list.");
    const models = provider.models.map((entry) => {
      const model = object(entry, ["id", "label", "available", "supportsImages", "thinkingLevels"]);
      if (!Array.isArray(model.thinkingLevels) || model.thinkingLevels.length > 7 || new Set(model.thinkingLevels).size !== model.thinkingLevels.length || model.thinkingLevels.some((level) => !BOT_ROUTINE_THINKING_LEVELS.includes(level as BotRoutineThinkingLevel))) throw new Error("Invalid supported thinking levels.");
      return { id: parseBotRoutineModelId(model.id), label: label(model.label), available: bool(model.available), supportsImages: bool(model.supportsImages), thinkingLevels: model.thinkingLevels as BotRoutineThinkingLevel[] };
    });
    if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error("Duplicate routine models.");
    return { id: parseBotRoutineModelId(provider.id), label: label(provider.label), available: bool(provider.available), models };
  });
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) throw new Error("Duplicate routine providers.");
  return { revision: parseBotRoutineModelId(row.revision), providers };
}
export function parseBotRoutineRunModel(value: unknown): BotRoutineRunModel {
  const row = object(value, ["chosen", "actual", "providerLabel", "modelLabel", "chosenProviderLabel", "chosenModelLabel", "fallbackReason"]);
  if (row.fallbackReason !== undefined && row.fallbackReason !== "model_unavailable" && row.fallbackReason !== "credentials_unavailable") throw new Error("Invalid routine fallback reason.");
  return { chosen: parseBotRoutineModelChoice(row.chosen), actual: parseBotRoutineModelChoice(row.actual), providerLabel: label(row.providerLabel), modelLabel: label(row.modelLabel), chosenProviderLabel: label(row.chosenProviderLabel), chosenModelLabel: label(row.chosenModelLabel), ...(row.fallbackReason === undefined ? {} : { fallbackReason: row.fallbackReason }) };
}
export function parseBotRoutineModelRuns(value: unknown): BotRoutineModelRun[] {
  bounded(value); if (!Array.isArray(value) || value.length > 64) throw new Error("Invalid routine model runs.");
  const runs = value.map((input) => {
    const row = object(input, ["runId", "submissionId", "admittedAt", "startedAt", "scheduledFor", "timezone", "triggerKind", "model"]);
    if (!["scheduled", "manual", "event", "retry", "catch_up"].includes(String(row.triggerKind)) || row.submissionId !== undefined && (typeof row.submissionId !== "string" || !/^[1-9][0-9]{0,31}$/u.test(row.submissionId))) throw new Error("Invalid routine run identity.");
    if (row.timezone !== undefined) { if (typeof row.timezone !== "string" || row.timezone.length > 100) throw new Error("Invalid routine timezone."); try { new Intl.DateTimeFormat("en", { timeZone: row.timezone }); } catch { throw new Error("Invalid routine timezone."); } }
    if (row.scheduledFor !== undefined && row.timezone === undefined) throw new Error("Scheduled routine time requires its timezone.");
    return { runId: parseBotRoutineModelId(row.runId), admittedAt: timestamp(row.admittedAt), triggerKind: row.triggerKind as BotRoutineModelRun["triggerKind"], model: parseBotRoutineRunModel(row.model), ...(row.submissionId === undefined ? {} : { submissionId: row.submissionId as string }), ...(row.startedAt === undefined ? {} : { startedAt: timestamp(row.startedAt) }), ...(row.scheduledFor === undefined ? {} : { scheduledFor: timestamp(row.scheduledFor) }), ...(row.timezone === undefined ? {} : { timezone: row.timezone as string }) };
  });
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) throw new Error("Duplicate routine runs."); return runs;
}
export function parseBotRoutineModelResult(value: unknown): BotRoutineModelResult {
  bounded(value); const row = object(value, ["ok", "settings", "mutationId", "replayed", "code", "error"]);
  if (row.ok === true && Object.keys(row).every((key) => ["ok", "settings", "mutationId", "replayed"].includes(key))) return { ok: true, settings: parseBotRoutineModelSettings(row.settings), mutationId: uuid(row.mutationId), replayed: bool(row.replayed) };
  if (row.ok !== false || !["conflict", "invalid", "unavailable", "not_found", "history_full"].includes(String(row.code)) || row.mutationId !== undefined || row.replayed !== undefined) throw new Error("Invalid routine model result.");
  return { ok: false, code: row.code as "conflict" | "invalid" | "unavailable" | "not_found" | "history_full", error: label(row.error), ...(row.settings === undefined ? {} : { settings: parseBotRoutineModelSettings(row.settings) }) };
}
