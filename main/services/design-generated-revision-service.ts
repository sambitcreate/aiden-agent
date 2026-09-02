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
    "commit" | "designPublicationRecords" | "setDesignPublicationState"
  >;
  onWarning?: (message: string, error: unknown) => void;
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
 * revisions. Candidate HTML may remain visible in a failed transcript, but it
 * never advances an artboard unless a successful terminal path first marks it
 * eligible and its exact assistant message crosses the chat durability barrier.
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
      if (
        error instanceof DesignProjectRevisionConflictError ||
        error instanceof DesignProjectConflictError
      ) {
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
  ): Promise<void> {
    const generations = new Map<string, typeof eligible>();
    for (const record of eligible) {
      const key = `${record.chatId}\0${record.generationId}`;
      const group = generations.get(key) ?? [];
      group.push(record);
      generations.set(key, group);
    }
    for (const generation of generations.values()) {
      const first = generation[0]!;
      const chat = chatById.get(first.chatId);
      const mediaIds = generation.map((record) => record.artifact.mediaId);
      if (!chat || generation.some((record) => !exactArtifactPersisted(chat, record.artifact))) {
        await this.suppressCandidates(first.chatId, mediaIds);
        continue;
      }
      try {
        await this.dependencies.artifacts.commit(first.chatId, mediaIds);
        await this.publishEligible(first.chatId, mediaIds);
      } catch (error) {
        this.dependencies.onWarning?.(
          `Could not recover generated Design revisions for ${first.chatId}.`,
          error,
        );
      }
    }
  }

  async reconcilePersistedChat(chat: DesignRevisionRecoveryChat): Promise<void> {
    const candidates = await this.dependencies.artifacts.designPublicationRecords(["candidate"], {
      chatId: chat.id,
    });
    const interruptedCandidates = candidates.filter(
      (record) => !isDesignArtifactRecoveryGenerationId(record.generationId),
    );
    if (interruptedCandidates.length > 0) {
      await this.suppressCandidates(
        chat.id,
        interruptedCandidates.map((record) => record.artifact.mediaId),
      );
    }
    const eligible = await this.dependencies.artifacts.designPublicationRecords(["eligible"], {
      chatId: chat.id,
    });
    await this.reconcileRecords(eligible, new Map([[chat.id, chat]]));
  }

  async reconcileAtStartup(chats: readonly DesignRevisionRecoveryChat[]): Promise<void> {
    const candidates = await this.dependencies.artifacts.designPublicationRecords(["candidate"]);
    const candidateIdsByChat = new Map<string, string[]>();
    for (const record of candidates) {
      if (isDesignArtifactRecoveryGenerationId(record.generationId)) continue;
      const mediaIds = candidateIdsByChat.get(record.chatId) ?? [];
      mediaIds.push(record.artifact.mediaId);
      candidateIdsByChat.set(record.chatId, mediaIds);
    }
    for (const [chatId, mediaIds] of candidateIdsByChat) {
      await this.suppressCandidates(chatId, mediaIds);
    }
    const eligible = await this.dependencies.artifacts.designPublicationRecords(["eligible"]);
    await this.reconcileRecords(eligible, new Map(chats.map((chat) => [chat.id, chat])));
  }
}
