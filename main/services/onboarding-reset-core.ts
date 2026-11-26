export interface OnboardingResetOperations {
  /** Image-generation keys and the device-local Image Generation settings. */
  clearImageGeneration(): Promise<unknown>;
  /**
   * The retired benchmark, Artificial Analysis and measured-pace leftovers.
   * Quiet by design: it never rejects, and a miss is retried next launch.
   */
  clearRetiredModelScoring(): Promise<void>;
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

  // Stores that own a dedicated key and a device-local file go before the
  // catch-all Pi credential pass.
  await Promise.all([
    captureFailure(failures, operations.clearImageGeneration),
    captureFailure(failures, operations.clearRetiredModelScoring),
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
