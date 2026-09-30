import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  isScopedApprovalToolName,
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

export interface ToolApprovalRuleTarget {
  toolName: ScopedApprovalToolName;
  pattern: string;
  workspaceId: string;
}

export interface ToolApprovalRulesDocument {
  version: 1;
  rules: ToolApprovalRuleView[];
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

/** Drop malformed or duplicate rules; never throws. */
export function normalizeToolApprovalRulesDocument(value: unknown): ToolApprovalRulesDocument {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (!record || record.version !== 1 || !Array.isArray(record.rules)) {
    return emptyToolApprovalRulesDocument();
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
  return { version: 1, rules };
}

export interface ToolApprovalRuleStore {
  load(): Promise<ToolApprovalRulesDocument>;
  update<R>(mutation: (draft: ToolApprovalRulesDocument) => R | Promise<R>): Promise<R>;
}

export type ToolApprovalRuleMatch = Exclude<ToolApprovalScope, "once">;

/** Holds in-memory chat rules and the persisted "always" rules. */
export class ToolApprovalRuleBook {
  private readonly chatRules = new Map<string, Set<string>>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: ToolApprovalRuleStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => randomUUID().split("-").join(""),
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
    const changed = await this.store.update((draft) => {
      if (draft.rules.some((rule) => targetKey(rule) === key)) return false;
      if (draft.rules.length >= MAX_PERSISTED_TOOL_APPROVAL_RULES) {
        throw new Error(
          `Aiden keeps at most ${MAX_PERSISTED_TOOL_APPROVAL_RULES} always-allow rules. Remove some in Settings → Tool approvals.`,
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
    const removed = await this.store.update((draft) => {
      const index = draft.rules.findIndex((rule) => rule.id === ruleId);
      if (index < 0) return false;
      draft.rules.splice(index, 1);
      return true;
    });
    if (removed) this.notify();
    return removed;
  }

  async revokeAll(): Promise<number> {
    const removed = await this.store.update((draft) => {
      const count = draft.rules.length;
      draft.rules = [];
      return count;
    });
    if (removed > 0) this.notify();
    return removed;
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
