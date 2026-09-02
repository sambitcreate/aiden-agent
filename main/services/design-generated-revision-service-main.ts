import { logger } from "../platform.js";
import { DesignGeneratedRevisionService } from "./design-generated-revision-service.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { designProjectStore } from "./design-project-store-main.js";

export const designGeneratedRevisionService = new DesignGeneratedRevisionService({
  projects: designProjectStore,
  artifacts: generativeUiArtifactStore,
  onWarning: (message, error) => logger.warn("design-project", message, error),
});
