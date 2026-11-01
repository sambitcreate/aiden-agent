import { publishAppControlsChanged } from "./app-controls-events-main.js";
import * as fs from "node:fs/promises";
import { logger, shell } from "../platform.js";
import { chatStore } from "./chat-store.js";
import { configStore } from "./config-store.js";
import { ensureUserDataDir } from "./data-store.js";
import { llmClient } from "./llm-client.js";
import { scheduleService } from "./schedule-service.js";
import { createScratchWorkspaceDirectory } from "./scratch-workspace.js";
import { terminalService } from "./terminal.js";
import { browserService } from "./browser/service.js";
import { workspaceGitWatcher } from "./workspace-git-watcher-main.js";
import { workspaceArtifactStore } from "./workspace-artifacts/main.js";
import { closeWorkspaceFollowThrough } from "./follow-through/follow-through-main.js";
import { workspaceMutationGate } from "./workspace-mutation-gate.js";
import { workspaceOperationRegistry } from "./workspace-operation-registry.js";
import {
  createWorkspaceApplicationService,
  defaultWorkspaceId,
} from "./workspace-application-service.js";

export const workspaceApplicationService = createWorkspaceApplicationService({
  configStore,
  onChanged: publishAppControlsChanged,
  llmClient,
  scheduleService,
  terminalService,
  browserService,
  gitWatcher: workspaceGitWatcher,
  workspaceArtifacts: workspaceArtifactStore,
  followThrough: { closeForWorkspace: closeWorkspaceFollowThrough },
  workspaceMutationGate,
  workspaceOperationRegistry,
  createScratchWorkspaceDirectory,
  realpath: (value) => fs.realpath(value),
  stat: (value) => fs.stat(value, { bigint: true }),
  removeEmptyDirectory: (value) => fs.rmdir(value),
  noWorkspace: {
    createDirectory: async () =>
      createScratchWorkspaceDirectory(await ensureUserDataDir("chat-folders")),
    workspaceIdsWithChats: async () =>
      new Set((await chatStore.list()).map((chat) => chat.workspaceId).filter((id): id is string => Boolean(id))),
    trash: (folderPath) => shell.trashItem(folderPath),
  },
  createId: defaultWorkspaceId,
  now: Date.now,
  logError: (area, message, error) => logger.error(area, message, error),
});
