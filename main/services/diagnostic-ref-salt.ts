// A per-install random salt for diagnostic references (hashes that let lines
// about one configured thing be matched without naming it). It lives next to
// the diagnostic journal and is deleted with the rest of the diagnostic data,
// so references in old exports cannot be linked to new ones.

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { diagnosticJournalPath } from "./diagnostic-journal.js";

export const DIAGNOSTIC_REF_SALT_FILE = "diagnostic-ref-salt";
const SALT = /^[0-9a-f]{64}$/u;

let cached: { journal: string | null; salt: string } | undefined;

function newSalt(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The salt for this install. Without an initialized journal (tests, early
 * startup) it is random per process and never written.
 */
export function diagnosticRefSalt(): string {
  const journal = diagnosticJournalPath();
  if (cached && cached.journal === journal) return cached.salt;
  let salt: string | undefined;
  if (journal) {
    const file = path.join(path.dirname(journal), DIAGNOSTIC_REF_SALT_FILE);
    try {
      const stored = readFileSync(file, "utf8").trim();
      if (SALT.test(stored)) salt = stored;
    } catch {
      // Missing or unreadable: create one below.
    }
    if (!salt) {
      salt = newSalt();
      try {
        writeFileSync(file, `${salt}\n`, { mode: 0o600 });
      } catch {
        // Unwritable: references stay stable for this process only.
      }
    }
  }
  cached = { journal, salt: salt ?? newSalt() };
  return cached.salt;
}

/** Forget the cached salt (its file was deleted with the diagnostic data). */
export function forgetDiagnosticRefSalt(): void {
  cached = undefined;
}
