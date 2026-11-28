// Electron-free orchestration for background first-turn titles and explicit
// Apple Foundation Models renames. Reads chats with image references only and
// hydrates at most one image when a vision chat model generates the title.

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { isAcpHarnessProvider } from "../../renderer/shared/acp-harness.js";
import {
  assertRenameAllowedFromChat,
  buildChatRenamePrompt,
  buildChatTitlePrompt,
  canReplaceGeneratedChatTitle,
  deriveChatTitleSeed,
  sanitizeGeneratedChatTitle,
} from "./chat-title-policy.js";
import {
  requestChatTitle,
  TITLE_TIMEOUT_MS,
  type ChatTitleFirstMessage,
} from "./chat-title-request.js";
import { resolveChatTitleRoute } from "./chat-title-routing.js";
import { isHookBlockedPrompt } from "./hook-blocked-prompt.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import type { Chat, FoundationModelsConnectionStatus } from "./types.js";
import {
  assistantUsageRecord,
  isLocalModelProvider,
  unreportedUsageRecord,
} from "./usage-accounting.js";

export interface ChatTitleModelSelection {
  providerId: string;
  model: string;
}

export interface ChatTitleRenameResult {
  chatId: string;
  workspaceId?: string;
  title: string;
  updatedAt: number;
  ephemeral?: true;
  changed: boolean;
}

export interface ChatTitleServiceDependencies {
  chatStore: {
    getWithImageReferences(id: string): Promise<Chat | null>;
    readImage(sha256: string, size: number): Promise<Uint8Array | undefined>;
    replaceAutoTitle(id: string, expectedSeed: string, title: string): Promise<Chat | null>;
    replaceTitleIfUnchanged(id: string, expectedTitle: string, title: string): Promise<Chat | null>;
  };
  configStore: {
    getSettings(): Promise<{
      chatTitleProviderId?: Parameters<typeof resolveChatTitleRoute>[0];
    }>;
  };
  foundationModelsConnection: {
    status(): Promise<FoundationModelsConnectionStatus | null>;
    generateTitle(prompt: string, signal: AbortSignal): Promise<string>;
  };
  hostPlatformCapabilities(): { appleFoundationModels: boolean };
  resolveModelRuntime(
    providerId: string,
    model: string,
    signal: AbortSignal,
    chatId: string,
  ): Promise<ResolvedModelRuntime>;
  usageStore: {
    record(
      entry:
        | ReturnType<typeof assistantUsageRecord>
        | ReturnType<typeof unreportedUsageRecord>,
    ): Promise<unknown>;
  };
  broadcastMetadataUpdated(update: Omit<ChatTitleRenameResult, "changed">): void;
  logWarn(message: string, details: Record<string, unknown>): void;
}

function titleUpdate(chat: {
  id: string;
  workspaceId?: string;
  title: string;
  updatedAt: number;
  ephemeral?: true;
}): Omit<ChatTitleRenameResult, "changed"> {
  return {
    chatId: chat.id,
    workspaceId: chat.workspaceId,
    title: chat.title,
    updatedAt: chat.updatedAt,
    ...(chat.ephemeral ? { ephemeral: true as const } : {}),
  };
}

function assistantText(content: AssistantMessage["content"]): string {
  return content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export function createChatTitleService(deps: ChatTitleServiceDependencies) {
  const inFlight = new Map<string, Promise<void>>();
  const manualRenameInFlight = new Map<string, Promise<ChatTitleRenameResult>>();

  function publishTitleUpdate(chat: {
    id: string;
    workspaceId?: string;
    title: string;
    updatedAt: number;
    ephemeral?: true;
  }): Omit<ChatTitleRenameResult, "changed"> {
    const update = titleUpdate(chat);
    deps.broadcastMetadataUpdated(update);
    return update;
  }

  async function generateWithChatModel(input: {
    chatId: string;
    firstMessage: ChatTitleFirstMessage;
    selection: ChatTitleModelSelection;
    signal: AbortSignal;
  }): Promise<string> {
    const runtime = await deps.resolveModelRuntime(
      input.selection.providerId,
      input.selection.model,
      input.signal,
      input.chatId,
    );
    let result: AssistantMessage;
    try {
      result = await requestChatTitle(runtime, input.firstMessage, input.signal, {
        readImage: (sha256, size) => deps.chatStore.readImage(sha256, size),
      });
    } catch (error) {
      await deps.usageStore.record(
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
    await deps.usageStore.record(
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
      const title = await deps.foundationModelsConnection.generateTitle(prompt, signal);
      await deps.usageStore.record(
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
      await deps.usageStore.record(
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
    const chat = await deps.chatStore.getWithImageReferences(input.chatId);
    if (!chat) return;

    // A prompt a hook refused never reached the model, so it neither earns a
    // title nor stops the next accepted prompt from being the first turn.
    const userMessages = chat.messages.filter(
      (message) => message.role === "user" && !isHookBlockedPrompt(message),
    );
    if (userMessages.length !== 1) return;
    const firstMessage = userMessages[0];
    if (!firstMessage) return;

    const titleSeed = deriveChatTitleSeed(firstMessage);
    if (!canReplaceGeneratedChatTitle(chat.title, titleSeed)) return;

    const settings = await deps.configStore.getSettings();
    const titleProviderId = settings.chatTitleProviderId ?? "automatic";
    const foundationModelsStatus =
      titleProviderId === "chat-model" ||
      !deps.hostPlatformCapabilities().appleFoundationModels
        ? null
        : await deps.foundationModelsConnection.status();
    const route = resolveChatTitleRoute(titleProviderId, foundationModelsStatus);
    if (route === "seed-only") return;
    // An agent harness only runs inside its chat turn; keep the seeded title.
    if (route === "chat-model" && isAcpHarnessProvider(input.fallbackSelection.providerId)) return;

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
              chatId: input.chatId,
              firstMessage,
              selection: input.fallbackSelection,
              signal: abortController.signal,
            });
      const generatedTitle = sanitizeGeneratedChatTitle(rawTitle);
      if (!generatedTitle) return;
      const updated = await deps.chatStore.replaceAutoTitle(input.chatId, titleSeed, generatedTitle);
      if (!updated) return;

      publishTitleUpdate(updated);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function generateFoundationModelsRename(
    chatId: string,
    options: { rejectFeatureOwned?: boolean } = {},
  ): Promise<ChatTitleRenameResult> {
    if (!deps.hostPlatformCapabilities().appleFoundationModels) {
      throw new Error("Apple Foundation Models are not available on this platform.");
    }
    const backgroundTitle = inFlight.get(chatId);
    if (backgroundTitle) await backgroundTitle;

    const chat = await deps.chatStore.getWithImageReferences(chatId);
    if (!chat) throw new Error("That chat no longer exists.");
    assertRenameAllowedFromChat(chat, options);
    const hasUserContext = chat.messages.some(
      (message) =>
        message.role === "user" &&
        (message.content.trim().length > 0 || (message.attachments?.length ?? 0) > 0),
    );
    if (!hasUserContext) {
      throw new Error("Start the conversation before asking Apple to rename it.");
    }

    const status = await deps.foundationModelsConnection.status();
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

      const updated = await deps.chatStore.replaceTitleIfUnchanged(
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

  return {
    isFirstTurnPending(chatId: string): boolean {
      return inFlight.has(chatId);
    },

    /** Awaits any in-flight first-turn title generation for `chatId` (test and coordination seam). */
    waitForFirstTurn(chatId: string): Promise<void> {
      return inFlight.get(chatId) ?? Promise.resolve();
    },

    startForFirstTurn(input: { chatId: string; providerId: string; model: string }): void {
      if (!input.chatId || inFlight.has(input.chatId)) return;
      const task = generateFirstTurnTitle({
        chatId: input.chatId,
        fallbackSelection: { providerId: input.providerId, model: input.model },
      })
        .catch((error: unknown) => {
          deps.logWarn("Background title generation failed", {
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

    async renameWithFoundationModels(
      chatId: string,
      options: { rejectFeatureOwned?: boolean } = {},
    ): Promise<ChatTitleRenameResult> {
      const existing = manualRenameInFlight.get(chatId);
      if (existing) return existing;
      const task = generateFoundationModelsRename(chatId, options);
      manualRenameInFlight.set(chatId, task);
      try {
        return await task;
      } finally {
        if (manualRenameInFlight.get(chatId) === task) manualRenameInFlight.delete(chatId);
      }
    },
  };
}
