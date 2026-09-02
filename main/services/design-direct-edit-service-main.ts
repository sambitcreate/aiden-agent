import * as fs from "node:fs/promises";
import { configStore } from "./config-store.js";
import { currentDesignSystemModelContext } from "./design-system-attachment-service-main.js";
import { createMainDesignDirectEditService } from "./design-direct-edit-main-adapters.js";
import { sourceDesignerActionService } from "./source-designer-actions.js";

const CSS_CUSTOM_PROPERTY = /^--[a-z][a-z0-9-]{0,62}$/u;

export const designDirectEditService = createMainDesignDirectEditService({
  async semanticColorTokens(project) {
    if (!project.designSystemBinding || !project.workspaceId) return [];
    const workspace = await configStore.getWorkspace(project.workspaceId);
    if (!workspace?.folderPath) return [];
    const root = await fs.realpath(workspace.folderPath);
    const context = await currentDesignSystemModelContext(project, root);
    if (!context) return [];
    return context.tokens.colors
      .map(({ name }) => name)
      .filter((name): name is string => CSS_CUSTOM_PROPERTY.test(name));
  },
  proveConnectedComponentSingleUse: ({ binding }) =>
    sourceDesignerActionService.proveConnectedComponentSingleUse(binding),
});
