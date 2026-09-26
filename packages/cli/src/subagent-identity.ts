import { createHash } from "node:crypto";
import { isSafeSubagentIdentifier } from "../../../renderer/shared/subagent-runs.js";

/** Random identifiers can accidentally decode as private text; keep that boundary intact. */
export function cliSubagentIdentity(value: string): string {
  if (isSafeSubagentIdentifier(value)) return value;
  for (let attempt = 0; attempt < 128; attempt++) {
    const candidate = `cli-${createHash("sha256").update(value).update(String(attempt)).digest("hex")}`;
    if (isSafeSubagentIdentifier(candidate)) return candidate;
  }
  throw new Error("Could not allocate a safe subagent identity.");
}
