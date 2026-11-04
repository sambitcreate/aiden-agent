import { isPathSafeBotCapabilityId } from "./bot-capabilities.js";
import { BOT_LIMITS } from "./bots.js";

export const BOT_PROPOSE_PLAN_TOOL_NAME = "propose_plan";
export const BOT_PLAN_STEP_TOOL_NAME = "plan_step";
export const BOT_PLAN_MAX_MS = 3_600_000;
export const BOT_PLAN_ENDED_SHOWN_MS = 1_800_000;
export const BOT_PLAN_LIMITS = { titleChars: 80, whyChars: 300, steps: 10, stepChars: 200, covers: 8,
  actionChars: 60, toolsPerItem: 5, defaultMax: 10, maxCeiling: 25 } as const;

export type BotPlanCoverInput =
  | { connector: string; action: string; tools: string[]; max?: number }
  | { site: string; action: "browse"; max?: number }
  | { files: string; action: "read" | "write" }
  | { shell: "bot_home" }
  | { rule: string; max?: number };

export type BotPlanItem =
  | { id: string; kind: "connector"; app: string; action: string; tools: { modelName: string; serverId: string; remoteName: string; title: string }[]; max: number }
  | { id: string; kind: "site"; host: string; max: number }
  | { id: string; kind: "files"; path: string; access: "read" | "write"; grant: boolean }
  | { id: string; kind: "shell" }
  | { id: string; kind: "rule"; ruleId: string; ruleFingerprint: string; label: string; max: number };

export type BotPlanStepStatus = "pending" | "done" | "skipped";
export type BotPlanStatus = "pending" | "active" | "finished" | "stopped" | "expired";
export interface BotPlanItemView { id: string; line: string; details: string[]; used?: number; max?: number }
export interface BotPlanView {
  planId: string; botId: string; status: BotPlanStatus; title: string; why: string;
  steps: { text: string; status: BotPlanStepStatus }[]; items: BotPlanItemView[];
  expiresAt?: number; revision: number; from?: string;
}

export function botPlanItemView(item: BotPlanItem, used: number): BotPlanItemView {
  switch (item.kind) {
    case "connector": return { id: item.id, line: `${item.app} · ${item.action} (up to ${item.max})`, details: item.tools.map((tool) => tool.title), used, max: item.max };
    case "site": return { id: item.id, line: `${item.host} · click and type (up to ${item.max})`, details: [`Clicks, typing and key presses on ${item.host} and its subdomains`], used, max: item.max };
    case "files": return { id: item.id, line: `Files · ${item.access === "write" ? "change" : "read"} ${item.path}${item.grant ? " for this plan" : ""}`, details: [item.path, ...(item.grant ? [`${item.access === "write" ? "Read and change" : "Read only"} · allowed once, for this plan only`] : [])] };
    case "shell": return { id: item.id, line: "Commands · in its own folder", details: [] };
    case "rule": return { id: item.id, line: `Rule · ${item.label} (up to ${item.max})`, details: [`Steps your rule “${item.label}” would ask about`], used, max: item.max };
  }
}

export function botPlanProgress(view: Pick<BotPlanView, "steps">): { done: number; total: number } {
  return { done: view.steps.filter(({ status }) => status === "done" || status === "skipped").length, total: view.steps.length };
}

export const BOT_PLAN_CHANNELS = { respond: "bots:plans:respond" } as const;
export type BotPlanDecision = "approve" | "not_now" | "stop";

export function parseBotPlanResponse(value: unknown): { botId: string; planId: string; decision: BotPlanDecision } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plan response.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "botId,decision,planId" ||
      !isPathSafeBotCapabilityId(v.botId, BOT_LIMITS.idChars) ||
      typeof v.planId !== "string" || !/^[A-Za-z0-9-]{1,64}$/u.test(v.planId) ||
      (v.decision !== "approve" && v.decision !== "not_now" && v.decision !== "stop")) throw new Error("Invalid plan response.");
  return { botId: v.botId, planId: v.planId, decision: v.decision };
}
