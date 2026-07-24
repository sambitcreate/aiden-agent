// Background first-turn chat title generation. This is intentionally separate
// from the interactive Agent: it makes one small, tool-free model request and
// never delays or fails the user's actual chat turn.

import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { ipcMain, logger } from "../platform.js";
import { chatStore } from "./chat-store.js";
import {
  buildChatRenamePrompt,
  buildChatTitlePrompt,
  canReplaceGeneratedChatTitle,
  deriveChatTitleSeed,
  sanitizeGeneratedChatTitle,
} from "./chat-title-policy.js";
import { resolveChatTitleRoute } from "./chat-title-routing.js";
import { configStore } from "./config-store.js";
import { foundationModelsConnection } from "./foundation-models-connection.js";
import { runtimeSupportsImages } from "./generation-runtime.js";
import { resolveModelRuntime } from "./model-runtime.js";
import {
  assistantUsageRecord,
  isLocalModelProvider,
  unreportedUsageRecord,
} from "./usage-accounting.js";
import { usageStore } from "./usage-store.js";

const TITLE_TIMEOUT_MS = 15_000;
const inFlight = new Map<string, Promise<void>>();
const manualRenameInFlight = new Map<string, Promise<ChatTitleRenameResult>>();

export interface ChatTitleModelSelection {
  providerId: string;
  model: string;
}

export interface ChatTitleRenameResult {
  chatId: string;
  workspaceId?: string;
  title: string;
  updatedAt: number;
  changed: boolean;
}

function titleUpdate(chat: {
  id: string;
  workspaceId?: string;
  title: string;
  updatedAt: number;
}): Omit<ChatTitleRenameResult, "changed"> {
  return {
    chatId: chat.id,
    workspaceId: chat.workspaceId,
    title: chat.title,
    updatedAt: chat.updatedAt,
  };
}

function publishTitleUpdate(chat: {
  id: string;
  workspaceId?: string;
  title: string;
  updatedAt: number;
}): Omit<ChatTitleRenameResult, "changed"> {
  const update = titleUpdate(chat);
  ipcMain.broadcast("chats:metadata-updated", update);
  return update;
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
  const promptContent: Array<TextContent | ImageContent> = [
    {
      type: "text",
      text: buildChatTitlePrompt(input.firstMessage),
    },
  ];
  const firstImage = input.firstMessage.attachments?.find(
    (attachment) => attachment.kind === "image" && attachment.data,
  );
  if (runtimeSupportsImages(runtime.model) && firstImage?.data) {
    promptContent.push({
      type: "image",
      data: firstImage.data,
      mimeType: firstImage.mimeType,
    });
  }

  let result: AssistantMessage;
  try {
    result = await runtime.streams
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
  } catch (error) {
    await usageStore.record(
      unreportedUsageRecord({
        source: "chat-title",
        providerId: runtime.provider.id,
        providerLabel: runtime.provider.label,
        modelId: runtime.model.id,
        modelLabel: runtime.model.name,
        local: isLocalModelProvider(runtime.provider),
        status: input.signal.aborted ? "cancelled" : "failed",
      }),
    );
    throw error;
  }
  await usageStore.record(
    assistantUsageRecord({
      message: result,
      provider: runtime.provider,
      model: runtime.model,
      source: "chat-title",
    }),
  );
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error(result.errorMessage || `Title generation ${result.stopReason}.`);
  }
  return assistantText(result.content);
}

async function generateWithAppleFoundationModels(
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const title = await foundationModelsConnection.generateTitle(prompt, signal);
    await usageStore.record(
      unreportedUsageRecord({
        source: "chat-title",
        providerId: "apple-foundation-models",
        providerLabel: "Apple Foundation Models",
        modelId: "apple-foundation-model",
        modelLabel: "Apple Foundation Model",
        local: true,
        status: "completed",
      }),
    );
    return title;
  } catch (error) {
    await usageStore.record(
      unreportedUsageRecord({
        source: "chat-title",
        providerId: "apple-foundation-models",
        providerLabel: "Apple Foundation Models",
        modelId: "apple-foundation-model",
        modelLabel: "Apple Foundation Model",
        local: true,
        status: signal.aborted ? "cancelled" : "failed",
      }),
    );
    throw error;
  }
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
        ? await generateWithAppleFoundationModels(
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

    publishTitleUpdate(updated);
  } finally {
    clearTimeout(timeout);
  }
}

async function generateFoundationModelsRename(chatId: string): Promise<ChatTitleRenameResult> {
  const backgroundTitle = inFlight.get(chatId);
  if (backgroundTitle) await backgroundTitle;

  const chat = await chatStore.get(chatId);
  if (!chat) throw new Error("That chat no longer exists.");
  const hasUserContext = chat.messages.some(
    (message) =>
      message.role === "user" &&
      (message.content.trim().length > 0 || (message.attachments?.length ?? 0) > 0),
  );
  if (!hasUserContext) {
    throw new Error("Start the conversation before asking Apple to rename it.");
  }

  const status = await foundationModelsConnection.status();
  if (status?.state !== "ready") {
    throw new Error(
      status?.detail ?? "Apple Foundation Models are available only on supported Macs.",
    );
  }

  const expectedTitle = chat.title;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), TITLE_TIMEOUT_MS);
  try {
    const rawTitle = await generateWithAppleFoundationModels(
      buildChatRenamePrompt(chat.messages),
      abortController.signal,
    );
    const generatedTitle = sanitizeGeneratedChatTitle(rawTitle);
    if (!generatedTitle) {
      throw new Error("Apple Foundation Models did not return a usable title.");
    }
    if (generatedTitle === expectedTitle) {
      return { ...titleUpdate(chat), changed: false };
    }

    const updated = await chatStore.replaceTitleIfUnchanged(
      chatId,
      expectedTitle,
      generatedTitle,
    );
    if (!updated) {
      throw new Error("The chat title changed while Apple was generating. The newer title was kept.");
    }
    return { ...publishTitleUpdate(updated), changed: true };
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

  async renameWithFoundationModels(chatId: string): Promise<ChatTitleRenameResult> {
    const existing = manualRenameInFlight.get(chatId);
    if (existing) return existing;
    const task = generateFoundationModelsRename(chatId);
    manualRenameInFlight.set(chatId, task);
    try {
      return await task;
    } finally {
      if (manualRenameInFlight.get(chatId) === task) manualRenameInFlight.delete(chatId);
    }
  },
};
