import * as fs from "node:fs/promises";
import { logger } from "../platform.js";
import { configStore } from "./config-store.js";
import { llmClient } from "./llm-client.js";
import { scheduleService } from "./schedule-service.js";
import { createScratchWorkspaceDirectory } from "./scratch-workspace.js";
import { terminalService } from "./terminal.js";
import { workspaceMutationGate } from "./workspace-mutation-gate.js";
import { workspaceOperationRegistry } from "./workspace-operation-registry.js";
import {
  createWorkspaceApplicationService,
  defaultWorkspaceId,
} from "./workspace-application-service.js";

export const workspaceApplicationService = createWorkspaceApplicationService({
  configStore,
  llmClient: {
    cancelWorkspaceAndSettle(workspaceId) {
      return llmClient.cancelWorkspaceAndSettle(workspaceId);
    },
  },
  scheduleService,
  terminalService,
  workspaceMutationGate,
  workspaceOperationRegistry,
  createScratchWorkspaceDirectory,
  realpath: (value) => fs.realpath(value),
  stat: (value) => fs.stat(value),
  removeEmptyDirectory: (value) => fs.rmdir(value),
  createId: defaultWorkspaceId,
  now: Date.now,
  logError: (area, message, error) => logger.error(area, message, error),
});
