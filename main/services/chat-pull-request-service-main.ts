import { app, ipcMain } from "../platform.js";
import * as path from "node:path";
import { ChatPullRequestStore } from "./chat-pull-request-store.js";
import { ChatPullRequestService } from "./chat-pull-request-service.js";
import { githubPullRequests } from "./github-pull-request.js";
import { gitInfo } from "./git.js";
import { chatStore } from "./chat-store.js";
import { workspaceEnvironmentApplicationService } from "./workspace-environment-application-service-main.js";

export const chatPullRequestStore = new ChatPullRequestStore(() =>
  path.join(app.getPath("userData"), "chat-pull-requests"),
);

export const chatPullRequestService = new ChatPullRequestService({
  store: chatPullRequestStore,
  github: githubPullRequests,
  gitInfo,
  chatWorkspaceId: async (chatId) => {
    const chat = await chatStore.get(chatId);
    return chat?.workspaceId;
  },
  workspaceFolderPath: async (workspaceId) =>
    (await workspaceEnvironmentApplicationService.resolve(workspaceId, false))?.folderPath,
  onChanged: (chatId) => ipcMain.broadcast("chats:pull-requests-changed", { chatId }),
});
