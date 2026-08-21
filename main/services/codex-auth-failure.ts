/** Closed authentication classifier shared by main and the isolated worker. */
export function isCodexAuthenticationFailure(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  return (
    /\b401\b/u.test(errorMessage) ||
    /\bunauthori[sz]ed\b/iu.test(errorMessage) ||
    /\b(?:invalid|expired|revoked)[ _-](?:access[ _-])?(?:auth(?:entication)?|token|api[ _-]?key)\b/iu.test(
      errorMessage,
    ) ||
    /\b(?:access |authentication )?token (?:is |has )?(?:invalid|expired|revoked)\b/iu.test(
      errorMessage,
    ) ||
    /\bauthentication (?:error|failed|required)\b/iu.test(errorMessage) ||
    /\bnot authenticated\b/iu.test(errorMessage) ||
    /\binvalid_grant\b/iu.test(errorMessage) ||
    /\btoken refresh failed \((?:400|401|403)\)(?=\s|:|$)/iu.test(errorMessage) ||
    /\bfailed to extract accountId from token\b/iu.test(errorMessage)
  );
}
