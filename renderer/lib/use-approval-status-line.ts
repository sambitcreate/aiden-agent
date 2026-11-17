// An answered approval card collapses to one line ("Allowed once", "Denied",
// "No longer active") where it was, for a few seconds, then leaves.

import * as React from "react";
import type { ApprovalStatus } from "../components/approval-card-parts";

export const APPROVAL_STATUS_LINE_MS = 4000;

/** The line an answered card leaves behind. A new `resetKey` (another chat) clears it. */
export function useApprovalStatusLine(resetKey: unknown) {
  const [status, setStatus] = React.useState<ApprovalStatus | null>(null);
  React.useEffect(() => {
    setStatus(null);
  }, [resetKey]);
  React.useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), APPROVAL_STATUS_LINE_MS);
    return () => clearTimeout(timer);
  }, [status]);
  const clear = React.useCallback(() => setStatus(null), []);
  return { status, show: setStatus, clear };
}
