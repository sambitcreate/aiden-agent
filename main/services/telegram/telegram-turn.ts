// Telegram headless turn injection — the Aiden shim that replaces pi-telegram's
// Pi-SDK host contract (lib/pi.ts). Maps the original ExtensionAPI ports onto
// Aiden's llmClient + chatStore primitives, mirroring the proven headless-turn
// pattern in schedule-execution.ts.
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT).

import type { NotificationChannel } from "../../../renderer/preload-channels.js";
import type { Attachment, ChatDone, ChatError } from "../types.js";
import type { GenerationThinkingLevel } from "../../../renderer/shared/generation-thinking.js";
import type { UsageRequestSource } from "../usage-store-core.js";
import type { ChatGenerationOwner } from "../chat-generation-owner.js";
import { scheduledProviderFingerprint } from "../schedule-provider-binding.js";
import type { TelegramBotBindingSnapshot } from "./telegram-queue.js";

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
      thinkingLevel?: GenerationThinkingLevel;
      messages: Array<{ role: "user"; content: string; attachments?: Attachment[] }>;
    },
    owner: ChatGenerationOwner,
    options: {
      permission: "full";
      allowComputerUse: boolean;
      allowSubagents: boolean;
      allowMcpTools: boolean;
      interactionSurface: "telegram";
      usageSource: UsageRequestSource;
      turnId: string;
      providerFingerprint?: string;
    },
  ): Promise<boolean>;
  isChatBusy(chatId: string): boolean;
  waitForChatIdle(chatId: string): Promise<boolean>;
  cancelChat?(chatId: string): Promise<void>;
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
    botId?: string;
    providerId?: string;
    model?: string;
  }): Promise<{ id: string; workspaceId?: string; botId?: string; title: string; updatedAt: number }>;
  get(
    id: string,
  ): Promise<{ id: string; workspaceId?: string; botId?: string; title: string; updatedAt: number } | null>;
  appendMessage(
    id: string,
    message: { role: "user" | "assistant"; content: string; attachments?: Attachment[] },
    meta?: { providerId?: string; model?: string },
  ): Promise<{ id: string; workspaceId?: string; botId?: string; title: string; updatedAt: number }>;
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
  resolveThinkingLevel?(): Promise<GenerationThinkingLevel | undefined>;
  broadcastMetadata(chat: {
    id: string;
    workspaceId?: string;
    title: string;
    updatedAt: number;
  }): void;
  /** Resolve the selection captured when the Telegram prompt was accepted. */
  resolveWorkspace(workspaceId?: string): Promise<TelegramWorkspaceResolution>;
}

export type TelegramWorkspaceResolution =
  | { kind: "assistant" }
  | { kind: "project"; workspaceId: string }
  | { kind: "stale" };

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
export function createTelegramBackgroundOwner(
  streamId: string,
  observer: (channel: NotificationChannel, payload: unknown) => void = () => undefined,
): {
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
      observer(channel, payload);
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

/** Persistent chat id for a Telegram owner and optional project workspace. */
export function telegramChatId(ownerUserId: number, workspaceId?: string, profile?: string): string {
  // Keep the default profile's historical id so existing installations retain
  // their transcript. Named profiles get an explicit namespace, preventing
  // the same owner paired to two Telegram tokens from sharing Pi state.
  const profilePrefix = profile && profile !== "default" ? `${profile}-` : "";
  return workspaceId
    ? `telegram-${profilePrefix}${ownerUserId}-${workspaceId}`
    : `telegram-${profilePrefix}${ownerUserId}`;
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
  workspaceId?: string,
  profile?: string,
  binding?: TelegramBotBindingSnapshot,
): Promise<string> {
  const chatId = binding?.backingChatId ?? telegramChatId(ownerUserId, workspaceId, profile);
  const existing = await deps.chatStore.get(chatId);
  if (existing) {
    if (binding && (
      existing.botId !== binding.botId ||
      existing.workspaceId !== binding.backingWorkspaceId ||
      workspaceId !== binding.backingWorkspaceId
    )) {
      throw new Error("The Telegram backing chat belongs to a different bot or workspace binding.");
    }
    deps.broadcastMetadata(existing);
    return chatId;
  }
  const chat = await deps.chatStore.create({
    id: chatId,
    title,
    providerId,
    workspaceId,
    ...(binding ? { botId: binding.botId } : {}),
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
  workspace?: TelegramWorkspaceResolution,
  attachments?: readonly Attachment[],
  observer?: (channel: NotificationChannel, payload: unknown) => void,
  options?: { binding?: TelegramBotBindingSnapshot },
): Promise<TelegramTurnResult> {
  const resolvedWorkspace = workspace ?? (await deps.resolveWorkspace());
  if (resolvedWorkspace.kind === "stale") {
    return {
      content: "",
      error:
        "The Telegram workspace is no longer available. Choose a folder workspace in Aiden Settings.",
      ok: false,
    };
  }
  const workspaceId =
    resolvedWorkspace.kind === "project" ? resolvedWorkspace.workspaceId : undefined;
  const provider = await deps.resolveProvider();
  if (!provider) {
    return {
      content: "",
      error: "No provider is configured. Choose a provider in Aiden first.",
      ok: false,
    };
  }

  const streamId = telegramStreamId();
  const thinkingLevel = await deps.resolveThinkingLevel?.();
  const background = createTelegramBackgroundOwner(streamId, observer);
  const turn = deps.llmClient.beginChatTurn(chatId, streamId, background.owner.documentId);
  if (!turn) {
    return { content: "", error: "The Telegram chat already has a turn in progress.", ok: false };
  }

  try {
    try {
      await deps.chatStore.appendMessage(
        chatId,
        {
          role: "user",
          content,
          ...(attachments?.length ? { attachments: [...attachments] } : {}),
        },
        { providerId: provider.providerId, model: provider.model },
      );
    } finally {
      turn.settleAsyncWork();
    }

    const started = await deps.llmClient.start(
      streamId,
      {
        chatId,
        workspaceId,
        providerId: provider.providerId,
        model: provider.model,
        // Bot-bound turns use the normal Pi mode. Unbound Telegram keeps the
        // existing unattended/automation mode contract unchanged.
        ...(options?.binding
          ? {}
          : { mode: workspaceId ? "assistant-automation" as const : "assistant-unattended" as const }),
        thinkingLevel,
        messages: [
          {
            role: "user",
            content,
            ...(attachments?.length ? { attachments: [...attachments] } : {}),
          },
        ],
      },
      background.owner,
      {
        permission: "full",
        allowComputerUse: false,
        allowSubagents: false,
        allowMcpTools: false,
        interactionSurface: "telegram",
        usageSource: "telegram",
        turnId: streamId,
        providerFingerprint: scheduledProviderFingerprint(provider.provider),
      },
    );

    if (!started) {
      return {
        content: "",
        error: "The Telegram generation was cancelled before it started.",
        ok: false,
      };
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

/** Abort and settle the persistent Telegram chat through Aiden's generation owner. */
export async function abortTelegramChat(deps: TelegramTurnDeps, chatId: string): Promise<void> {
  if (!deps.llmClient.cancelChat) return;
  await deps.llmClient.cancelChat(chatId);
}
