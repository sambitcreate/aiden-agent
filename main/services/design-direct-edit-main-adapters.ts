import { chatStore } from "./chat-store.js";
import type { DesignProjectSnapshotV1 } from "./design-project-contract.js";
import { createDesignDirectEditMessagePort } from "./design-direct-edit-message-port.js";
import { DesignDirectEditService } from "./design-direct-edit-service.js";
import { designProjectStore } from "./design-project-store-main.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { sourceDesignerActionService } from "./source-designer-actions.js";

/**
 * Build the main-owned coordinator. The caller supplies the current trusted
 * design-system projection because renderer-reported token names are never
 * mutation authority.
 */
export function createMainDesignDirectEditService(options: {
  semanticColorTokens(project: DesignProjectSnapshotV1): Promise<readonly string[]>;
  proveConnectedComponentSingleUse: ConstructorParameters<
    typeof DesignDirectEditService
  >[0]["proveConnectedComponentSingleUse"];
}): DesignDirectEditService {
  return new DesignDirectEditService({
    projects: designProjectStore,
    artifacts: generativeUiArtifactStore,
    messages: createDesignDirectEditMessagePort(chatStore),
    actions: sourceDesignerActionService,
    semanticColorTokens: options.semanticColorTokens,
    proveConnectedComponentSingleUse: options.proveConnectedComponentSingleUse,
  });
}
