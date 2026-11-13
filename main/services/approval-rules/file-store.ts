// The rules page's file, `approval-rules.json`, as a store for the book.
//
// A file this release can't read back exactly (it doesn't parse, or holds a
// newer version, a rule this release can't read or a duplicate) is never read
// around and never written over: its Block rules may be the ones Aiden can't
// see (a newer release's file can Block any tool by name). The book then
// reports it unreadable, so every workspace call asks once and Bots refuse,
// until the person fixes it or sets it aside from the page.

import fs from "node:fs/promises";
import path from "node:path";
import { DataStore } from "../data-store.js";
import {
  APPROVAL_RULES_FILE,
  APPROVAL_RULES_MAX_BYTES,
  emptyApprovalRulesDocument,
  isApprovalRulesDocumentSafe,
  normalizeApprovalRulesDocument,
  type ApprovalRulesDocument,
} from "../../../renderer/shared/approval-rules.js";
import type { ApprovalRuleStore } from "./store.js";

export function fileApprovalRuleStore(root: () => string, now: () => Date = () => new Date()): ApprovalRuleStore {
  // Device-local and never portable: a rule is a consent on this Mac.
  const store = new DataStore<ApprovalRulesDocument>(APPROVAL_RULES_FILE, emptyApprovalRulesDocument(), root, {
    maxBytes: APPROVAL_RULES_MAX_BYTES,
    fileMode: 0o600,
    normalize: normalizeApprovalRulesDocument,
    isSafe: isApprovalRulesDocumentSafe,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
    preserveCorruptFile: true,
    // Re-read before each change, so a rule removed by hand is never restored.
    reloadBeforeWrite: true,
  });
  const readable = async () => !(await store.loadedFromCorruptFile()) && !(await store.loadedFromUnsafeFile());
  return {
    load: () => store.load(),
    update: (mutation) => store.update(mutation),
    readable,
    refresh: async () => {
      await store.reload();
    },
    setAside: async () => {
      // Only an unreadable file is put aside, and its bytes stay beside it.
      if (await readable()) return;
      const file = await store.path();
      const stamp = now().toISOString().replace(/[:.]/gu, "-");
      await fs.rename(file, path.join(path.dirname(file), `${path.basename(file)}.unreadable-${stamp}`)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await store.reload();
    },
  };
}
