// Chat ↔ pull request IPC. The renderer only ever sends a chat id plus small
// allowlisted inputs (URL, ref, create fields); every value is parsed here and
// all GitHub traffic stays in the main process through `gh`.

import { ipcMain } from "../platform.js";
import {
  isSafeChatPullRequestChatId,
  normalizePullRequestRef,
  parseExpectedHeadSha,
  parsePullRequestRepository,
} from "../../renderer/shared/chat-pull-requests.js";
import { chatPullRequestService } from "../services/chat-pull-request-service-main.js";

function asChatId(value: unknown): string {
  if (!isSafeChatPullRequestChatId(value))
    throw new Error("The chat identifier is invalid.");
  return value;
}

function asBoundedString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const trimmed = value.replace(/\p{Cc}+/gu, " ").trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new Error(`${name} must be 1-${maxLength} characters.`);
  }
  return trimmed;
}

function asOptionalBoundedString(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return asBoundedString(value, name, maxLength);
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asPullRequestRef(value: unknown) {
  const ref = normalizePullRequestRef(value);
  if (!ref) throw new Error("The pull request reference is invalid.");
  return ref;
}

function asLinkInput(value: unknown): { url: string } {
  const input = asRecord(value, "input");
  return { url: asBoundedString(input.url, "url", 2_048) };
}

function asCreateInput(value: unknown) {
  const input = asRecord(value, "input");
  return {
    workspaceId: asBoundedString(input.workspaceId, "workspaceId", 128),
    title: asBoundedString(input.title, "title", 512),
    body: asOptionalBoundedString(input.body, "body", 64 * 1_024),
    baseBranch: asBoundedString(input.baseBranch, "baseBranch", 256),
    headBranch: asBoundedString(input.headBranch, "headBranch", 256),
    expectedHeadSha: parseExpectedHeadSha(input.expectedHeadSha),
    repository: parsePullRequestRepository(input.repository),
    draft: input.draft === true,
  };
}

function asDetectInput(value: unknown) {
  const input = asRecord(value, "input");
  return {
    workspaceId: asBoundedString(input.workspaceId, "workspaceId", 128),
    headBranch: asBoundedString(input.headBranch, "headBranch", 256),
    expectedHeadSha: parseExpectedHeadSha(input.expectedHeadSha),
    repository: parsePullRequestRepository(input.repository),
  };
}

export function registerPullRequestHandlers(): void {
  ipcMain.handle("pullRequests:list", async (_event, chatId: unknown) =>
    chatPullRequestService.list(asChatId(chatId)),
  );

  ipcMain.handle("pullRequests:current", async (_event, chatId: unknown) =>
    chatPullRequestService.current(asChatId(chatId)),
  );

  ipcMain.handle(
    "pullRequests:candidates",
    async (_event, chatId: unknown, workspaceId: unknown) =>
      chatPullRequestService.candidates(
        asChatId(chatId),
        asOptionalBoundedString(workspaceId, "workspaceId", 128),
      ),
  );

  ipcMain.handle(
    "pullRequests:link",
    async (_event, chatId: unknown, input: unknown) =>
      chatPullRequestService.link(asChatId(chatId), asLinkInput(input)),
  );

  ipcMain.handle(
    "pullRequests:linkRef",
    async (_event, chatId: unknown, input: unknown) => {
      const record = asRecord(input, "input");
      return chatPullRequestService.linkExisting(
        asChatId(chatId),
        asPullRequestRef(record),
        record.source === "branch-discovered" ? "branch-discovered" : "manual",
      );
    },
  );

  ipcMain.handle(
    "pullRequests:unlink",
    async (_event, chatId: unknown, ref: unknown) =>
      chatPullRequestService.unlink(asChatId(chatId), asPullRequestRef(ref)),
  );

  ipcMain.handle(
    "pullRequests:refresh",
    async (_event, chatId: unknown, ref: unknown) =>
      chatPullRequestService.refresh(
        asChatId(chatId),
        ref === undefined || ref === null ? undefined : asPullRequestRef(ref),
      ),
  );

  ipcMain.handle(
    "pullRequests:detectAfterPush",
    async (_event, chatId: unknown, input: unknown) =>
      chatPullRequestService.detectAfterPush(
        asChatId(chatId),
        asDetectInput(input),
      ),
  );

  ipcMain.handle(
    "pullRequests:create",
    async (_event, chatId: unknown, input: unknown) =>
      chatPullRequestService.create(asChatId(chatId), asCreateInput(input)),
  );

  ipcMain.handle(
    "pullRequests:dismissPending",
    async (_event, chatId: unknown, operationId: unknown) =>
      chatPullRequestService.dismissPending(
        asChatId(chatId),
        asBoundedString(operationId, "operationId", 64),
      ),
  );

  ipcMain.handle("pullRequests:pending", async (_event, chatId: unknown) =>
    chatPullRequestService.reconcilePending(asChatId(chatId)),
  );

  ipcMain.handle(
    "pullRequests:adopt",
    async (_event, chatId: unknown, operationId: unknown, ref: unknown) =>
      chatPullRequestService.adoptCandidate(
        asChatId(chatId),
        asBoundedString(operationId, "operationId", 64),
        asPullRequestRef(ref),
      ),
  );
}
