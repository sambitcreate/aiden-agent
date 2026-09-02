import { app, logger } from "../platform.js";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { chatApplicationService } from "./chat-application-service-main.js";
import { chatStore } from "./chat-store.js";
import { designCommentStore } from "./design-comment-store-main.js";
import { designReferenceAssetStore } from "./design-reference-asset-store.js";
import { sourceDesignerActionService } from "./source-designer-actions.js";
import {
  sourceDesignerMultifileCoordinator,
  sourceDesignerMultifileJournal,
} from "./source-designer-multifile-main.js";
import { DesignProjectLifecycleJournalStore } from "./design-project-lifecycle-journal.js";
import {
  RecoverableDesignProjectDuplicatePort,
  createDesignProjectCascadePlanner,
  createDesignProjectCascadePort,
  createDesignProjectLifecycleCoordinator,
  createIdempotentDesignProjectChatDelete,
} from "./design-project-lifecycle.js";
import {
  DesignProjectStore,
  type DesignProjectDuplicatePort,
  type LegacyDesignArtifactFact,
  type LegacyDesignChatFacts,
} from "./design-project-store.js";

/**
 * Read only the durable facts needed for the lazy legacy-route migration.
 * The old renderer grouped revisions by mutable title; V1 deliberately keeps
 * each proven committed artifact in a separate lineage.
 */
async function loadLegacyDesignChatFacts(
  chatId: string,
): Promise<LegacyDesignChatFacts | undefined> {
  const result = await chatApplicationService.get(chatId);
  const chat = result.chat;
  if (
    !chat ||
    chat.botId ||
    persistedChatWorkspaceId(chat.workspaceId) === ASSISTANT_WORKSPACE_ID
  ) {
    return undefined;
  }

  const artifactAvailability = generativeUiArtifactStore.availability();
  const ordered: LegacyDesignArtifactFact[] = [];
  const seen = new Set<string>();
  for (const message of chat.messages) {
    for (const artifact of message.htmlArtifacts ?? []) {
      if (!artifact.mediaId.startsWith("design:") || seen.has(artifact.mediaId)) continue;
      seen.add(artifact.mediaId);
      ordered.push({ mediaId: artifact.mediaId });
    }
  }

  let artifactState: LegacyDesignChatFacts["artifactState"] = artifactAvailability.available
    ? "available"
    : "corrupt";
  if (artifactState === "available") {
    for (const artifact of ordered) {
      if ((await generativeUiArtifactStore.htmlFor(chatId, artifact.mediaId)) === undefined) {
        artifactState = "corrupt";
        break;
      }
    }
  }

  return {
    chatId: chat.id,
    title: chat.title,
    connectionState: "prototype-only",
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    isDesignChat: true,
    artifactState,
    committedArtifacts: ordered,
  };
}

const lifecycleJournal = new DesignProjectLifecycleJournalStore(() => app.getPath("userData"));

// The project store publishes the duplicate row, while the recoverable port
// needs to inspect that same store after a restart. A tiny main-owned delegate
// closes the construction cycle without exposing a partially configured store.
let recoverableDuplicatePort: RecoverableDesignProjectDuplicatePort | undefined;
const duplicatePort: DesignProjectDuplicatePort = {
  prepareDuplicate(input) {
    if (!recoverableDuplicatePort) {
      throw new Error("Design Project duplication is not initialized.");
    }
    return recoverableDuplicatePort.prepareDuplicate(input);
  },
};

export const designProjectStore = new DesignProjectStore({
  legacySource: { loadDesignChatFacts: loadLegacyDesignChatFacts },
  duplicatePort,
  cascadePlanner: createDesignProjectCascadePlanner(
    designCommentStore,
    sourceDesignerActionService,
    sourceDesignerMultifileJournal,
  ),
});

recoverableDuplicatePort = new RecoverableDesignProjectDuplicatePort(
  designProjectStore,
  chatStore,
  generativeUiArtifactStore,
  lifecycleJournal,
  Date.now,
  (message, error) => logger.error("design-project-lifecycle", message, error),
);

export const designProjectLifecycle = createDesignProjectLifecycleCoordinator({
  projectStore: designProjectStore,
  duplicatePort: recoverableDuplicatePort,
  journal: lifecycleJournal,
  cascade: createDesignProjectCascadePort({
    projectStore: designProjectStore,
    deleteChat: createIdempotentDesignProjectChatDelete({
      chats: chatStore,
      application: chatApplicationService,
    }),
    comments: designCommentStore,
    actions: sourceDesignerActionService,
    durableActions: sourceDesignerMultifileJournal,
    durableCoordinator: sourceDesignerMultifileCoordinator,
    referenceAssets: designReferenceAssetStore,
  }),
  onWarning: (message, error) => logger.error("design-project-lifecycle", message, error),
});
