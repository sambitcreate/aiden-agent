export const CREATE_IMAGES_LOCAL_MOCK_RETRY_POLICY = Object.freeze({
  maxRetriesPerNode: 2,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  maxTotalDelayMs: 5_000,
  jitterRatio: 0,
  retryRemoteNotSubmitted: true,
  retryRemoteIdempotent: true,
} as const);

export interface CreateImagesRunAttemptBudget {
  initialGenerationRequests: number;
  maximumAutomaticRetryAttempts: number;
  maximumTotalAttempts: number;
}

export function createImagesLocalMockAttemptBudget(
  initialGenerationRequests: number,
): CreateImagesRunAttemptBudget {
  if (!Number.isSafeInteger(initialGenerationRequests) || initialGenerationRequests < 0) {
    throw new Error("Initial generation request count must be a non-negative safe integer.");
  }
  const maximumAutomaticRetryAttempts =
    initialGenerationRequests * CREATE_IMAGES_LOCAL_MOCK_RETRY_POLICY.maxRetriesPerNode;
  const maximumTotalAttempts = initialGenerationRequests + maximumAutomaticRetryAttempts;
  if (
    !Number.isSafeInteger(maximumAutomaticRetryAttempts) ||
    !Number.isSafeInteger(maximumTotalAttempts)
  ) {
    throw new Error("The local mock attempt budget exceeds the safe integer range.");
  }
  return Object.freeze({
    initialGenerationRequests,
    maximumAutomaticRetryAttempts,
    maximumTotalAttempts,
  });
}
