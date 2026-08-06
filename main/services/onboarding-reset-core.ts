export interface OnboardingResetOperations {
  disconnectArtificialAnalysis(): Promise<unknown>;
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

  // Artificial Analysis owns both a Pi credential and a separate cache. Let
  // its runtime remove both before the catch-all Pi credential pass.
  await captureFailure(failures, operations.disconnectArtificialAnalysis);

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
