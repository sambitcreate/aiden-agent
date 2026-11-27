/**
 * The workspace credential policy applied to a DESIGN.md's real target: a
 * DESIGN.md that is, or links to, `.env`, `.npmrc`, a key or anything else
 * `isProtectedCredentialPath` keeps from the model is never read (S11).
 */
import path from "node:path";
import { isEnvironmentSecretPath, isProtectedCredentialPath } from "../../model-file-policy.js";

/** True when `realPath` (inside `realRoot`) is a file the credential policy protects. */
export function isCredentialTarget(realRoot: string, realPath: string): boolean {
  const relative = path.relative(realRoot, realPath);
  return isProtectedCredentialPath(relative, "file") || isEnvironmentSecretPath(relative);
}
