// Strict version-one decoding. A malformed record invalidates the whole file;
// a partial salvage could erase an ended identity and show a new approval.
import { BOT_PLAN_LIMITS, BOT_PLAN_MAX_MS, type BotPlanItem } from "../../../renderer/shared/bot-plans.js";
import { botAccessAuthorizationOf } from "../../../renderer/shared/bot-access-requests.js";
import { botPlanProposalFingerprint, type BotPlanProposal } from "./validate.js";
import type { BotPlanRecord, BotPlanReceipt } from "./plans.js";

export interface BotPlanFile { version: 1; plans: BotPlanRecord[]; receipts: BotPlanReceipt[] }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k));
// eslint-disable-next-line no-control-regex -- Reject hidden control and direction marks in persisted authority.
const text = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && [...v].length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v);
const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const planId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9-]{1,64}$/u.test(v);
const strings = (v: unknown, maxLength: number): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= maxLength && v.every((s) => text(s, 256)) && new Set(v).size === v.length;
const cap = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= BOT_PLAN_LIMITS.maxCeiling;
const ended = (v: unknown) => v === "finished" || v === "stopped" || v === "expired";

function itemOf(v: unknown, index: number): v is BotPlanItem {
  if (!obj(v) || v.id !== `i${index + 1}`) return false;
  switch (v.kind) {
    case "connector": return keys(v, ["id", "kind", "app", "action", "tools", "max"]) && text(v.app, 200) && text(v.action, BOT_PLAN_LIMITS.actionChars) && cap(v.max) && Array.isArray(v.tools) && v.tools.length > 0 && v.tools.length <= BOT_PLAN_LIMITS.toolsPerItem && v.tools.every((t) => obj(t) && keys(t, ["modelName", "serverId", "remoteName", "title"]) && text(t.modelName, 256) && text(t.serverId, 256) && text(t.remoteName, 256) && text(t.title, 256)) && new Set(v.tools.map((t) => t.serverId)).size === 1;
    case "site": return keys(v, ["id", "kind", "host", "max"]) && text(v.host, 253) && /^[a-z0-9.-]+$/u.test(v.host) && v.host.includes(".") && cap(v.max);
    case "files": return keys(v, ["id", "kind", "path", "access", "grant"]) && text(v.path, 4096) && (v.path.startsWith("/") || v.path === "~" || v.path.startsWith("~/")) && v.path !== "/" && (v.access === "read" || v.access === "write") && typeof v.grant === "boolean";
    case "shell": return keys(v, ["id", "kind"]);
    case "rule": return keys(v, ["id", "kind", "ruleId", "ruleFingerprint", "label", "max"]) && text(v.ruleId, 256) && !["locked.money", "locked.credentials"].includes(v.ruleId) && text(v.ruleFingerprint, 256) && text(v.label, 200) && cap(v.max);
    default: return false;
  }
}

export function isBotPlanProposal(v: unknown): v is BotPlanProposal {
  if (!obj(v) || !keys(v, ["title", "why", "steps", "items", "authorization"]) || !text(v.title, 80) || !text(v.why, 300) || !Array.isArray(v.steps) || !v.steps.length || v.steps.length > 10 || !v.steps.every((s) => text(s, 200)) || !Array.isArray(v.items) || !v.items.length || v.items.length > 8 || !v.items.every(itemOf)) return false;
  const a = v.authorization;
  if (!obj(a) || !keys(a, ["policyRevision", "bindingRevision", "proposalFingerprint", "rules", "folder"]) || !text(a.policyRevision, 256) || !text(a.bindingRevision, 256) || !hash(a.proposalFingerprint) || !Array.isArray(a.rules) || a.rules.length > 8 || !a.rules.every((r) => obj(r) && keys(r, ["id", "fingerprint"]) && text(r.id, 256) && text(r.fingerprint, 256))) return false;
  const grants = (v.items as BotPlanItem[]).filter((i) => i.kind === "files" && i.grant);
  if (grants.length > 1) return false;
  if (a.folder !== undefined) {
    const folder = botAccessAuthorizationOf(a.folder);
    if (!folder || folder.target !== "folder" || grants.length !== 1 || grants[0]!.kind !== "files" || grants[0].path !== folder.root) return false;
  } else if (grants.length) return false;
  const refs = (v.items as BotPlanItem[]).flatMap((i) => i.kind === "rule" ? [{ id: i.ruleId, fingerprint: i.ruleFingerprint }] : []);
  if (JSON.stringify(refs) !== JSON.stringify(a.rules)) return false;
  return botPlanProposalFingerprint(v as unknown as BotPlanProposal) === a.proposalFingerprint;
}

function recordOf(v: unknown, botId: string): v is BotPlanRecord {
  if (!obj(v) || !keys(v, ["planId", "botId", "toolCallId", "proposal", "requestIds", "status", "steps", "from", "approvedAt", "expiresAt", "deadline", "endedAt", "revision", "counted"]) || !planId(v.planId) || v.botId !== botId || !text(v.toolCallId, 256) || !isBotPlanProposal(v.proposal) || !strings(v.requestIds, 256) || (v.status !== "active" && !ended(v.status)) || !Array.isArray(v.steps) || v.steps.length !== v.proposal.steps.length || !v.steps.every((s) => s === "pending" || s === "done" || s === "skipped") || (v.from !== undefined && !text(v.from, 120)) || !time(v.approvedAt) || !time(v.expiresAt) || v.expiresAt <= v.approvedAt || v.expiresAt > v.approvedAt + BOT_PLAN_MAX_MS || !Number.isSafeInteger(v.revision) || (v.revision as number) < 1 || !obj(v.counted)) return false;
  if (v.deadline !== undefined && (!time(v.deadline) || v.expiresAt > v.deadline)) return false;
  if (v.status === "active" ? v.endedAt !== undefined || v.steps.every((s) => s !== "pending") : !time(v.endedAt)) return false;
  const used = new Map<string, number>();
  for (const [executionId, reservation] of Object.entries(v.counted)) {
    if (!text(executionId, 256) || !obj(reservation) || !keys(reservation, ["operationFingerprint", "itemIds", "admittedAt"]) || !text(reservation.operationFingerprint, 512) || !strings(reservation.itemIds, 8) || (reservation.admittedAt !== undefined && (!time(reservation.admittedAt) || reservation.admittedAt < v.approvedAt || reservation.admittedAt >= v.expiresAt))) return false;
    for (const id of reservation.itemIds) {
      const item = v.proposal.items.find((i) => i.id === id);
      if (!item || !("max" in item)) return false;
      const count = (used.get(id) ?? 0) + 1;
      if (count > item.max) return false;
      used.set(id, count);
    }
  }
  return true;
}

export function parseBotPlanFile(value: unknown, botId: string): BotPlanFile | undefined {
  if (!obj(value) || !keys(value, ["version", "plans", "receipts"]) || value.version !== 1 || !Array.isArray(value.plans) || value.plans.length > 20 || !value.plans.every((p) => recordOf(p, botId)) || new Set(value.plans.map((p) => p.planId)).size !== value.plans.length || value.plans.filter((p) => p.status === "active").length > 1 || !Array.isArray(value.receipts)) return undefined;
  for (const r of value.receipts) {
    if (!obj(r) || !keys(r, ["planId", "identityFingerprint", "status", "expiresAt", "endedAt", "executionFingerprints"]) || !planId(r.planId) || !hash(r.identityFingerprint) || !ended(r.status) || !time(r.expiresAt) || !time(r.endedAt) || !Array.isArray(r.executionFingerprints) || !r.executionFingerprints.every(hash) || new Set(r.executionFingerprints).size !== r.executionFingerprints.length) return undefined;
    const full = value.plans.find((p) => p.planId === r.planId);
    if (full && (full.status !== r.status || full.expiresAt !== r.expiresAt || full.endedAt !== r.endedAt)) return undefined;
  }
  if (new Set(value.receipts.map((r) => r.planId)).size !== value.receipts.length) return undefined;
  return value as unknown as BotPlanFile;
}
