import { logger } from "../platform.js";
import { DesignGeneratedRevisionService } from "./design-generated-revision-service.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { designProjectStore } from "./design-project-store-main.js";
import { designLivePreviewAuthority } from "./design-live-preview-authority-main.js";

export const designGeneratedRevisionService = new DesignGeneratedRevisionService({
  projects: designProjectStore,
  artifacts: generativeUiArtifactStore,
  isGenerationActive: (generationId) => designLivePreviewAuthority.hasStream(generationId),
  isChatGenerationActive: (chatId) => designLivePreviewAuthority.hasChat(chatId),
  onWarning: (message, error) => logger.warn("design-project", message, error),
});
