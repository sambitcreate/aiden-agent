import type { ToolApprovalScope } from "./tool-approval-scope.js";

/**
 * The once-per-chat Computer Use access request. The model raises it with its
 * first `computer_use` call in a chat that has no grant; the answer covers the
 * whole chat ("chat") or every chat ("always"), so there is no "once".
 */
export const COMPUTER_USE_ACCESS_APPROVAL_KIND = "computer-use-access";

export const COMPUTER_USE_ACCESS_SCOPES: readonly ToolApprovalScope[] = ["chat", "always"];

export interface ComputerUseAccessApprovalDetails {
  kind: typeof COMPUTER_USE_ACCESS_APPROVAL_KIND;
}

export function isComputerUseAccessApprovalDetails(
  value: unknown,
): value is ComputerUseAccessApprovalDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === COMPUTER_USE_ACCESS_APPROVAL_KIND
  );
}

/** The continuation turn sent when the user resumes after finishing setup. */
export const COMPUTER_USE_CONTINUE_PROMPT =
  "Continue the previous task now that Computer Use is available.";
