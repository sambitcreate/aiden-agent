export interface BotProviderAuthAdmissionInput<Admission> {
  signal?: AbortSignal;
  /** May refresh a stored OAuth credential and publish new provider authority. */
  preflightAuth(): Promise<void>;
  /** Must acquire the Bot inventory lease only after preflight publication settles. */
  admit(): Promise<Admission>;
}

/**
 * Refresh provider auth before Bot authority is leased. Pi persists rotated OAuth
 * credentials while resolving auth; doing that after admission would invalidate
 * the request's own inventory lease even though the refresh succeeded.
 */
export async function admitBotAfterProviderAuthPreflight<Admission>(
  input: BotProviderAuthAdmissionInput<Admission>,
): Promise<Admission> {
  if (input.signal?.aborted) throw input.signal.reason;
  await input.preflightAuth();
  if (input.signal?.aborted) throw input.signal.reason;
  return input.admit();
}
