// Electron binding for Settings → Storage.
//
// Reads the live profile, Git facts, and the app's own deletion paths; the
// safety rules themselves live in storage-usage-core.ts.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app, ipcMain, logger } from "../platform.js";
import { chatStore } from "./chat-store.js";
import { chatApplicationService } from "./chat-application-service-main.js";
import { configStore } from "./config-store.js";
import { currentRuntimeProfile } from "../runtime-profile.js";
import {
  deleteAllDiagnosticData,
  pruneExpiredDiagnosticCrashDumps,
} from "./diagnostic-support.js";
import { gitManagedWorktreeDirtyState, gitManagedWorktreeUnpushedCommits } from "./git.js";
import { llmClient } from "./llm-client.js";
import { readRegularFile } from "./regular-file-read.js";
import { terminalService } from "./terminal.js";
import { workspaceMutationGate } from "./workspace-mutation-gate.js";
import { chatTriage } from "./chat-triage-main.js";
import { workspaceWorktreeApplicationService } from "./workspace-worktree-application-service-main.js";
import { createStorageUsageService } from "./storage-usage.js";

/**
 * Cleanup runs to completion even if the settings window has moved on. Its
 * deletions are Aiden's own transactional ones, so finishing is safe; a
 * half-removed worktree would be worse than a completed one.
 */
const headlessOwner = {
  isDestroyed: () => false,
  onInvalidated: () => () => undefined,
};

export const storageUsageService = createStorageUsageService({
  profileRoot: () => app.getPath("userData"),
  listWorkspaces: () => configStore.listWorkspaces(),
  listChats: () => chatStore.list(),
  isChatBusy: (chatId) => llmClient.isChatBusy(chatId),
  isWorkspaceChanging: (workspaceId) => workspaceMutationGate.isChanging(workspaceId),
  async pinnedChatIds() {
    const snapshot = await chatTriage.snapshot();
    const pinned = new Set<string>();
    for (const [chatId, entry] of Object.entries(snapshot.chats)) {
      if (entry.pinnedAt !== undefined) pinned.add(chatId);
    }
    return pinned;
  },
  removeWorktree: async (workspaceId) => {
    await workspaceWorktreeApplicationService.remove(headlessOwner, workspaceId);
  },
  removeChat: async (chatId) => {
    await chatApplicationService.remove(chatId, { rejectFeatureOwned: true });
  },
  async worktreeGitState({ repositoryPath, worktreePath, branch }) {
    const [dirty, unpushed] = await Promise.all([
      gitManagedWorktreeDirtyState(repositoryPath, worktreePath),
      gitManagedWorktreeUnpushedCommits(repositoryPath, branch),
    ]);
    return { uncommitted: dirty.uncommitted, unpushed };
  },
  readTranscript: async (filePath, maxBytes) => {
    try {
      return await readRegularFile(filePath, maxBytes);
    } catch {
      // Too large, unreadable, or replaced mid-scan: the transcript's own size
      // still counts; only its image attribution is skipped.
      return undefined;
    }
  },
  async clearLogs() {
    const profile = currentRuntimeProfile();
    await deleteAllDiagnosticData({
      logsPath: profile.logsPath,
      crashDumpsPath: profile.crashDumpsPath,
    });
    await pruneExpiredDiagnosticCrashDumps(profile.crashDumpsPath);
    // Scrollback is app output too. Clear it through the live store so pending
    // debounced writes cannot recreate what this just reported as freed; only
    // fall back to files when no store is installed (no terminal has opened).
    if (await terminalService.clearAllHistory()) return;
    const historyDir = path.join(app.getPath("userData"), "terminal-history");
    let names: string[];
    try {
      names = await fs.readdir(historyDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".log")) continue;
      await fs.rm(path.join(historyDir, name), { force: true });
    }
  },
  broadcast: (event) => ipcMain.broadcast("storage:changed", event),
  logError: (area, message, error) => logger.warn(area, message, error),
});
