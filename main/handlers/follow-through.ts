import { ipcMain } from "../platform.js";
import { isBackgroundJobId } from "../../renderer/shared/background-jobs.js";
import { normalizeGitHubHost, normalizeGitHubRepositoryIdentity } from "../../renderer/shared/chat-pull-requests.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { chatPullRequestService } from "../services/chat-pull-request-service-main.js";
import {
  chatFollowThrough,
  clearDoneWhenCheck,
  pullRequestFollows,
  readJobOutput,
  resolvePullRequestTarget,
  setDoneWhenCheck,
  stopJobForPerson,
} from "../services/follow-through/follow-through-main.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request.");
  return value as Record<string, unknown>;
}

function chatId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200) throw new Error("Invalid chat.");
  return value;
}

function jobId(value: unknown): string {
  if (!isBackgroundJobId(value)) throw new Error("Invalid background job.");
  return value;
}

function activeDocument(event: Parameters<typeof rendererDocumentOwner>[0]): void {
  rendererDocumentOwner(event, () => new Error("Follow-through changes require the active application document."));
}

export function registerFollowThroughHandlers(): void {
  ipcMain.handle("chats:followThrough", (_event, id: unknown) => chatFollowThrough(chatId(id)));

  ipcMain.handle("chats:followThroughJobOutput", (_event, input: unknown) => {
    const value = record(input);
    return readJobOutput(chatId(value.chatId), jobId(value.jobId));
  });

  ipcMain.handle("chats:followThroughStopJob", async (event, input: unknown) => {
    activeDocument(event);
    const value = record(input);
    await stopJobForPerson(chatId(value.chatId), jobId(value.jobId));
  });

  ipcMain.handle("chats:followThroughFollowPullRequest", async (event, input: unknown) => {
    activeDocument(event);
    const id = chatId(record(input).chatId);
    const target = await resolvePullRequestTarget(id, undefined, (chat) => chatPullRequestService.current(chat));
    pullRequestFollows.follow({ chatId: id, ...target, startedBy: "person" });
  });

  ipcMain.handle("chats:followThroughStopFollow", (event, input: unknown) => {
    activeDocument(event);
    const value = record(input);
    const host = normalizeGitHubHost(value.host);
    const repository = normalizeGitHubRepositoryIdentity(value.repository);
    const number = typeof value.number === "number" && Number.isSafeInteger(value.number) && value.number > 0 ? value.number : undefined;
    if (!host || !repository || !number) throw new Error("Invalid pull request.");
    pullRequestFollows.stop(chatId(value.chatId), { host, repository, number }, "person");
  });

  ipcMain.handle("chats:followThroughSetCheck", async (event, input: unknown) => {
    activeDocument(event);
    const value = record(input);
    if (typeof value.command !== "string") throw new Error("Name the check to run.");
    await setDoneWhenCheck(chatId(value.chatId), value.command);
  });

  ipcMain.handle("chats:followThroughClearCheck", (event, input: unknown) => {
    activeDocument(event);
    clearDoneWhenCheck(chatId(record(input).chatId));
  });
}
