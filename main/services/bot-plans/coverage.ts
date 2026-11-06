import { COMPUTER_USE_TOOL_NAME } from "../computer-use/tool.js";
import type { BotClassifiableAction } from "../bot-rules/classify.js";
import { isPaymentHost } from "../bot-rules/words.js";
import type { BotPlanRecord } from "./plans.js";

export interface BotPlanCoverCheck {
  executionId: string;
  operationFingerprint: string;
  toolName: string;
  requestIds: readonly (string | undefined)[];
  action?: BotClassifiableAction;
  baseline: boolean;
  rules: readonly { id: string; fingerprint: string }[];
}

/** All required surface/rule items, or no coverage. Files and shell never invent an approval. */
export function botPlanCoveredItems(plan: BotPlanRecord, used: ReadonlyMap<string, number>, check: BotPlanCoverCheck, now: number): string[] | undefined {
  if (plan.status !== "active" || now < plan.approvedAt || now >= plan.expiresAt ||
      !plan.requestIds.some((id) => check.requestIds.includes(id)) ||
      check.toolName === COMPUTER_USE_TOOL_NAME || check.action?.surface === "computer_use") return undefined;
  const matched = new Set<string>();
  if (check.baseline) {
    const action = check.action;
    const surfaces = plan.proposal.items.filter((item) => {
      if (item.kind === "connector" && action?.surface === "mcp") {
        return item.tools.some((tool) => tool.serverId === action.serverId && tool.remoteName === action.remoteName);
      }
      if (item.kind !== "site" || action?.surface !== "browser" || !action.url) return false;
      try {
        const url = new URL(action.url);
        return ["https:", "http:"].includes(url.protocol) && !isPaymentHost(url.hostname) &&
          (url.hostname === item.host || url.hostname.endsWith(`.${item.host}`));
      } catch { return false; }
    });
    if (!surfaces.length) return undefined;
    for (const item of surfaces) matched.add(item.id);
  }
  for (const ref of check.rules) {
    if (ref.id === "locked.credentials" || ref.id === "locked.money") return undefined;
    const items = plan.proposal.items.filter((item) => item.kind === "rule" && item.ruleId === ref.id && item.ruleFingerprint === ref.fingerprint);
    if (!items.length) return undefined;
    for (const item of items) matched.add(item.id);
  }
  if (!matched.size) return undefined;
  for (const item of plan.proposal.items) {
    if (!matched.has(item.id)) continue;
    if (!("max" in item) || (used.get(item.id) ?? 0) >= item.max) return undefined;
  }
  return [...matched];
}
