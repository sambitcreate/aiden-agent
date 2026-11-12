// Settings → Approvals, the rules page, over desktop IPC (plan §3.5).
//
// - `chat:approvalRules:list` → every rule and Mac grant, in one list.
// - `chat:approvalRules:picker` → Add rule's searchable options.
// - `chat:approvalRules:add` / `change` / `remove`, strictly parsed.
// - `chat:approvalRules:changed` tells every window to read the list again,
//   for instance after Always on a card added a row.
//
// Only the desktop answers these: phones keep their own Bot screens until
// Phase 6, and the Remote API is unchanged.

import {
  APPROVAL_RULE_CHANNELS,
  parseApprovalRuleAddInput,
  parseApprovalRuleChangeInput,
  parseApprovalRuleRowRef,
} from "../../renderer/shared/approval-rules.js";
import type { ApprovalRulesPage } from "../services/approval-rules/rules-page.js";

export interface ApprovalRuleHandlerDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  page: ApprovalRulesPage;
  /** Every source of a row, so a change anywhere refreshes the page. */
  onChange(listener: () => void): () => void;
  broadcast(channel: typeof APPROVAL_RULE_CHANNELS.changed, payload: Record<string, never>): void;
}

export function registerApprovalRuleHandlers<Event = unknown>(deps: ApprovalRuleHandlerDependencies<Event>): () => void {
  deps.handle(APPROVAL_RULE_CHANNELS.list, async () => deps.page.list());
  deps.handle(APPROVAL_RULE_CHANNELS.picker, async () => deps.page.picker());
  deps.handle(APPROVAL_RULE_CHANNELS.add, async (_event, input) => deps.page.add(parseApprovalRuleAddInput(input)));
  deps.handle(APPROVAL_RULE_CHANNELS.change, async (_event, input) => deps.page.change(parseApprovalRuleChangeInput(input)));
  deps.handle(APPROVAL_RULE_CHANNELS.remove, async (_event, input) => {
    const record = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
    if (!record || Object.keys(record).some((key) => key !== "ref")) throw new Error("Invalid rule.");
    return deps.page.remove(parseApprovalRuleRowRef(record.ref));
  });
  return deps.onChange(() => deps.broadcast(APPROVAL_RULE_CHANNELS.changed, {}));
}
