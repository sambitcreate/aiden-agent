export interface DesignGenerationPublicationPort {
  markSuccessfulCandidate(chatId: string, mediaIds: readonly string[]): Promise<void>;
  discardCandidates(
    chatId: string,
    generationId: string,
    mediaIds: readonly string[],
  ): Promise<void>;
  suppressCandidates(chatId: string, mediaIds: readonly string[]): Promise<void>;
  publishEligible(chatId: string, mediaIds: readonly string[]): Promise<void>;
}

export interface DesignGenerationArtifactCommitPort {
  commit(chatId: string, mediaIds: readonly string[]): Promise<void>;
}

export function classifyDesignGenerationPublicationFailure(
  mediaIds: readonly string[],
  eligibleMediaIds: readonly string[],
): "retryable" | "suppressed" {
  const eligible = new Set(eligibleMediaIds);
  return new Set(mediaIds).size === mediaIds.length &&
    eligible.size === eligibleMediaIds.length &&
    mediaIds.length === eligibleMediaIds.length &&
    mediaIds.every((mediaId) => eligible.has(mediaId))
    ? "retryable"
    : "suppressed";
}

export type DesignGenerationPublicationDecision =
  | { publish: true; cleanupPending: false }
  | { publish: false; cleanupPending: false }
  | { publish: false; cleanupPending: true; cause: unknown };

export function shouldPromptToKeepCancelledDesignDraft(input: {
  design: boolean;
  interactiveOwner: boolean;
  artifactCount: number;
  status: string;
  cancellationOrigin?: string;
}): boolean {
  return (
    input.design &&
    input.interactiveOwner &&
    input.artifactCount > 0 &&
    input.status === "cancelled" &&
    input.cancellationOrigin === "user_stop"
  );
}

export function keepCancelledDesignDraft(response: {
  cancelled: boolean;
  answers: readonly { questionIndex: number; kind: string; answer?: string }[];
}): boolean {
  return (
    !response.cancelled &&
    response.answers.some(
      (answer) =>
        answer.questionIndex === 0 &&
        answer.kind === "option" &&
        answer.answer === "Keep draft",
    )
  );
}

/**
 * Cross eligibility only for successful output or a partial draft the user
 * explicitly chose to keep. Every other terminal path discards the exact
 * uncommitted generation, retrying once after an ambiguous delete response.
 */
export async function decideDesignGenerationPublication(input: {
  chatId: string;
  generationId: string;
  mediaIds: readonly string[];
  completed: boolean;
  revisions: DesignGenerationPublicationPort;
}): Promise<DesignGenerationPublicationDecision> {
  if (input.mediaIds.length === 0) return { publish: false, cleanupPending: false };
  if (input.completed) {
    await input.revisions.markSuccessfulCandidate(input.chatId, input.mediaIds);
    return { publish: true, cleanupPending: false };
  }
  try {
    await input.revisions.discardCandidates(input.chatId, input.generationId, input.mediaIds);
    return { publish: false, cleanupPending: false };
  } catch {
    try {
      await input.revisions.discardCandidates(input.chatId, input.generationId, input.mediaIds);
      return { publish: false, cleanupPending: false };
    } catch (cause) {
      return { publish: false, cleanupPending: true, cause };
    }
  }
}

/** Called only after an eligible exact assistant artifact descriptor is durable in chat. */
export async function commitDecidedDesignGeneration(input: {
  chatId: string;
  mediaIds: readonly string[];
  publish: boolean;
  artifacts: DesignGenerationArtifactCommitPort;
  revisions: DesignGenerationPublicationPort;
}): Promise<void> {
  if (!input.publish || input.mediaIds.length === 0) return;
  await input.artifacts.commit(input.chatId, input.mediaIds);
  await input.revisions.publishEligible(input.chatId, input.mediaIds);
}

/**
 * A durable transcript can outlive an ambiguous project publication response.
 * Retry the idempotent publication once in the foreground; if it still cannot
 * settle, preserve the eligible record for startup recovery and report the
 * pending state to the renderer.
 */
export async function settleDecidedDesignGeneration(input: {
  chatId: string;
  mediaIds: readonly string[];
  publish: boolean;
  artifacts: DesignGenerationArtifactCommitPort;
  revisions: DesignGenerationPublicationPort;
}): Promise<{ pending: false } | { pending: true; cause: unknown }> {
  if (!input.publish || input.mediaIds.length === 0) return { pending: false };
  try {
    await commitDecidedDesignGeneration(input);
    return { pending: false };
  } catch {
    try {
      await commitDecidedDesignGeneration(input);
      return { pending: false };
    } catch (retryCause) {
      return { pending: true, cause: retryCause };
    }
  }
}
