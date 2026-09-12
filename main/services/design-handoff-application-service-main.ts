import { buildDesignHandoffContext } from "./design-handoff-packet-authority.js";
import { currentDesignLanguageModelContext } from "./design-language-service.js";
import { logger } from "../platform.js";
import { chatApplicationService } from "./chat-application-service-main.js";
import { configStore } from "./config-store.js";
import { createDesignHandoffApplicationService } from "./design-handoff-application-service.js";
import { DesignHandoffEffectStore } from "./design-handoff-effect-store.js";
import { DesignHandoffJournalStore } from "./design-handoff-journal-store.js";
import { designProjectStore } from "./design-project-store-main.js";
import { designReferenceAssetStore } from "./design-reference-asset-store.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
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
      if (
        packet.referenceAssetIds.some((assetId) => !project.referenceAssetIds.includes(assetId))
      ) {
        throw new Error("The Design handoff references an asset outside this project.");
      }
      await buildDesignHandoffContext(packet, project, {
        referenceFor: async (id) => (await designReferenceAssetStore.read(id))?.bytes,
        sourceFor: (chatId, mediaId) => generativeUiArtifactStore.committedRecoverySourceFor(chatId, mediaId),
        validateLanguage: async (sourceProject) => {
          const workspace = sourceProject.workspaceId ? await configStore.getWorkspace(sourceProject.workspaceId) : undefined;
          return currentDesignLanguageModelContext(sourceProject, workspace?.folderPath);
        },
      });
    },
    logError: (area, message, error) => logger.error(area, message, error),
  },
});
