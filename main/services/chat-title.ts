// Background first-turn chat title generation. This is intentionally separate
// from the interactive Agent: it makes one small, tool-free model request and
// never delays or fails the user's actual chat turn.

import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { ipcMain, logger } from "../platform.js";
import { chatStore } from "./chat-store.js";
import {
  buildChatTitlePrompt,
  canReplaceGeneratedChatTitle,
  deriveChatTitleSeed,
  sanitizeGeneratedChatTitle,
} from "./chat-title-policy.js";
import { resolveChatTitleRoute } from "./chat-title-routing.js";
import { configStore } from "./config-store.js";
import { foundationModelsConnection } from "./foundation-models-connection.js";
import { resolveModelRuntime } from "./model-runtime.js";
import { providerModelInfo } from "./provider-model-info.js";

const TITLE_TIMEOUT_MS = 15_000;
const inFlight = new Map<string, Promise<void>>();

export interface ChatTitleModelSelection {
  providerId: string;
  model: string;
}

function assistantText(content: AssistantMessage["content"]): string {
  return content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

async function generateWithChatModel(input: {
  firstMessage: Parameters<typeof buildChatTitlePrompt>[0] & {
    attachments?: import("./types.js").Attachment[];
  };
  selection: ChatTitleModelSelection;
  signal: AbortSignal;
}): Promise<string> {
  const runtime = await resolveModelRuntime(
    input.selection.providerId,
    input.selection.model,
    input.signal,
  );
  const modelInfo = await providerModelInfo.info(input.selection.providerId, input.selection.model);
  const promptContent: Array<TextContent | ImageContent> = [
    {
      type: "text",
      text: buildChatTitlePrompt(input.firstMessage),
    },
  ];
  const firstImage = input.firstMessage.attachments?.find(
    (attachment) => attachment.kind === "image" && attachment.data,
  );
  if (modelInfo.vision && firstImage?.data) {
    promptContent.push({
      type: "image",
      data: firstImage.data,
      mimeType: firstImage.mimeType,
    });
  }

  const result = await runtime.streams
    .streamSimple(
      runtime.model,
      {
        systemPrompt: "You write short, specific titles for coding conversations.",
        messages: [{ role: "user", content: promptContent, timestamp: Date.now() }],
      },
      {
        apiKey: runtime.apiKey,
        headers: runtime.headers,
        signal: input.signal,
        temperature: 0.2,
        maxTokens: 48,
        timeoutMs: TITLE_TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
      },
    )
    .result();
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error(result.errorMessage || `Title generation ${result.stopReason}.`);
  }
  return assistantText(result.content);
}

async function generateFirstTurnTitle(input: {
  chatId: string;
  fallbackSelection: ChatTitleModelSelection;
}): Promise<void> {
  const chat = await chatStore.get(input.chatId);
  if (!chat) return;

  const userMessages = chat.messages.filter((message) => message.role === "user");
  if (userMessages.length !== 1) return;
  const firstMessage = userMessages[0];
  if (!firstMessage) return;

  const titleSeed = deriveChatTitleSeed(firstMessage);
  if (!canReplaceGeneratedChatTitle(chat.title, titleSeed)) return;

  const settings = await configStore.getSettings();
  const titleProviderId = settings.chatTitleProviderId ?? "automatic";
  const foundationModelsStatus =
    titleProviderId === "chat-model" ? null : await foundationModelsConnection.status();
  const route = resolveChatTitleRoute(titleProviderId, foundationModelsStatus);
  if (route === "seed-only") return;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), TITLE_TIMEOUT_MS);
  try {
    const rawTitle =
      route === "apple-foundation-models"
        ? await foundationModelsConnection.generateTitle(
            buildChatTitlePrompt(firstMessage),
            abortController.signal,
          )
        : await generateWithChatModel({
            firstMessage,
            selection: input.fallbackSelection,
            signal: abortController.signal,
          });
    const generatedTitle = sanitizeGeneratedChatTitle(rawTitle);
    if (!generatedTitle) return;
    const updated = await chatStore.replaceAutoTitle(input.chatId, titleSeed, generatedTitle);
    if (!updated) return;

    ipcMain.broadcast("chats:metadata-updated", {
      chatId: updated.id,
      workspaceId: updated.workspaceId,
      title: updated.title,
      updatedAt: updated.updatedAt,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export const chatTitleService = {
  startForFirstTurn(input: { chatId: string; providerId: string; model: string }): void {
    if (!input.chatId || inFlight.has(input.chatId)) return;
    const task = generateFirstTurnTitle({
      chatId: input.chatId,
      fallbackSelection: { providerId: input.providerId, model: input.model },
    })
      .catch((error: unknown) => {
        logger.warn("chat-title", "Background title generation failed", {
          chatId: input.chatId,
          code:
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code: unknown }).code)
              : "generation_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight.delete(input.chatId);
      });
    inFlight.set(input.chatId, task);
  },
};
