/** Self-identifying credential shapes shared by logs, remote text and subagents.
 * Opaque unlabelled secrets cannot be identified reliably; callers should omit
 * arbitrary provider detail rather than treating redaction as a content filter.
 */
export const BARE_CREDENTIAL_TOKEN = /(?<![A-Za-z0-9])(?:(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|SG\.[0-9A-Za-z_-]{12,}\.[0-9A-Za-z_-]{12,}|eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}|gh[pousr]_[0-9A-Za-z]{16,}|github_pat_[0-9A-Za-z_]{16,}|glpat-[0-9A-Za-z_-]{10,}|hf_[0-9A-Za-z]{10,}|npm_[0-9A-Za-z]{10,}|pypi-[0-9A-Za-z_-]{10,}|sk-[0-9A-Za-z_-]{8,}|(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{12,}|xox[baprs]-[0-9A-Za-z-]{8,}|ya29\.[0-9A-Za-z_-]{10,}|(?:r8_|gsk_|pplx-|csk-|nvapi-)[0-9A-Za-z_-]{16,}|tskey-(?:auth|api)-[0-9A-Za-z_-]{16,}|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}:[0-9A-Za-z_-]{16,})(?![A-Za-z0-9])/gu;

export function redactBareCredentialTokens(value: string, replacement: string): string {
  return value.replace(BARE_CREDENTIAL_TOKEN, () => replacement);
}
