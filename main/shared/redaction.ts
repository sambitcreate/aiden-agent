/**
 * One credential-redaction table for text that leaves its trust boundary
 * (remote summaries, forked subagent context, Git/GitHub error messages).
 * Patterns are ordered: whole private-key blocks first, then keyed
 * assignments, then self-identifying vendor token formats.
 */

import { BARE_CREDENTIAL_TOKEN } from "../../renderer/shared/credential-tokens.js";

/** Credential shapes that are unambiguous wherever they appear. */
export const CREDENTIAL_TOKEN_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [^-\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\n]+ PRIVATE KEY-----/giu,
  /\bauthorization\s*:\s*bearer\s*[:=]?\s*[^\s,;]+/giu,
  /\b(?:api[_ -]?key|access[_ -]?token|password|secret)["']?\s*[:=]\s*[^\s,;]+/giu,
  BARE_CREDENTIAL_TOKEN,
];

/** Replace every credential match from {@link CREDENTIAL_TOKEN_PATTERNS}. */
export function redactCredentialTokens(text: string, placeholder: string): string {
  return CREDENTIAL_TOKEN_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, placeholder),
    text,
  );
}

const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/giu;
const URL_SECRET_QUERY =
  /([?&](?:access_token|auth|key|password|private_token|signature|token)=)[^&\s]+/giu;

/** Mask URL userinfo and secret-bearing query values, keeping the URL shape. */
export function redactUrlCredentials(text: string): string {
  return text.replace(URL_USERINFO, "$1***@").replace(URL_SECRET_QUERY, "$1***");
}
