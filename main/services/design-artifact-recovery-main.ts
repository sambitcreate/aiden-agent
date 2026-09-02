import { chatStore } from "./chat-store.js";
import { DesignArtifactRecoveryService } from "./design-artifact-recovery.js";
import { createDesignDirectEditMessagePort } from "./design-direct-edit-message-port.js";
import { designGeneratedRevisionService } from "./design-generated-revision-service-main.js";
import { designProjectStore } from "./design-project-store-main.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { piCompactionSessionStore } from "./pi-compaction-session-store.js";

export const designArtifactRecoveryService = new DesignArtifactRecoveryService({
  projects: designProjectStore,
  artifacts: generativeUiArtifactStore,
  messages: createDesignDirectEditMessagePort(chatStore),
  revisions: designGeneratedRevisionService,
  openJournal: (chatId) => piCompactionSessionStore.openChat(chatId),
});
