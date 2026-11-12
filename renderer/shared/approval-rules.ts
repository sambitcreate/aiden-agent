// The rules page (docs/plans/bot-ux-simplification.md §3.5): one list of rules
// for this Mac, in Settings → Approvals under the mode.
//
//   Always allow   a rule allows the action without a card
//   Always ask     a rule asks first, even where the mode would not
//   Blocked        a rule refuses the action
//
// Resolution: Block wins, else the most specific rule (site > tool >
// connector). A rule owned by one workspace, or one migrated from a Bot,
// answers only for that owner and outranks a rule for the whole Mac at the
// same specificity. Natural-language rules ("When a Bot wants to …") are
// matched by the Bot rules classifier, for Bots only.
//
// Rules never reach the person's Mac: shell commands, file changes and
// Computer Use ask on first use in every mode, and only a Mac grant ("Allowed
// in this workspace / chat") covers them. Purchases, passwords, 2FA codes and
// money are locked and always come to the person.
//
// Shared by the main process (store, resolver, IPC) and the renderer (page).

import { BOT_RULE_TEXT_MAX_CHARS, normalizeBotRuleText } from "./bot-rules.js";

export const APPROVAL_RULE_DECISIONS = ["allow", "ask", "block"] as const;
export type ApprovalRuleDecision = (typeof APPROVAL_RULE_DECISIONS)[number];

export function parseApprovalRuleDecision(value: unknown): ApprovalRuleDecision | undefined {
  return value === "allow" || value === "ask" || value === "block" ? value : undefined;
}

export const APPROVAL_RULE_DECISION_LABELS: Readonly<Record<ApprovalRuleDecision, string>> = {
  allow: "Allow",
  ask: "Ask",
  block: "Block",
};

/** What a rule is about. */
export type ApprovalRuleTarget =
  /** One of Aiden's own tools, by name ("browser_click"). */
  | { kind: "tool"; tool: string }
  /** Every tool of one connected app (an MCP server). */
  | { kind: "connector"; serverId: string }
  /** One tool of one connected app, by the app's own name for it. */
  | { kind: "connector-tool"; serverId: string; tool: string }
  /** One website and its subdomains. */
  | { kind: "site"; host: string }
  /** The person's words completing "When a Bot wants to …". Bots only. */
  | { kind: "text"; text: string };

export type ApprovalRuleTargetKind = ApprovalRuleTarget["kind"];

/**
 * Whom a rule answers for. Rules are for the whole Mac; a customized
 * workspace can hold its own; a rule migrated from a Bot keeps that Bot as a
 * legacy owner and answers only for it.
 */
export type ApprovalRuleOwner =
  | { kind: "mac" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "bot"; botId: string };

export interface ApprovalRule {
  id: string;
  target: ApprovalRuleTarget;
  decision: ApprovalRuleDecision;
  owner: ApprovalRuleOwner;
  /**
   * "Do it myself" on an Always-ask natural-language rule: a Bot hands the
   * step to the person instead of asking to run it.
   */
  handOff?: true;
  /** What the picker called the target when the rule was added ("Gmail · Send email"). */
  label?: string;
  createdAt: string;
}

export interface ApprovalRulesDocument {
  version: 1;
  rules: ApprovalRule[];
}

export const APPROVAL_RULES_FILE = "approval-rules.json";
export const APPROVAL_RULES_MAX = 500;
export const APPROVAL_RULES_MAX_BYTES = 512 * 1024;
const MAX_ID_CHARS = 256;
const MAX_TOOL_CHARS = 128;
const MAX_LABEL_CHARS = 200;
const RULE_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export function emptyApprovalRulesDocument(): ApprovalRulesDocument {
  return { version: 1, rules: [] };
}

function hasControl(value: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS && !hasControl(value);
}

/** A tool name as Aiden or a connected app spells it. */
function validToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOOL_CHARS && /^[A-Za-z0-9_.:/-]+$/u.test(value);
}

/**
 * A site as a rule stores it: a lower-case host name without "www.", a port
 * or a path. Accepts "https://www.Example.com/path" from the picker.
 */
export function normalizeApprovalRuleHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.trim().toLowerCase();
  if (!text || text.length > 300) return undefined;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//u.test(text)) text = new URL(text).hostname;
  } catch {
    return undefined;
  }
  text = text.split("/")[0]!.split(":")[0]!.replace(/\.$/u, "").replace(/^www\./u, "");
  if (!text || text.length > 253 || !/^[a-z0-9.-]+$/u.test(text)) return undefined;
  if (!text.includes(".") || text.startsWith(".") || text.includes("..")) return undefined;
  return text;
}

/** The person's words, as a natural-language rule stores them. */
export function normalizeApprovalRuleText(value: unknown): string | undefined {
  if (typeof value !== "string" || hasControl(value.replace(/\s/gu, " "))) return undefined;
  const text = normalizeBotRuleText(value);
  return text.length > 0 && text.length <= BOT_RULE_TEXT_MAX_CHARS ? text : undefined;
}

export function parseApprovalRuleTarget(value: unknown): ApprovalRuleTarget | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "tool":
      return validToolName(record.tool) ? { kind: "tool", tool: record.tool } : undefined;
    case "connector":
      return validId(record.serverId) ? { kind: "connector", serverId: record.serverId } : undefined;
    case "connector-tool":
      return validId(record.serverId) && validToolName(record.tool)
        ? { kind: "connector-tool", serverId: record.serverId, tool: record.tool }
        : undefined;
    case "site": {
      const host = normalizeApprovalRuleHost(record.host);
      return host ? { kind: "site", host } : undefined;
    }
    case "text": {
      const text = normalizeApprovalRuleText(record.text);
      return text ? { kind: "text", text } : undefined;
    }
    default:
      return undefined;
  }
}

export function parseApprovalRuleOwner(value: unknown): ApprovalRuleOwner | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "mac") return { kind: "mac" };
  if (record.kind === "workspace" && validId(record.workspaceId)) return { kind: "workspace", workspaceId: record.workspaceId };
  if (record.kind === "bot" && validId(record.botId)) return { kind: "bot", botId: record.botId };
  return undefined;
}

/** A natural-language rule never allows: words can only tighten. */
export function approvalRuleDecisionsFor(target: Pick<ApprovalRuleTarget, "kind">): readonly ApprovalRuleDecision[] {
  return target.kind === "text" ? ["ask", "block"] : APPROVAL_RULE_DECISIONS;
}

/** One stored rule, read strictly: anything malformed is dropped, never widened. */
export function parseApprovalRule(value: unknown): ApprovalRule | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !RULE_ID.test(record.id)) return undefined;
  const target = parseApprovalRuleTarget(record.target);
  const decision = parseApprovalRuleDecision(record.decision);
  const owner = parseApprovalRuleOwner(record.owner);
  if (!target || !decision || !owner) return undefined;
  if (!approvalRuleDecisionsFor(target).includes(decision)) return undefined;
  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) return undefined;
  // "Do it myself" only on an Always-ask natural-language rule.
  const handOff = record.handOff === true && decision === "ask" && target.kind === "text";
  const label = typeof record.label === "string" && !hasControl(record.label) && record.label.trim()
    ? record.label.trim().slice(0, MAX_LABEL_CHARS)
    : undefined;
  return {
    id: record.id,
    target,
    decision,
    owner,
    ...(handOff ? { handOff: true as const } : {}),
    ...(label ? { label } : {}),
    createdAt: new Date(record.createdAt).toISOString(),
  };
}

export function approvalRuleTargetKey(target: ApprovalRuleTarget): string {
  switch (target.kind) {
    case "tool":
      return JSON.stringify(["tool", target.tool]);
    case "connector":
      return JSON.stringify(["connector", target.serverId]);
    case "connector-tool":
      return JSON.stringify(["connector-tool", target.serverId, target.tool]);
    case "site":
      return JSON.stringify(["site", target.host]);
    case "text":
      return JSON.stringify(["text", target.text.toLocaleLowerCase()]);
  }
}

export function approvalRuleOwnerKey(owner: ApprovalRuleOwner): string {
  return owner.kind === "mac" ? "mac" : owner.kind === "workspace" ? `workspace:${owner.workspaceId}` : `bot:${owner.botId}`;
}

/** Strict read of the stored document; a bad or duplicate rule is dropped, never the file. */
export function normalizeApprovalRulesDocument(value: unknown): ApprovalRulesDocument {
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  if (!record || record.version !== 1 || !Array.isArray(record.rules)) return emptyApprovalRulesDocument();
  const seen = new Set<string>();
  const ids = new Set<string>();
  const rules: ApprovalRule[] = [];
  for (const candidate of record.rules) {
    const rule = parseApprovalRule(candidate);
    if (!rule || ids.has(rule.id)) continue;
    const key = `${approvalRuleOwnerKey(rule.owner)}\u0000${approvalRuleTargetKey(rule.target)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ids.add(rule.id);
    rules.push(rule);
    if (rules.length >= APPROVAL_RULES_MAX) break;
  }
  return { version: 1, rules };
}

// ---------------------------------------------------------------------------
// Resolution

/** What an action is, for the target rules. Every field is optional. */
export interface ApprovalRuleSubject {
  /** Aiden's own tool name. */
  tool?: string;
  /** A connected app's tool. */
  connector?: { serverId: string; tool: string };
  /** The site the action is on or goes to. */
  host?: string;
  /** Who is acting: the rules owned by this workspace or Bot also answer. */
  workspaceId?: string;
  botId?: string;
}

const SPECIFICITY: Readonly<Record<Exclude<ApprovalRuleTargetKind, "text">, number>> = {
  site: 3,
  tool: 2,
  "connector-tool": 2,
  connector: 1,
};

const STRICTNESS: Readonly<Record<ApprovalRuleDecision, number>> = { allow: 0, ask: 1, block: 2 };

/** Whether a rule's owner answers for this subject: the whole Mac, or its own workspace or Bot. */
export function approvalRuleOwnerAnswers(owner: ApprovalRuleOwner, subject: Pick<ApprovalRuleSubject, "workspaceId" | "botId">): boolean {
  if (owner.kind === "mac") return true;
  if (owner.kind === "workspace") return subject.workspaceId !== undefined && owner.workspaceId === subject.workspaceId;
  return subject.botId !== undefined && owner.botId === subject.botId;
}

function hostMatches(ruleHost: string, host: string | undefined): boolean {
  if (!host) return false;
  const normalized = normalizeApprovalRuleHost(host);
  return normalized !== undefined && (normalized === ruleHost || normalized.endsWith(`.${ruleHost}`));
}

function targetMatches(target: ApprovalRuleTarget, subject: ApprovalRuleSubject): boolean {
  switch (target.kind) {
    case "tool":
      return subject.tool !== undefined && subject.tool === target.tool;
    case "connector":
      return subject.connector !== undefined && subject.connector.serverId === target.serverId;
    case "connector-tool":
      return subject.connector !== undefined && subject.connector.serverId === target.serverId && subject.connector.tool === target.tool;
    case "site":
      return hostMatches(target.host, subject.host);
    case "text":
      return false;
  }
}

export interface ApprovalRuleResolution {
  decision: ApprovalRuleDecision;
  rule: ApprovalRule;
}

/**
 * The rule that decides this action, if any: Block wins; else the most
 * specific rule (site > tool > connector); at equal specificity a rule owned
 * by the workspace or Bot beats one for the whole Mac, then the stricter one.
 * Natural-language rules are not considered here.
 */
export function resolveApprovalRule(rules: readonly ApprovalRule[], subject: ApprovalRuleSubject): ApprovalRuleResolution | undefined {
  let best: ApprovalRule | undefined;
  let block: ApprovalRule | undefined;
  const rank = (rule: ApprovalRule) => [
    SPECIFICITY[rule.target.kind as Exclude<ApprovalRuleTargetKind, "text">],
    rule.owner.kind === "mac" ? 0 : 1,
    STRICTNESS[rule.decision],
  ];
  const better = (left: ApprovalRule, right: ApprovalRule) => {
    const a = rank(left);
    const b = rank(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index]! > b[index]!;
    }
    return false;
  };
  for (const rule of rules) {
    if (rule.target.kind === "text" || !approvalRuleOwnerAnswers(rule.owner, subject) || !targetMatches(rule.target, subject)) continue;
    if (rule.decision === "block" && (block === undefined || better(rule, block))) block = rule;
    if (best === undefined || better(rule, best)) best = rule;
  }
  if (block) return { decision: "block", rule: block };
  return best ? { decision: best.decision, rule: best } : undefined;
}

/** The natural-language rules that answer for this Bot. */
export function approvalTextRulesFor(rules: readonly ApprovalRule[], botId: string): ApprovalRule[] {
  return rules.filter((rule) => rule.target.kind === "text" && approvalRuleOwnerAnswers(rule.owner, { botId }));
}

// ---------------------------------------------------------------------------
// The page

/** Where a row on the page comes from, so Change and Remove reach the right store. */
export type ApprovalRuleRowRef =
  /** A rule on this page. */
  | { source: "rule"; id: string }
  /** A workspace's remembered exact command or file ("Always allow" before modes). */
  | { source: "workspace-exact"; id: string }
  /** A Bot's "Always allow for {Bot}" (its allow list), legacy-scoped to that Bot. */
  | { source: "bot-allow"; botId: string; entryId: string }
  /** A folder a Bot may change, legacy-scoped to that Bot. */
  | { source: "bot-folder"; botId: string; entryId: string }
  /** A Bot rule from before this page: a custom rule, or a built-in set to Hand off to me. */
  | { source: "bot-rule"; botId: string; ruleId: string }
  /** "Allowed in this workspace" on a Mac card. */
  | { source: "workspace-mac"; workspaceId: string; grant: "shell" | "files" | "computer-use" }
  /** "Allowed in this chat" on a Bot's Mac card. */
  | { source: "bot-chat-mac"; botId: string; grantId: string }
  /** The legacy Computer Use switch "Always allow in every chat". */
  | { source: "computer-use-everywhere" };

export type ApprovalRuleRowGroup = "allow" | "ask" | "block" | "mac";

export interface ApprovalRuleRowScope {
  kind: "mac" | "workspace" | "bot" | "chat";
  /** The workspace or Bot's name; a chat's Bot name. */
  label?: string;
}

export interface ApprovalRuleRow {
  ref: ApprovalRuleRowRef;
  group: ApprovalRuleRowGroup;
  /** What the rule is about, as the row's title. */
  title: string;
  /** "Site", "Tool", "Connector", "When a Bot wants to", "Command"… */
  kind: string;
  scope: ApprovalRuleRowScope;
  /** Migrated from a Bot or a workspace before this page: it answers only for that owner. */
  legacy?: true;
  /** The segments this row offers. Empty: read and remove only. */
  decisions: readonly ApprovalRuleDecision[];
  /** The row menu's "Do it myself", when the row offers it. */
  handOff?: { on: boolean };
  /** A row whose decision cannot change and that cannot be removed here (built-in hand-off: Remove sets it back). */
  createdAt?: string;
}

export interface ApprovalRulesView {
  rows: ApprovalRuleRow[];
}

/** One option in Add rule's searchable picker. */
export interface ApprovalRulePickerOption {
  target: ApprovalRuleTarget;
  label: string;
  /** "Aiden", or the connected app's name. */
  group: string;
  description?: string;
}

export interface ApprovalRuleAddInput {
  target: ApprovalRuleTarget;
  decision: ApprovalRuleDecision;
  /** Absent: the whole Mac. */
  owner?: ApprovalRuleOwner;
  handOff?: boolean;
  label?: string;
}

export interface ApprovalRuleChangeInput {
  ref: ApprovalRuleRowRef;
  decision?: ApprovalRuleDecision;
  handOff?: boolean;
}

export const APPROVAL_RULE_CHANNELS = {
  list: "chat:approvalRules:list",
  picker: "chat:approvalRules:picker",
  add: "chat:approvalRules:add",
  change: "chat:approvalRules:change",
  remove: "chat:approvalRules:remove",
  changed: "chat:approvalRules:changed",
} as const;

const MAC_GRANTS = new Set(["shell", "files", "computer-use"]);

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

/** Strict parse of a row reference from the renderer. */
export function parseApprovalRuleRowRef(value: unknown): ApprovalRuleRowRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid rule.");
  const record = value as Record<string, unknown>;
  switch (record.source) {
    case "rule":
    case "workspace-exact":
      if (exactKeys(record, ["source", "id"]) && typeof record.id === "string" && RULE_ID.test(record.id)) {
        return { source: record.source, id: record.id };
      }
      break;
    case "bot-allow":
    case "bot-folder":
      if (exactKeys(record, ["source", "botId", "entryId"]) && validId(record.botId) && validId(record.entryId)) {
        return { source: record.source, botId: record.botId, entryId: record.entryId };
      }
      break;
    case "bot-rule":
      if (exactKeys(record, ["source", "botId", "ruleId"]) && validId(record.botId) && validId(record.ruleId)) {
        return { source: "bot-rule", botId: record.botId, ruleId: record.ruleId };
      }
      break;
    case "workspace-mac":
      if (exactKeys(record, ["source", "workspaceId", "grant"]) && validId(record.workspaceId) && MAC_GRANTS.has(record.grant as string)) {
        return { source: "workspace-mac", workspaceId: record.workspaceId, grant: record.grant as "shell" | "files" | "computer-use" };
      }
      break;
    case "bot-chat-mac":
      if (exactKeys(record, ["source", "botId", "grantId"]) && validId(record.botId) && typeof record.grantId === "string" && RULE_ID.test(record.grantId)) {
        return { source: "bot-chat-mac", botId: record.botId, grantId: record.grantId };
      }
      break;
    case "computer-use-everywhere":
      if (exactKeys(record, ["source"])) return { source: "computer-use-everywhere" };
      break;
  }
  throw new Error("Invalid rule.");
}

export function parseApprovalRuleAddInput(value: unknown): ApprovalRuleAddInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid rule.");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["target", "decision", "owner", "handOff", "label"])) throw new Error("Invalid rule.");
  const target = parseApprovalRuleTarget(record.target);
  const decision = parseApprovalRuleDecision(record.decision);
  if (!target) throw new Error(target === undefined && (record.target as { kind?: unknown } | undefined)?.kind === "text"
    ? `Describe the action in a few words, in up to ${BOT_RULE_TEXT_MAX_CHARS} characters.`
    : "Invalid rule.");
  if (!decision || !approvalRuleDecisionsFor(target).includes(decision)) throw new Error("Invalid rule.");
  const owner = record.owner === undefined ? undefined : parseApprovalRuleOwner(record.owner);
  if (record.owner !== undefined && (!owner || owner.kind === "bot")) throw new Error("Invalid rule.");
  if (record.handOff !== undefined && typeof record.handOff !== "boolean") throw new Error("Invalid rule.");
  if (record.label !== undefined && (typeof record.label !== "string" || record.label.length > MAX_LABEL_CHARS || hasControl(record.label))) {
    throw new Error("Invalid rule.");
  }
  return {
    target,
    decision,
    ...(owner ? { owner } : {}),
    ...(record.handOff === true ? { handOff: true } : {}),
    ...(typeof record.label === "string" && record.label.trim() ? { label: record.label.trim() } : {}),
  };
}

export function parseApprovalRuleChangeInput(value: unknown): ApprovalRuleChangeInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid rule.");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["ref", "decision", "handOff"])) throw new Error("Invalid rule.");
  const ref = parseApprovalRuleRowRef(record.ref);
  const decision = record.decision === undefined ? undefined : parseApprovalRuleDecision(record.decision);
  if (record.decision !== undefined && !decision) throw new Error("Invalid rule.");
  if (record.handOff !== undefined && typeof record.handOff !== "boolean") throw new Error("Invalid rule.");
  if (decision === undefined && record.handOff === undefined) throw new Error("Invalid rule.");
  return { ref, ...(decision ? { decision } : {}), ...(typeof record.handOff === "boolean" ? { handOff: record.handOff } : {}) };
}

/** The row's title for a target rule. */
export function describeApprovalRuleTarget(target: ApprovalRuleTarget, label?: string): string {
  if (label) return label;
  switch (target.kind) {
    case "tool":
      return target.tool;
    case "connector":
      return target.serverId;
    case "connector-tool":
      return `${target.serverId} · ${target.tool}`;
    case "site":
      return target.host;
    case "text":
      return target.text.charAt(0).toLocaleUpperCase() + target.text.slice(1);
  }
}

export function approvalRuleKindLabel(kind: ApprovalRuleTargetKind): string {
  switch (kind) {
    case "tool":
      return "Tool";
    case "connector":
      return "Connected app";
    case "connector-tool":
      return "Tool";
    case "site":
      return "Site";
    case "text":
      return "When a Bot wants to";
  }
}

/** The group a stored decision lists under. */
export function approvalRuleGroupOf(decision: ApprovalRuleDecision): Exclude<ApprovalRuleRowGroup, "mac"> {
  return decision;
}

/**
 * Aiden's own tools that Add rule offers: the ones that change or send
 * something, or reach the web. Labels say what the tool does.
 */
export const APPROVAL_RULE_AIDEN_TOOLS: readonly { tool: string; label: string; description?: string }[] = [
  { tool: "browser_click", label: "Click on a web page" },
  { tool: "browser_type", label: "Type on a web page" },
  { tool: "browser_press", label: "Press keys on a web page" },
  { tool: "browser_evaluate", label: "Run a script on a web page", description: "Workspace chats only" },
  { tool: "browser_navigate", label: "Go to a web page" },
  { tool: "web_fetch", label: "Fetch a web page" },
  { tool: "web_search", label: "Search the web" },
  { tool: "share_image", label: "Share an image" },
  { tool: "generate_image", label: "Create an image" },
  { tool: "run_command", label: "Run a command", description: "Your Mac still asks on first use" },
  { tool: "write_file", label: "Create or replace a file", description: "Your Mac still asks on first use" },
  { tool: "edit_file", label: "Edit a file", description: "Your Mac still asks on first use" },
  { tool: "background_job", label: "Start a background job" },
  { tool: "forget_fact", label: "Forget a memory" },
];
