/** Electron-main binding for remembered tool approval rules. */

import { app } from "../platform.js";
import { DataStore } from "./data-store.js";
import {
  emptyToolApprovalRulesDocument,
  normalizeToolApprovalRulesDocument,
  ToolApprovalRuleBook,
  TOOL_APPROVAL_RULES_FILE,
  TOOL_APPROVAL_RULES_MAX_BYTES,
  type ToolApprovalRulesDocument,
} from "./tool-approval-rules.js";

/** Device-local and never portable: an always-allow rule is a local consent. */
const store = new DataStore<ToolApprovalRulesDocument>(
  TOOL_APPROVAL_RULES_FILE,
  emptyToolApprovalRulesDocument(),
  () => app.getPath("userData"),
  {
    maxBytes: TOOL_APPROVAL_RULES_MAX_BYTES,
    fileMode: 0o600,
    normalize: normalizeToolApprovalRulesDocument,
    preserveCorruptFile: true,
    // Re-read before each change so a revoke or grant never resurrects a rule
    // removed by hand while the app was running.
    reloadBeforeWrite: true,
  },
);

export const toolApprovalRules = new ToolApprovalRuleBook(store);
