import { createHash } from "node:crypto";
import { logger } from "../platform.js";
import { chatApplicationService } from "./chat-application-service-main.js";
import { configStore } from "./config-store.js";
import { createDesignHandoffApplicationService } from "./design-handoff-application-service.js";
import { DesignHandoffEffectStore } from "./design-handoff-effect-store.js";
import { DesignHandoffJournalStore } from "./design-handoff-journal-store.js";
import { designProjectStore } from "./design-project-store-main.js";
import { designReferenceAssetStore } from "./design-reference-asset-store.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { isUsablePublishedDesignSource } from "./design-generation-context.js";
import { gitPushCapability, gitReview } from "./git.js";
import { workspaceApplicationService } from "./workspace-application-service-main.js";
import { workspaceEnvironmentApplicationService } from "./workspace-environment-application-service-main.js";
import { workspaceWorktreeApplicationService } from "./workspace-worktree-application-service-main.js";

const journal = new DesignHandoffJournalStore();
const effects = new DesignHandoffEffectStore();

export const designHandoffApplicationService = createDesignHandoffApplicationService({
  journal,
  effects,
  dependencies: {
    listWorkspaces: () => configStore.listWorkspaces(),
    getWorkspace: (workspaceId) => configStore.getWorkspace(workspaceId),
    resolveWorkspace: async (workspaceId) => {
      const resolved = await workspaceEnvironmentApplicationService.resolve(workspaceId, true);
      if (!resolved) throw new Error("The selected workspace is no longer available.");
      return resolved;
    },
    inspectGit: async (folderPath) => {
      const [review, push] = await Promise.all([
        gitReview(folderPath),
        gitPushCapability(folderPath),
      ]);
      return {
        isRepo: review.isRepo,
        branch: review.branch,
        committedHead: push.expectedHead,
        dirty: review.summary.fileCount > 0,
      };
    },
    createManagedWorkspace: (owner, sourceWorkspaceId, branch, name) =>
      workspaceWorktreeApplicationService.create(owner, sourceWorkspaceId, branch, name),
    setWorkspacePermission: (workspaceId, permission, assertCurrent) =>
      workspaceApplicationService.update(workspaceId, { permission }, { assertCurrent }),
    removeManagedWorkspace: async (owner, workspaceId, validateWorkspace) => {
      await workspaceWorktreeApplicationService.remove(owner, workspaceId, validateWorkspace);
    },
    listChats: (workspaceId) => chatApplicationService.listRegular(workspaceId),
    getChat: async (chatId) => (await chatApplicationService.get(chatId)).chat,
    createChat: async (input, owner) => {
      const chat = await chatApplicationService.create(input, owner);
      if (!chat) throw new Error("Aiden could not create the handoff workspace chat.");
      return chat;
    },
    removeChat: (chatId, assertCurrent) => chatApplicationService.remove(chatId, { assertCurrent }),
    verifyPacket: async (packet) => {
      const project = await designProjectStore.get(packet.projectId);
      if (!project || project.revision !== packet.projectRevision) {
        throw new Error("The Design Project changed before handoff publication.");
      }
      const artboard = project.canvas.nodes.find(
        (node) =>
          node.kind === "artboard" &&
          node.canonicalOrigin === "generated-artifact" &&
          node.lineageId === packet.source.lineageId &&
          node.artifactMediaIds?.includes(packet.source.revisionId),
      );
      if (!artboard)
        throw new Error("The selected Design revision is no longer part of this project.");
      if (
        packet.referenceAssetIds.some((assetId) => !project.referenceAssetIds.includes(assetId))
      ) {
        throw new Error("The Design handoff references an asset outside this project.");
      }
      const availableAssets = new Set((await designReferenceAssetStore.list()).map(({ id }) => id));
      if (packet.referenceAssetIds.some((assetId) => !availableAssets.has(assetId))) {
        throw new Error("A Design handoff reference asset is unavailable.");
      }
      const source = await generativeUiArtifactStore.committedRecoverySourceFor(
        project.chatId,
        packet.source.revisionId,
      );
      if (!source) throw new Error("The selected Design source revision is unavailable.");
      if (!isUsablePublishedDesignSource(project, source)) {
        throw new Error("The selected Design source revision is damaged and must be repaired.");
      }
      const bytes = Buffer.from(source.html, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== packet.source.byteSize || hash !== packet.source.sha256) {
        throw new Error(
          "The selected Design source revision no longer matches the confirmed handoff.",
        );
      }
    },
    logError: (area, message, error) => logger.error(area, message, error),
  },
});
