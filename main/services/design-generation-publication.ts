export interface DesignGenerationPublicationPort {
  markSuccessfulCandidate(chatId: string, mediaIds: readonly string[]): Promise<void>;
  suppressCandidates(chatId: string, mediaIds: readonly string[]): Promise<void>;
  publishEligible(chatId: string, mediaIds: readonly string[]): Promise<void>;
}

export interface DesignGenerationArtifactCommitPort {
  commit(chatId: string, mediaIds: readonly string[]): Promise<void>;
}

export async function decideDesignGenerationPublication(input: {
  chatId: string;
  mediaIds: readonly string[];
  completed: boolean;
  revisions: DesignGenerationPublicationPort;
}): Promise<boolean> {
  if (input.mediaIds.length === 0) return false;
  if (input.completed) {
    await input.revisions.markSuccessfulCandidate(input.chatId, input.mediaIds);
    return true;
  }
  await input.revisions.suppressCandidates(input.chatId, input.mediaIds);
  return false;
}

/** Called only after the exact assistant artifact descriptor is durable in chat. */
export async function commitDecidedDesignGeneration(input: {
  chatId: string;
  mediaIds: readonly string[];
  publish: boolean;
  artifacts: DesignGenerationArtifactCommitPort;
  revisions: DesignGenerationPublicationPort;
}): Promise<void> {
  if (input.mediaIds.length === 0) return;
  await input.artifacts.commit(input.chatId, input.mediaIds);
  if (input.publish) {
    await input.revisions.publishEligible(input.chatId, input.mediaIds);
  }
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
  try {
    await commitDecidedDesignGeneration(input);
    return { pending: false };
  } catch (cause) {
    if (!input.publish) return { pending: true, cause };
    try {
      await commitDecidedDesignGeneration(input);
      return { pending: false };
    } catch (retryCause) {
      return { pending: true, cause: retryCause };
    }
  }
}
