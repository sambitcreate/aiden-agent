/** Reads the rules page's rule for one call, for the workspace and Bot gates. */

import { logger } from "../../platform.js";
import {
  approvalTextRulesFor,
  resolveApprovalRule,
  type ApprovalRule,
  type ApprovalRuleDecision,
  type ApprovalRuleSubject,
} from "../../../renderer/shared/approval-rules.js";
import { approvalRules } from "./store-main.js";

/**
 * The decision of the rule that answers for this call, if any. A rule book
 * that cannot be read asks: it may hold a Block.
 */
export async function pageRuleFor(subject: ApprovalRuleSubject): Promise<ApprovalRuleDecision | undefined> {
  try {
    return resolveApprovalRule(await approvalRules.list(), subject)?.decision;
  } catch (error) {
    logger.warn("approvals", "Could not read the approval rules; asking instead.", error);
    return "ask";
  }
}

/** The natural-language rules that answer for this Bot; unreadable rules are reported, not skipped. */
export async function pageTextRulesFor(botId: string): Promise<ApprovalRule[]> {
  return approvalTextRulesFor(await approvalRules.list(), botId);
}
