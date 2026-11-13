import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  isScopedApprovalToolName,
  botApprovalRuleKey,
  BOT_APPROVAL_RULES_PER_BOT_MAX,
  type BotApprovalRuleTarget,
  type BotApprovalRuleView,
  type ScopedApprovalToolName,
  type ToolApprovalRuleView,
  type ToolApprovalScope,
} from "../../renderer/shared/tool-approval-scope.js";

/**
 * Narrow, exact-match approval rules for the parent agent's workspace tools.
 *
 * A rule never covers more than what the user saw on the approval card: a
 * `run_command` rule matches only the identical (trimmed) command string and a
 * file rule matches only the identical normalized workspace-relative path for
 * the same tool. Rules are always bound to one workspace id, and "this chat"
 * rules are additionally bound to one chat id and live only in memory.
 */

export const TOOL_APPROVAL_RULES_FILE = "tool-approval-rules.json";
export const TOOL_APPROVAL_RULES_MAX_BYTES = 512 * 1024;
export const MAX_PERSISTED_TOOL_APPROVAL_RULES = 200;
export const MAX_CHAT_TOOL_APPROVAL_RULES = 100;
const MAX_COMMAND_PATTERN_CHARS = 2_000;
const MAX_PATH_PATTERN_CHARS = 1_024;
const MAX_WORKSPACE_ID_CHARS = 256;
const MAX_WORKSPACE_LABEL_CHARS = 200;

/** The scopes offered for a call that has a safe rule target. */
export const SCOPED_APPROVAL_OFFER: readonly ToolApprovalScope[] = ["once", "chat", "always"];
/** A Mac card under an approval mode: Allow once, or this part of the Mac in this workspace. */
export const MAC_GRANT_OFFER: readonly ToolApprovalScope[] = ["once", "workspace"];

export interface ToolApprovalRuleTarget {
  toolName: ScopedApprovalToolName;
  pattern: string;
  workspaceId: string;
}

export interface BotGrantOperation {
  operationId: string;
  botId: string;
  targetKey: string;
  ruleId: string;
  status: "published" | "revoked";
  publishedAt: string;
  revokedAt?: string;
}

export interface BotApprovalPublicationOptions {
  expectedConsentRevision?: string;
  /** Pure live read, never a queued rule mutation. Used only for first publication. */
  validatePublication?(): Promise<void>;
}

export const BOT_APPROVAL_RULES_PROFILE_MAX = 1_000;

export interface ToolApprovalRulesDocument {
  version: 1;
  rules: ToolApprovalRuleView[];
  botRules?: BotApprovalRuleView[];
  botGrantOperations?: BotGrantOperation[];
  /** Durable quarantine: never reset replay protection by dropping damaged receipts. */
  botGrantOperationsUnreadable?: true;
  botGrantOperationsEvidence?: unknown;
}

export function emptyToolApprovalRulesDocument(): ToolApprovalRulesDocument {
  return { version: 1, rules: [] };
}

function hasControlCharacter(value: string, allowWhitespace: boolean): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      if (allowWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
      return true;
    }
  }
  return false;
}

function normalizeCommandPattern(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (hasControlCharacter(value, true)) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_COMMAND_PATTERN_CHARS) return undefined;
  return trimmed;
}

function normalizePathPattern(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Whitespace belongs to the filesystem target; never collapse distinct paths.
  const trimmed = value;
  if (!trimmed || trimmed.length > MAX_PATH_PATTERN_CHARS) return undefined;
  if (hasControlCharacter(trimmed, false)) return undefined;
  if (path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed) || trimmed.startsWith("~")) {
    return undefined;
  }
  if (trimmed.split(/[\\/]/u).includes("..")) return undefined;
  let normalized = path.posix.normalize(trimmed);
  while (normalized.endsWith("/") && normalized.length > 1) normalized = normalized.slice(0, -1);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return normalized;
}

function validWorkspaceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_WORKSPACE_ID_CHARS &&
    !hasControlCharacter(value, false)
  );
}

/**
 * The exact rule a scoped approval of this call would create, or undefined
 * when the call cannot be remembered safely (and so only "once" is offered).
 */
export function toolApprovalRuleTarget(
  toolName: string,
  args: unknown,
  workspaceId: string | undefined,
): ToolApprovalRuleTarget | undefined {
  if (!isScopedApprovalToolName(toolName) || !validWorkspaceId(workspaceId)) return undefined;
  const record =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : undefined;
  if (!record) return undefined;
  const pattern =
    toolName === "run_command"
      ? normalizeCommandPattern(record.command)
      : normalizePathPattern(record.path);
  return pattern ? { toolName, pattern, workspaceId } : undefined;
}

function targetKey(target: ToolApprovalRuleTarget): string {
  return JSON.stringify([target.workspaceId, target.toolName, target.pattern]);
}

function normalizeRule(value: unknown): ToolApprovalRuleView | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(record.id)) return undefined;
  if (!isScopedApprovalToolName(record.toolName) || !validWorkspaceId(record.workspaceId)) {
    return undefined;
  }
  const pattern =
    record.toolName === "run_command"
      ? normalizeCommandPattern(record.pattern)
      : normalizePathPattern(record.pattern);
  // A stored pattern must already be canonical: a hand edit cannot widen it.
  if (!pattern || pattern !== record.pattern) return undefined;
  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
    return undefined;
  }
  const label =
    typeof record.workspaceLabel === "string" && record.workspaceLabel.trim()
      ? record.workspaceLabel.trim().slice(0, MAX_WORKSPACE_LABEL_CHARS)
      : undefined;
  return {
    id: record.id,
    toolName: record.toolName,
    pattern,
    workspaceId: record.workspaceId,
    ...(label ? { workspaceLabel: label } : {}),
    createdAt: new Date(record.createdAt).toISOString(),
  };
}

function normalizeBotTarget(value: unknown): BotApprovalRuleTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v.kind === "connection" && validWorkspaceId(v.serverId) && validWorkspaceId(v.tool)) {
    return { kind: "connection", serverId: v.serverId, tool: v.tool };
  }
  if (v.kind === "site" && typeof v.host === "string" && v.host.length <= 253 &&
    /^[a-z0-9.-]+$/u.test(v.host) && !v.host.startsWith("www.") &&
    (v.action === "click" || v.action === "type" || v.action === "press")) {
    return { kind: "site", host: v.host, action: v.action };
  }
  return undefined;
}

function validRuleId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function normalizeBotRule(value: unknown): BotApprovalRuleView | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const target = normalizeBotTarget(v.target);
  if (!target || !validRuleId(v.id) || !validWorkspaceId(v.botId) ||
    typeof v.label !== "string" || !v.label.trim() || v.label.trim().length > 200 ||
    hasControlCharacter(v.label, false) || !validDate(v.createdAt) ||
    typeof v.uses !== "number" || !Number.isSafeInteger(v.uses) || v.uses < 0 ||
    (v.lastUsedAt !== undefined && !validDate(v.lastUsedAt))) return undefined;
  return { id: v.id, botId: v.botId, target, label: v.label.trim(),
    createdAt: new Date(v.createdAt).toISOString(), uses: v.uses,
    ...(v.lastUsedAt !== undefined ? { lastUsedAt: new Date(v.lastUsedAt as string).toISOString() } : {}) };
}

function normalizeBotOperation(value: unknown): BotGrantOperation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (!validWorkspaceId(v.operationId) || !validWorkspaceId(v.botId) || !validRuleId(v.ruleId) ||
    typeof v.targetKey !== "string" || !validDate(v.publishedAt) ||
    (v.status !== "published" && v.status !== "revoked") ||
    (v.status === "revoked" ? !validDate(v.revokedAt) : v.revokedAt !== undefined)) return undefined;
  try {
    const tuple: unknown = JSON.parse(v.targetKey);
    if (!Array.isArray(tuple) || tuple.length !== 3) return undefined;
    const target = normalizeBotTarget(tuple[0] === "connection"
      ? { kind: tuple[0], serverId: tuple[1], tool: tuple[2] }
      : { kind: tuple[0], host: tuple[1], action: tuple[2] });
    if (!target || botApprovalRuleKey(target) !== v.targetKey) return undefined;
  } catch { return undefined; }
  return { operationId: v.operationId, botId: v.botId, targetKey: v.targetKey, ruleId: v.ruleId,
    status: v.status, publishedAt: new Date(v.publishedAt).toISOString(),
    ...(v.status === "revoked" ? { revokedAt: new Date(v.revokedAt as string).toISOString() } : {}) };
}

/** Reserve future tombstones and usage stamps before any publication, without pruning receipts. */
function assertDocumentBudget(document: ToolApprovalRulesDocument): void {
  const reserved = structuredClone(document);
  const longestDate = "+275760-09-13T00:00:00.000Z";
  for (const operation of reserved.botGrantOperations ?? []) {
    if (operation.status === "published") {
      operation.status = "revoked";
      operation.revokedAt = longestDate;
    }
  }
  for (const rule of reserved.botRules ?? []) {
    rule.uses = Number.MAX_SAFE_INTEGER;
    rule.lastUsedAt = longestDate;
  }
  if (Buffer.byteLength(JSON.stringify(reserved, null, 2) + "\n", "utf8") > TOOL_APPROVAL_RULES_MAX_BYTES) {
    throw new Error("Aiden's approval receipt storage is full. New remembered approvals cannot be saved.");
  }
}

/** Drop malformed or duplicate rules; retain damaged receipt evidence and fail closed. */
export function normalizeToolApprovalRulesDocument(value: unknown): ToolApprovalRulesDocument {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (!record || record.version !== 1 || !Array.isArray(record.rules)) {
    const empty = emptyToolApprovalRulesDocument();
    if (record && ("botRules" in record || "botGrantOperations" in record || "botGrantOperationsUnreadable" in record)) {
      empty.botGrantOperationsUnreadable = true;
      empty.botGrantOperationsEvidence = record;
    }
    return empty;
  }
  const seen = new Set<string>();
  const rules: ToolApprovalRuleView[] = [];
  for (const candidate of record.rules) {
    const rule = normalizeRule(candidate);
    if (!rule) continue;
    const key = targetKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
    if (rules.length >= MAX_PERSISTED_TOOL_APPROVAL_RULES) break;
  }
  const document: ToolApprovalRulesDocument = { version: 1, rules };
  if (record.botRules !== undefined) {
    document.botRules = [];
    const ids = new Set<string>();
    const targets = new Set<string>();
    const counts = new Map<string, number>();
    for (const candidate of Array.isArray(record.botRules) ? record.botRules : []) {
      const rule = normalizeBotRule(candidate);
      if (!rule) continue;
      const key = JSON.stringify([rule.botId, botApprovalRuleKey(rule.target)]);
      if (ids.has(rule.id) || targets.has(key) || (counts.get(rule.botId) ?? 0) >= BOT_APPROVAL_RULES_PER_BOT_MAX ||
        document.botRules.length >= BOT_APPROVAL_RULES_PROFILE_MAX) continue;
      ids.add(rule.id); targets.add(key);
      counts.set(rule.botId, (counts.get(rule.botId) ?? 0) + 1);
      document.botRules.push(rule);
    }
  }
  if (record.botGrantOperationsUnreadable !== undefined || record.botGrantOperationsEvidence !== undefined) {
    document.botGrantOperationsUnreadable = true;
    document.botGrantOperationsEvidence = record.botGrantOperationsEvidence ?? record.botGrantOperationsUnreadable;
  }
  if (record.botGrantOperations !== undefined) {
    const operations: BotGrantOperation[] = [];
    const ids = new Set<string>();
    let damaged = !Array.isArray(record.botGrantOperations);
    for (const candidate of Array.isArray(record.botGrantOperations) ? record.botGrantOperations : []) {
      const op = normalizeBotOperation(candidate);
      if (!op || ids.has(op.operationId)) { damaged = true; continue; }
      ids.add(op.operationId);
      // A missing/invalid visible rule must never be recreated by its old publication.
      if (op.status === "published" && !document.botRules?.some((rule) =>
        rule.id === op.ruleId && rule.botId === op.botId && botApprovalRuleKey(rule.target) === op.targetKey)) {
        op.status = "revoked"; op.revokedAt = op.publishedAt;
      }
      operations.push(op);
    }
    document.botGrantOperations = operations;
    if (damaged) {
      document.botGrantOperationsUnreadable = true;
      // Keep the complete original array once. Duplicating its parsed prefix could
      // fill the shared budget and unnecessarily prevent workspace approvals.
      document.botGrantOperations = [];
      document.botGrantOperationsEvidence = record.botGrantOperations;
    }
  }
  return document;
}

export interface ToolApprovalRuleStore {
  load(): Promise<ToolApprovalRulesDocument>;
  /** DataStore exposes this after its transaction reload, before draft publication. */
  loadedFromCorruptFile?(): Promise<boolean>;
  update<R>(mutation: (draft: ToolApprovalRulesDocument) => R | Promise<R>): Promise<R>;
}

/** The exact-action rules this book holds. A Mac grant ("workspace") lives on the workspace. */
export type ToolApprovalRuleMatch = Exclude<ToolApprovalScope, "once" | "workspace">;

/** Quarantine is distinct from a failed filesystem publication. */
class BotApprovalReceiptsUnreadableError extends Error {
  constructor() {
    super("Bot approval receipts could not be read. Remembered approvals are unavailable.");
  }
}

/** Same canonical digest for external reads and the atomic first-publication compare. */
function botConsentRevisionOf(document: ToolApprovalRulesDocument, botId: string, key: string): string {
  const operations = (document.botGrantOperations ?? [])
    .filter((operation) => operation.botId === botId && operation.targetKey === key)
    .sort((a, b) => a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0)
    .map((operation) => [operation.operationId, operation.ruleId, operation.status,
      operation.publishedAt, operation.revokedAt ?? null]);
  return createHash("sha256").update(JSON.stringify(["bot-consent-v1", botId, key, operations])).digest("hex");
}

/** Holds in-memory chat rules and the persisted "always" rules. */
export class ToolApprovalRuleBook {
  private readonly chatRules = new Map<string, Set<string>>();
  private readonly listeners = new Set<() => void>();
  private readonly botListeners = new Set<(botId: string) => void>();
  private readonly forgottenBots = new Set<string>();

  constructor(
    private readonly store: ToolApprovalRuleStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => randomUUID().split("-").join(""),
    private readonly options: { knownBot?: (botId: string) => Promise<boolean> } = {},
  ) {}

  /** Which remembered scope, if any, already authorizes this exact call. */
  async match(
    chatId: string,
    target: ToolApprovalRuleTarget,
  ): Promise<ToolApprovalRuleMatch | undefined> {
    const key = targetKey(target);
    if (this.chatRules.get(chatId)?.has(key)) return "chat";
    const document = await this.store.load();
    return document.rules.some((rule) => targetKey(rule) === key) ? "always" : undefined;
  }

  /** Remember an approval the user granted with a broader-than-once scope. */
  async grant(
    scope: ToolApprovalRuleMatch,
    chatId: string,
    target: ToolApprovalRuleTarget,
    workspaceLabel?: string,
  ): Promise<void> {
    if (scope === "chat") {
      let rules = this.chatRules.get(chatId);
      if (!rules) {
        rules = new Set();
        this.chatRules.set(chatId, rules);
      }
      if (rules.size >= MAX_CHAT_TOOL_APPROVAL_RULES && !rules.has(targetKey(target))) {
        // Keep the newest rules: drop the oldest insertion.
        const oldest = rules.values().next().value;
        if (oldest !== undefined) rules.delete(oldest);
      }
      rules.add(targetKey(target));
      return;
    }
    const key = targetKey(target);
    const label = workspaceLabel?.trim().slice(0, MAX_WORKSPACE_LABEL_CHARS);
    const changed = await this.store.update(async (draft) => {
      await this.preserveBotReceiptHealth(draft);
      if (draft.rules.some((rule) => targetKey(rule) === key)) return false;
      if (draft.rules.length >= MAX_PERSISTED_TOOL_APPROVAL_RULES) {
        throw new Error(
          `Aiden keeps at most ${MAX_PERSISTED_TOOL_APPROVAL_RULES} always-allow rules. Remove some in Settings → Approvals.`,
        );
      }
      draft.rules.push({
        id: this.newId(),
        toolName: target.toolName,
        pattern: target.pattern,
        workspaceId: target.workspaceId,
        ...(label ? { workspaceLabel: label } : {}),
        createdAt: this.now().toISOString(),
      });
      assertDocumentBudget(draft);
      return true;
    });
    if (changed) this.notify();
  }

  /** Persisted "always" rules, newest first. */
  async list(): Promise<ToolApprovalRuleView[]> {
    const document = await this.store.load();
    return document.rules.map((rule) => ({ ...rule })).reverse();
  }

  async revoke(ruleId: string): Promise<boolean> {
    const removed = await this.store.update(async (draft) => {
      await this.preserveBotReceiptHealth(draft);
      const index = draft.rules.findIndex((rule) => rule.id === ruleId);
      if (index < 0) return false;
      draft.rules.splice(index, 1);
      return true;
    });
    if (removed) this.notify();
    return removed;
  }

  async revokeAll(): Promise<number> {
    const removed = await this.store.update(async (draft) => {
      await this.preserveBotReceiptHealth(draft);
      const count = draft.rules.length;
      draft.rules = [];
      return count;
    });
    if (removed > 0) this.notify();
    return removed;
  }

  private async preserveBotReceiptHealth(document: ToolApprovalRulesDocument): Promise<void> {
    if (await this.store.loadedFromCorruptFile?.()) document.botGrantOperationsUnreadable = true;
  }

  private async assertBotReceipts(document: ToolApprovalRulesDocument): Promise<void> {
    await this.preserveBotReceiptHealth(document);
    if (document.botGrantOperationsUnreadable) throw new BotApprovalReceiptsUnreadableError();
  }

  private async isKnownBot(botId: string): Promise<boolean> {
    return validWorkspaceId(botId) && !this.forgottenBots.has(botId) &&
      !!(await this.options.knownBot?.(botId)) && !this.forgottenBots.has(botId);
  }

  async matchBot(botId: string, target: BotApprovalRuleTarget): Promise<BotApprovalRuleView | undefined> {
    const canonical = normalizeBotTarget(target);
    if (!canonical) return undefined;
    const document = await this.store.load();
    await this.assertBotReceipts(document);
    if (!await this.isKnownBot(botId)) return undefined;
    const rule = document.botRules?.find((r) => r.botId === botId && botApprovalRuleKey(r.target) === botApprovalRuleKey(canonical));
    return rule ? structuredClone(rule) : undefined;
  }

  /** Main-only permission generation. Usage and unrelated consent never affect it. */
  async botConsentRevision(botId: string, target: BotApprovalRuleTarget): Promise<string> {
    const canonical = normalizeBotTarget(target);
    if (!canonical || !validWorkspaceId(botId)) throw new Error("Invalid Bot approval target.");
    const document = await this.store.load();
    await this.assertBotReceipts(document);
    if (!await this.isKnownBot(botId)) throw new Error("This Bot no longer exists.");
    return botConsentRevisionOf(document, botId, botApprovalRuleKey(canonical));
  }

  /** Historical receipt read. It grants nothing and needs no current Bot/binding. */
  async botGrantOperation(botId: string, operationId: string): Promise<BotGrantOperation | undefined> {
    if (!validWorkspaceId(botId) || !validWorkspaceId(operationId)) throw new Error("Invalid Bot approval operation identity.");
    const document = await this.store.load();
    await this.assertBotReceipts(document);
    const operation = document.botGrantOperations?.find((entry) => entry.operationId === operationId);
    if (!operation) return undefined;
    const receipt = normalizeBotOperation(operation);
    if (!receipt) throw new Error("Bot approval operation receipt could not be read.");
    if (receipt.botId !== botId) throw new Error("Bot approval operation changed its Bot identity.");
    return structuredClone(receipt);
  }

  async grantBot(botId: string, target: BotApprovalRuleTarget, label: string, operationId: string,
    options?: BotApprovalPublicationOptions): Promise<
    { status: "published"; rule: BotApprovalRuleView } | { status: "revoked" }
  > {
    const canonical = normalizeBotTarget(target);
    if (!canonical || !validWorkspaceId(botId) || !validWorkspaceId(operationId) ||
      typeof label !== "string" || !label.trim() || hasControlCharacter(label, false)) {
      throw new Error("Invalid Bot approval operation.");
    }
    const capturedLabel = label.trim().slice(0, 200);
    const key = botApprovalRuleKey(canonical);
    const guarded = options !== undefined;
    const expectedConsentRevision = options?.expectedConsentRevision;
    const validatePublication = options?.validatePublication;
    const result = await this.store.update(async (draft) => {
      await this.assertBotReceipts(draft);
      const previous = draft.botGrantOperations?.find((op) => op.operationId === operationId);
      if (previous && (previous.botId !== botId || previous.targetKey !== key)) throw new Error("Bot approval operation changed its target.");
      // Revoked replay is inert even after deletion. It can never release waiting cards.
      if (previous?.status === "revoked") return { status: "revoked" as const, changed: false };
      if (!await this.isKnownBot(botId)) throw new Error("This Bot no longer exists.");
      const rules = draft.botRules ?? [];
      if (previous) {
        const rule = rules.find((r) => r.id === previous.ruleId && r.botId === botId && botApprovalRuleKey(r.target) === key);
        return rule ? { status: "published" as const, rule: structuredClone(rule), changed: false }
          : { status: "revoked" as const, changed: false };
      }
      if (guarded) {
        if (typeof expectedConsentRevision !== "string" || !/^[a-f0-9]{64}$/u.test(expectedConsentRevision) ||
          typeof validatePublication !== "function") {
          throw new Error("A Bot approval publication requires a consent revision and a live publication proof.");
        }
        if (botConsentRevisionOf(draft, botId, key) !== expectedConsentRevision) {
          throw new Error("Bot approval consent changed before publication.");
        }
        if (!await this.isKnownBot(botId)) throw new Error("This Bot no longer exists.");
        // The live proof must be the final awaited authorization. Another lookup
        // afterward would let Stop, expiry or page drift invalidate that proof.
        await validatePublication();
        // Deletion intent can arrive while the proof is held. Fence it without
        // introducing an await after the final live authorization.
        if (this.forgottenBots.has(botId)) throw new Error("This Bot no longer exists.");
      }
      let rule = rules.find((r) => r.botId === botId && botApprovalRuleKey(r.target) === key);
      if (!rule) {
        if (rules.filter((r) => r.botId === botId).length >= BOT_APPROVAL_RULES_PER_BOT_MAX) {
          throw new Error("Aiden keeps at most 50 things a Bot can do without asking. Remove some on its profile.");
        }
        if (rules.length >= BOT_APPROVAL_RULES_PROFILE_MAX) throw new Error("Aiden keeps at most 1,000 things Bots can do without asking. Remove some on their profiles.");
        const id = this.newId();
        if (!validRuleId(id) || rules.some((r) => r.id === id) || draft.botGrantOperations?.some((op) => op.ruleId === id)) {
          throw new Error("Invalid or reused Bot approval rule id.");
        }
        rule = { id, botId, target: canonical, label: capturedLabel, createdAt: this.now().toISOString(), uses: 0 };
        rules.push(rule);
      }
      draft.botRules = rules;
      (draft.botGrantOperations ??= []).push({ operationId, botId, targetKey: key, ruleId: rule.id,
        status: "published", publishedAt: this.now().toISOString() });
      assertDocumentBudget(draft);
      return { status: "published" as const, rule: structuredClone(rule), changed: true };
    });
    if (result.changed) this.notifyBot(botId);
    return result.status === "published" ? { status: "published", rule: result.rule! } : { status: "revoked" };
  }

  async listBot(botId?: string): Promise<BotApprovalRuleView[]> {
    const document = await this.store.load();
    await this.assertBotReceipts(document);
    return structuredClone((document.botRules ?? []).filter((r) => botId === undefined || r.botId === botId))
      .reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async recordBotUse(botId: string, ruleId: string): Promise<void> {
    const changed = await this.store.update(async (draft) => {
      await this.assertBotReceipts(draft);
      if (!await this.isKnownBot(botId)) return false;
      const rule = draft.botRules?.find((r) => r.id === ruleId && r.botId === botId);
      if (!rule) return false;
      rule.uses = Math.min(Number.MAX_SAFE_INTEGER, rule.uses + 1);
      rule.lastUsedAt = this.now().toISOString();
      assertDocumentBudget(draft);
      return true;
    });
    if (changed) this.notifyBot(botId);
  }

  private tombstone(draft: ToolApprovalRulesDocument, botId: string, ruleId?: string): void {
    const revokedAt = this.now().toISOString();
    for (const operation of draft.botGrantOperations ?? []) {
      if (operation.botId === botId && (ruleId === undefined || operation.ruleId === ruleId) && operation.status === "published") {
        operation.status = "revoked"; operation.revokedAt = revokedAt;
      }
    }
  }

  async revokeBot(botId: string, ruleId: string): Promise<boolean> {
    const removed = await this.store.update(async (draft) => {
      await this.assertBotReceipts(draft);
      const index = draft.botRules?.findIndex((r) => r.botId === botId && r.id === ruleId) ?? -1;
      if (index < 0) return false;
      draft.botRules!.splice(index, 1);
      this.tombstone(draft, botId, ruleId);
      return true;
    });
    if (removed) this.notifyBot(botId);
    return removed;
  }

  async forgetBot(botId: string): Promise<number> {
    this.forgottenBots.add(botId);
    let removed: number;
    try {
      removed = await this.store.update(async (draft) => {
        await this.assertBotReceipts(draft);
        const count = draft.botRules?.filter((r) => r.botId === botId).length ?? 0;
        draft.botRules = (draft.botRules ?? []).filter((r) => r.botId !== botId);
        this.tombstone(draft, botId);
        return count;
      });
    } catch (error) {
      // Abort the transaction, preserving the damaged book at its original
      // path. Quarantine already fences every grant/match; deletion can erase
      // the Bot without rewriting evidence. Genuine write failures still retry.
      if (error instanceof BotApprovalReceiptsUnreadableError) return 0;
      throw error;
    }
    if (removed) this.notifyBot(botId);
    return removed;
  }

  onBotChange(listener: (botId: string) => void): () => void {
    this.botListeners.add(listener);
    return () => this.botListeners.delete(listener);
  }

  private notifyBot(botId: string): void {
    for (const listener of this.botListeners) {
      try { listener(botId); } catch { /* Observers cannot undo publication. */ }
    }
  }

  /** Forget every "this chat" rule for one chat (for example on deletion). */
  forgetChat(chatId: string): void {
    this.chatRules.delete(chatId);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A broken listener must not undo the persisted change.
      }
    }
  }
}
