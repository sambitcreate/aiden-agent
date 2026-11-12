/** Electron-main binding for the rules page's own rules. */

import { app } from "../../platform.js";
import { DataStore } from "../data-store.js";
import {
  APPROVAL_RULES_FILE,
  APPROVAL_RULES_MAX_BYTES,
  emptyApprovalRulesDocument,
  normalizeApprovalRulesDocument,
  type ApprovalRulesDocument,
} from "../../../renderer/shared/approval-rules.js";
import { ApprovalRuleBook } from "./store.js";

/** Device-local and never portable: a rule is a consent on this Mac. */
const store = new DataStore<ApprovalRulesDocument>(
  APPROVAL_RULES_FILE,
  emptyApprovalRulesDocument(),
  () => app.getPath("userData"),
  {
    maxBytes: APPROVAL_RULES_MAX_BYTES,
    fileMode: 0o600,
    normalize: normalizeApprovalRulesDocument,
    preserveCorruptFile: true,
    // Re-read before each change, so a rule removed by hand is never restored.
    reloadBeforeWrite: true,
  },
);

export const approvalRules = new ApprovalRuleBook(store);
