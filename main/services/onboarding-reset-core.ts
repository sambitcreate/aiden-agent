export interface OnboardingResetOperations {
  disconnectArtificialAnalysis(): Promise<unknown>;
  clearModelInsights(): Promise<unknown>;
  resetConfiguration(): Promise<void>;
  clearLegacySecrets(): Promise<void>;
  clearPiCredentials(): Promise<void>;
  clearMcpOAuth(): Promise<void>;
}

export class OnboardingResetError extends Error {
  readonly failures: readonly unknown[];

  constructor(failures: readonly unknown[]) {
    super("Aiden couldn’t clear every setup item. Retry Reset onboarding.");
    this.name = "OnboardingResetError";
    this.failures = failures;
  }
}

/** Delete every credential even when one provider's durable write fails. */
export async function deleteEveryCredential(
  providerIds: readonly string[],
  deleteCredential: (providerId: string) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    providerIds.map((providerId) => deleteCredential(providerId)),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) throw new Error("Provider credentials were not fully cleared.");
}

async function captureFailure(
  failures: unknown[],
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

/**
 * Clear every setup-owned store while still attempting the remaining stores
 * after one cleanup fails. The operation is deliberately idempotent so a
 * partial failure can be retried without restoring anything already removed.
 */
export async function performOnboardingReset(operations: OnboardingResetOperations): Promise<void> {
  const failures: unknown[] = [];

  // Disconnect model-data sources before the catch-all Pi credential pass;
  // each source owns both its dedicated key and its device-local cache.
  await Promise.all([
    captureFailure(failures, operations.disconnectArtificialAnalysis),
    captureFailure(failures, operations.clearModelInsights),
  ]);

  await Promise.all([
    captureFailure(failures, operations.resetConfiguration),
    captureFailure(failures, operations.clearLegacySecrets),
    captureFailure(failures, operations.clearPiCredentials),
    captureFailure(failures, operations.clearMcpOAuth),
  ]);

  if (failures.length > 0) {
    throw new OnboardingResetError(failures);
  }
}
