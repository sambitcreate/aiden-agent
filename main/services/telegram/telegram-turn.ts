// Telegram headless turn injection — the Aiden shim that replaces pi-telegram's
// Pi-SDK host contract (lib/pi.ts). Maps the original ExtensionAPI ports onto
// Aiden's llmClient + chatStore primitives, mirroring the proven headless-turn
// pattern in schedule-execution.ts.
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT).

import type { NotificationChannel } from "../../../renderer/preload-channels.js";
import type { ChatDone, ChatError } from "../types.js";
import type { UsageRequestSource } from "../usage-store-core.js";
import type { ChatGenerationOwner } from "../chat-generation-owner.js";
import { scheduledProviderFingerprint } from "../schedule-provider-binding.js";

/** Minimal llmClient surface the shim needs. */
export interface TelegramLlmClient {
  beginChatTurn(chatId: string, turnId: string, ownerId: string): ChatTurnLease | null;
  start(
    streamId: string,
    params: {
      chatId: string;
      workspaceId?: string;
      providerId: string;
      model: string;
      mode?: "assistant-unattended" | "assistant-automation";
      messages: Array<{ role: "user"; content: string }>;
    },
    owner: ChatGenerationOwner,
    options: {
      permission: "full";
      allowComputerUse: boolean;
      allowSubagents: boolean;
      allowMcpTools: boolean;
      usageSource: UsageRequestSource;
      turnId: string;
      providerFingerprint?: string;
    },
  ): Promise<boolean>;
  isChatBusy(chatId: string): boolean;
  waitForChatIdle(chatId: string): Promise<boolean>;
}

export interface ChatTurnLease {
  release(): void;
  settleAsyncWork(): void;
}

/** Minimal chatStore surface the shim needs. */
export interface TelegramChatStore {
  create(input: {
    id: string;
    title: string;
    workspaceId?: string;
    providerId?: string;
    model?: string;
  }): Promise<{ id: string; workspaceId?: string; title: string; updatedAt: number }>;
  get(id: string): Promise<{ id: string; workspaceId?: string; title: string; updatedAt: number } | null>;
  appendMessage(
    id: string,
    message: { role: "user" | "assistant"; content: string },
    meta?: { providerId?: string; model?: string },
  ): Promise<{ id: string; workspaceId?: string; title: string; updatedAt: number }>;
}

export interface TelegramTurnDeps {
  llmClient: TelegramLlmClient;
  chatStore: TelegramChatStore;
  resolveProvider(): Promise<{
    providerId: string;
    model: string;
    provider: Pick<
      import("../types.js").StoredProvider,
      "id" | "kind" | "label" | "baseUrl" | "needsKey" | "deployment" | "isBuiltin"
    >;
  } | null>;
  broadcastMetadata(chat: { id: string; workspaceId?: string; title: string; updatedAt: number }): void;
}

let telegramTurnSequence = 0;

function telegramStreamId(): string {
  telegramTurnSequence += 1;
  return `telegram-${Date.now().toString(36)}-${telegramTurnSequence.toString(36)}`;
}

/**
 * Synthetic ChatGenerationOwner for Telegram-originated turns.
 * Mirrors schedule-execution.ts createBackgroundOwner, extended to capture
 * chat:delta for optional streaming previews.
 */
export function createTelegramBackgroundOwner(streamId: string): {
  owner: ChatGenerationOwner;
  terminal: Promise<ChatDone | ChatError>;
  deltas: string[];
  destroy(): void;
} {
  let destroyed = false;
  const deltas: string[] = [];
  let settle: ((payload: ChatDone | ChatError) => void) | undefined;
  const terminal = new Promise<ChatDone | ChatError>((resolve) => {
    settle = resolve;
  });
  const owner: ChatGenerationOwner = {
    id: 0,
    documentId: `telegram:${streamId}`,
    isDestroyed: () => destroyed,
    send: (channel: NotificationChannel, payload: unknown) => {
      if (destroyed) throw new Error("The Telegram generation is no longer active.");
      if (channel === "chat:done" || channel === "chat:error") {
        settle?.(payload as ChatDone | ChatError);
      } else if (channel === "chat:delta") {
        const delta = (payload as { delta?: string })?.delta;
        if (delta) deltas.push(delta);
      }
    },
    onInvalidated: () => () => undefined,
  };
  return {
    owner,
    terminal,
    deltas,
    destroy: () => {
      destroyed = true;
    },
  };
}

/** Persistent chat id for a Telegram owner: `telegram-<userId>`. */
export function telegramChatId(ownerUserId: number): string {
  return `telegram-${ownerUserId}`;
}

/**
 * Ensure the persistent backing chat exists for a Telegram owner.
 * Created once on first inbound message, reused across all turns.
 */
export async function ensureTelegramChat(
  deps: TelegramTurnDeps,
  ownerUserId: number,
  title: string,
  providerId?: string,
  model?: string,
): Promise<string> {
  const chatId = telegramChatId(ownerUserId);
  const existing = await deps.chatStore.get(chatId);
  if (existing) {
    deps.broadcastMetadata(existing);
    return chatId;
  }
  const chat = await deps.chatStore.create({
    id: chatId,
    title,
    providerId,
    model,
  });
  deps.broadcastMetadata(chat);
  return chatId;
}

/** Result of a Telegram headless turn. */
export interface TelegramTurnResult {
  readonly content: string;
  readonly error: string | null;
  readonly ok: boolean;
}

/**
 * Inject a Telegram-originated prompt as a headless Aiden turn.
 *
 * This is the shim for pi-telegram's `ExtensionAPI.sendUserMessage(content)`.
 * It follows the exact schedule-execution.ts executeLlm pattern:
 *   beginChatTurn → appendMessage → llmClient.start → await terminal → release.
 *
 * Permission is always "full" with an unattended mode — no GUI approval surface.
 * The chat is always the persistent `telegram-<ownerId>` chat.
 */
export async function sendTelegramTurn(
  deps: TelegramTurnDeps,
  chatId: string,
  content: string,
): Promise<TelegramTurnResult> {
  const provider = await deps.resolveProvider();
  if (!provider) {
    return { content: "", error: "No provider is configured. Choose a provider in Aiden first.", ok: false };
  }

  const streamId = telegramStreamId();
  const background = createTelegramBackgroundOwner(streamId);
  const turn = deps.llmClient.beginChatTurn(chatId, streamId, background.owner.documentId);
  if (!turn) {
    return { content: "", error: "The Telegram chat already has a turn in progress.", ok: false };
  }

  try {
    try {
      await deps.chatStore.appendMessage(
        chatId,
        { role: "user", content },
        { providerId: provider.providerId, model: provider.model },
      );
    } finally {
      turn.settleAsyncWork();
    }

    const started = await deps.llmClient.start(
      streamId,
      {
        chatId,
        providerId: provider.providerId,
        model: provider.model,
        mode: "assistant-unattended",
        messages: [{ role: "user", content }],
      },
      background.owner,
      {
        permission: "full",
        allowComputerUse: false,
        allowSubagents: false,
        allowMcpTools: false,
        usageSource: "telegram",
        turnId: streamId,
        providerFingerprint: scheduledProviderFingerprint(provider.provider),
      },
    );

    if (!started) {
      return { content: "", error: "The Telegram generation was cancelled before it started.", ok: false };
    }

    const terminal = await background.terminal;
    if ("message" in terminal) {
      return { content: terminal.content ?? "", error: terminal.message, ok: false };
    }
    return { content: terminal.content, error: null, ok: true };
  } finally {
    turn.release();
    background.destroy();
  }
}

/** Check if the persistent chat is currently busy (a turn is in flight). */
export function isTelegramChatIdle(deps: TelegramTurnDeps, chatId: string): boolean {
  return !deps.llmClient.isChatBusy(chatId);
}

/** Wait for the chat to become idle (used during abort/cancel). */
export async function waitForTelegramChatIdle(
  deps: TelegramTurnDeps,
  chatId: string,
): Promise<boolean> {
  return deps.llmClient.waitForChatIdle(chatId);
}
