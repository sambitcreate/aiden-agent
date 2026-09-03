import {
  sameChatHtmlArtifactDescriptor,
  type ChatHtmlArtifactV1,
} from "../../renderer/shared/chat-artifacts.js";
import {
  DesignProjectConflictError,
  DesignProjectRevisionConflictError,
  type DesignProjectStore,
} from "./design-project-store.js";
import type { GenerativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { isDesignArtifactRecoveryGenerationId } from "./design-generated-revision-contract.js";

export interface DesignRevisionRecoveryChat {
  id: string;
  messages: readonly {
    role: string;
    htmlArtifacts?: readonly ChatHtmlArtifactV1[];
  }[];
}

export interface DesignGeneratedRevisionServiceDependencies {
  projects: Pick<DesignProjectStore, "publishGeneratedRevisions">;
  artifacts: Pick<
    GenerativeUiArtifactStore,
    "commit" | "designPublicationRecords" | "discardPending" | "setDesignPublicationState"
  >;
  isGenerationActive?: (generationId: string) => boolean;
  isChatGenerationActive?: (chatId: string) => boolean;
  onWarning?: (message: string, error: unknown) => void;
}

export interface DesignGeneratedRevisionReconciliationResult {
  designPublication?: "retryable" | "suppressed";
}

function isSemanticPublicationConflict(error: unknown): boolean {
  return (
    error instanceof DesignProjectRevisionConflictError ||
    error instanceof DesignProjectConflictError
  );
}

function exactArtifactPersisted(
  chat: DesignRevisionRecoveryChat,
  artifact: ChatHtmlArtifactV1,
): boolean {
  return chat.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.htmlArtifacts?.some((persisted) =>
        sameChatHtmlArtifactDescriptor(persisted, artifact),
      ) === true,
  );
}

/**
 * Coordinates the recoverable cross-store publication of generated Design
 * revisions. Failed candidate HTML is discarded rather than advertised in the
 * transcript. Successful output and explicitly kept partial drafts advance an
 * artboard only after eligibility and the exact chat durability barrier.
 */
export class DesignGeneratedRevisionService {
  constructor(private readonly dependencies: DesignGeneratedRevisionServiceDependencies) {}

  async markSuccessfulCandidate(chatId: string, mediaIds: readonly string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    await this.dependencies.artifacts.setDesignPublicationState(
      chatId,
      mediaIds,
      ["candidate"],
      "eligible",
    );
  }

  async suppressCandidates(chatId: string, mediaIds: readonly string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    await this.dependencies.artifacts.setDesignPublicationState(
      chatId,
      mediaIds,
      ["candidate", "eligible", "suppressed"],
      "suppressed",
    );
  }

  async discardCandidates(
    chatId: string,
    generationId: string,
    mediaIds: readonly string[],
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    if (new Set(mediaIds).size !== mediaIds.length) {
      throw new Error("Generated Design candidate identity is ambiguous.");
    }
    for (const mediaId of mediaIds) {
      await this.dependencies.artifacts.discardPending({
        chatId,
        generationId,
        mediaId,
        expectedDesignPublication: ["candidate", "suppressed"],
      });
    }
  }

  private async discardUncommitted(
    records: Awaited<
      ReturnType<
        DesignGeneratedRevisionServiceDependencies["artifacts"]["designPublicationRecords"]
      >
    >,
    expectedDesignPublication: readonly ("candidate" | "eligible" | "suppressed")[],
  ): Promise<void> {
    for (const record of records) {
      await this.dependencies.artifacts.discardPending({
        chatId: record.chatId,
        generationId: record.generationId,
        mediaId: record.artifact.mediaId,
        expectedDesignPublication,
      });
    }
  }

  private async reconcileInterruptedCandidates(
    chatId: string,
    records: Awaited<
      ReturnType<
        DesignGeneratedRevisionServiceDependencies["artifacts"]["designPublicationRecords"]
      >
    >,
  ): Promise<void> {
    if (this.dependencies.isChatGenerationActive?.(chatId)) return;
    const interrupted = records.filter(
      (record) =>
        !isDesignArtifactRecoveryGenerationId(record.generationId) &&
        !this.dependencies.isGenerationActive?.(record.generationId),
    );
    await this.discardUncommitted(
      interrupted.filter((record) => !record.committed),
      ["candidate", "suppressed"],
    );
    const committed = interrupted.filter((record) => record.committed);
    if (committed.length > 0) {
      await this.suppressCandidates(
        chatId,
        committed.map((record) => record.artifact.mediaId),
      );
    }
  }

  async publishEligible(chatId: string, mediaIds: readonly string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    const records = await this.dependencies.artifacts.designPublicationRecords(
      ["eligible", "published"],
      { chatId, mediaIds },
    );
    if (records.length !== new Set(mediaIds).size) {
      throw new Error("Generated Design revision publication is incomplete.");
    }
    const projectIds = new Set(records.map((record) => record.designOwnership!.projectId));
    if (projectIds.size !== 1) {
      throw new Error("Generated Design revisions span multiple projects.");
    }
    const eligible = records.filter((record) => record.designPublication === "eligible");
    if (eligible.length === 0) return;
    try {
      await this.dependencies.projects.publishGeneratedRevisions({
        projectId: [...projectIds][0]!,
        chatId,
        revisions: records.map((record) => ({
          mediaId: record.artifact.mediaId,
          ownership: record.designOwnership!,
          candidateTitle: record.artifact.title,
        })),
      });
      await this.dependencies.artifacts.setDesignPublicationState(
        chatId,
        eligible.map((record) => record.artifact.mediaId),
        ["eligible"],
        "published",
      );
    } catch (error) {
      // A semantic CAS failure is final for this candidate: leaving it eligible
      // would retry forever and could later roll a lineage backward. Storage
      // errors remain eligible so startup can safely retry an unknown outcome.
      if (isSemanticPublicationConflict(error)) {
        await this.suppressCandidates(
          chatId,
          eligible.map((record) => record.artifact.mediaId),
        );
      }
      throw error;
    }
  }

  private async reconcileRecords(
    eligible: Awaited<
      ReturnType<
        DesignGeneratedRevisionServiceDependencies["artifacts"]["designPublicationRecords"]
      >
    >,
    chatById: ReadonlyMap<string, DesignRevisionRecoveryChat>,
  ): Promise<{ semanticConflictSuppressed: boolean }> {
    let semanticConflictSuppressed = false;
    const generations = new Map<string, typeof eligible>();
    for (const record of eligible) {
      const key = `${record.chatId}\0${record.generationId}`;
      const group = generations.get(key) ?? [];
      group.push(record);
      generations.set(key, group);
    }
    for (const generation of generations.values()) {
      const first = generation[0]!;
      if (
        this.dependencies.isChatGenerationActive?.(first.chatId) ||
        this.dependencies.isGenerationActive?.(first.generationId)
      ) {
        continue;
      }
      try {
        const chat = chatById.get(first.chatId);
        const mediaIds = generation.map((record) => record.artifact.mediaId);
        if (!chat || generation.some((record) => !exactArtifactPersisted(chat, record.artifact))) {
          await this.discardUncommitted(
            generation.filter((record) => !record.committed),
            ["eligible"],
          );
          const committed = generation.filter((record) => record.committed);
          if (committed.length > 0) {
            await this.suppressCandidates(
              first.chatId,
              committed.map((record) => record.artifact.mediaId),
            );
          }
          continue;
        }
        await this.dependencies.artifacts.commit(first.chatId, mediaIds);
        await this.publishEligible(first.chatId, mediaIds);
      } catch (error) {
        if (isSemanticPublicationConflict(error)) semanticConflictSuppressed = true;
        this.dependencies.onWarning?.(
          `Could not recover generated Design revisions for ${first.chatId}.`,
          error,
        );
      }
    }
    return { semanticConflictSuppressed };
  }

  async reconcilePersistedChat(
    chat: DesignRevisionRecoveryChat,
  ): Promise<DesignGeneratedRevisionReconciliationResult> {
    if (this.dependencies.isChatGenerationActive?.(chat.id)) return {};
    const candidates = await this.dependencies.artifacts.designPublicationRecords(
      ["candidate", "suppressed"],
      { chatId: chat.id },
    );
    await this.reconcileInterruptedCandidates(chat.id, candidates);
    const eligible = await this.dependencies.artifacts.designPublicationRecords(["eligible"], {
      chatId: chat.id,
    });
    const reconciliation = await this.reconcileRecords(eligible, new Map([[chat.id, chat]]));
    const unresolved = await this.dependencies.artifacts.designPublicationRecords(["eligible"], {
      chatId: chat.id,
    });
    if (this.dependencies.isChatGenerationActive?.(chat.id)) return {};
    if (unresolved.some((record) => !this.dependencies.isGenerationActive?.(record.generationId))) {
      return { designPublication: "retryable" };
    }
    return reconciliation.semanticConflictSuppressed ? { designPublication: "suppressed" } : {};
  }

  async reconcileAtStartup(chats: readonly DesignRevisionRecoveryChat[]): Promise<void> {
    const candidates = await this.dependencies.artifacts.designPublicationRecords([
      "candidate",
      "suppressed",
    ]);
    const candidatesByChat = new Map<string, typeof candidates>();
    for (const record of candidates) {
      const group = candidatesByChat.get(record.chatId) ?? [];
      group.push(record);
      candidatesByChat.set(record.chatId, group);
    }
    for (const [chatId, records] of candidatesByChat) {
      try {
        await this.reconcileInterruptedCandidates(chatId, records);
      } catch (error) {
        this.dependencies.onWarning?.(
          `Could not clean interrupted Design revisions for ${chatId}.`,
          error,
        );
      }
    }
    const eligible = await this.dependencies.artifacts.designPublicationRecords(["eligible"]);
    await this.reconcileRecords(eligible, new Map(chats.map((chat) => [chat.id, chat])));
  }
}
