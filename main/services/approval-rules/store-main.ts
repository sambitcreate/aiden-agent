/** Electron-main binding for the rules page's own rules. */

import { app } from "../../platform.js";
import { fileApprovalRuleStore } from "./file-store.js";
import { ApprovalRuleBook } from "./store.js";

export const approvalRules = new ApprovalRuleBook(fileApprovalRuleStore(() => app.getPath("userData")));
