// Telegram service core — the polling orchestrator that ties together
// inbound handling, owner pairing, queue dispatch, and outbound reply delivery.
//
// This is the pure factory that schedule-service-core.ts / schedule-service.ts
// models: start() / stop() / stopAndSettle(), idempotent lifecycle, DI for tests.
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT).

import type {
  TelegramBotApi,
  TelegramUpdate,
  TelegramMessage,
  TelegramCallbackQuery,
  TelegramInlineKeyboardMarkup,
  TelegramMessageReactionUpdated,
} from "./telegram-bot-api.js";
import { TelegramApiError } from "./telegram-bot-api.js";
import type { TelegramConfig } from "./telegram-config.js";
import type { TelegramTurnDeps, TelegramTurnResult } from "./telegram-turn.js";
import { sendTelegramTurn, ensureTelegramChat, telegramChatId } from "./telegram-turn.js";
import {
  createTelegramQueue,
  classifyMessage,
  type TelegramQueue,
  type QueuedTelegramTurn,
  type TelegramBotBindingSnapshot,
} from "./telegram-queue.js";
import { chunkRichMarkdown, markdownToTelegramHtml, chunkForTelegram } from "./telegram-markdown.js";
import {
  TELEGRAM_COMMANDS,
  buildMainMenu,
  buildModelMenu,
  buildQueueItemMenu,
  buildQueueMenu,
  buildSettingsMenu,
  buildStatusText,
  buildThinkingMenu,
  buildWorkspaceMenu,
  commandArgument,
  commandName,
  confirmationMenu,
  escapeHtml,
  type TelegramControlStatus,
  type TelegramModelChoice,
} from "./telegram-controls.js";
import type { TelegramCompactionResult } from "./telegram-session.js";
import { normalizeTelegramInbound } from "./telegram-inbound.js";
import { GENERATION_THINKING_LEVELS } from "../../../renderer/shared/generation-thinking.js";
import { createTelegramActivityProjector } from "./telegram-activity.js";
import {
  createTelegramButtonStore,
  markTelegramButtonSelected,
  planTelegramReply,
} from "./telegram-outbound.js";

const POLL_TIMEOUT_SECONDS = 30;
const ERROR_SLEEP_MS = 3_000;
const TYPING_INTERVAL_MS = 2_500;
const MEDIA_GROUP_DEBOUNCE_MS = 1_200;

/** Extract text content from a Telegram message (text or caption). */
function extractText(message: TelegramMessage): string | undefined {
  return message.text ?? message.caption;
}

export type TelegramServiceStatus = "disabled" | "idle" | "polling" | "error";

export interface TelegramServiceState {
  status: TelegramServiceStatus;
  botUsername?: string;
  lastError?: string;
  queuedCount: number;
  recentDiagnostics: readonly TelegramDiagnosticEvent[];
}

export interface TelegramDiagnosticEvent {
  at: number;
  level: "info" | "warning" | "error" | "recovery";
  message: string;
}

export interface TelegramServiceDeps {
  api: TelegramBotApi;
  config: TelegramConfig;
  turn: TelegramTurnDeps;
  /** Telegram profile namespace. Required by production wiring to isolate chats. */
  profile?: string;
  /** Resolve an exact private-chat/topic route after owner authorization. */
  resolveBotBinding?(input: TelegramBotBindingLookup): Promise<TelegramBotBindingSnapshot | null | undefined>;
  /** Alias accepted by profile managers that name the resolver explicitly. */
  resolveTelegramBotBinding?(input: TelegramBotBindingLookup): Promise<TelegramBotBindingSnapshot | null | undefined>;
  /** Validate that a resolved binding still points to a live, non-archived bot. */
  validateBotBinding?(binding: TelegramBotBindingSnapshot): Promise<TelegramBotBindingValidation> | TelegramBotBindingValidation;
  getToken(): Promise<string | null>;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  warn(message: string): void;
  error(message: string, cause?: unknown): void;
  info(message: string): void;
  listWorkspaces(): Promise<readonly TelegramSelectableWorkspace[]>;
  listModels?(): Promise<readonly TelegramModelChoice[]>;
  abortChat?(chatId: string): Promise<void>;
  compactChat?(chatId: string): Promise<TelegramCompactionResult>;
  transcribeAudio?(input: { audioBase64: string; mimeType: string }): Promise<string>;
  storeInboundFile?(input: { bytes: Uint8Array; name: string; mimeType: string; workspaceId?: string }): Promise<string>;
  listPromptCommands?(workspaceId?: string): Promise<readonly TelegramPromptCommand[]>;
  readOutboundAttachment?(workspaceId: string | undefined, requestedPath: string): Promise<{
    bytes: Uint8Array;
    name: string;
    mimeType: string;
  }>;
  applyModelSelection?(choice: TelegramModelChoice): Promise<void>;
  mediaGroupDebounceMs?: number;
  synthesizeVoice?(text: string, options: {
    lang?: string;
    rate?: string;
    chatId: number;
    threadId?: number;
    ownerUserId: number;
    workspaceId?: string;
  }): Promise<{ bytes: Uint8Array; name?: string; mimeType?: "audio/ogg" | "audio/opus"; caption?: string } | undefined>;
  extensionStatus?(): Promise<{
    rows: readonly string[];
    sections: readonly { label: string; callbackData: string }[];
  }>;
  handleExtensionCallback?(data: string, context: TelegramExtensionRuntimeContext): Promise<string | void>;
  handleExtensionUpdate?(update: TelegramUpdate, context: TelegramExtensionRuntimeContext): Promise<boolean>;
  transformInbound?(content: Awaited<ReturnType<typeof normalizeTelegramInbound>>, message: TelegramMessage, context: TelegramExtensionRuntimeContext): Promise<Awaited<ReturnType<typeof normalizeTelegramInbound>>>;
  transformOutbound?(markdown: string, context: TelegramExtensionRuntimeContext): Promise<string>;
  resolveThreadWorkspace?(threadId: number): Promise<string | undefined>;
  ensureThreadTargets?(chatId: number): Promise<void>;
  clearThreadTargets?(): Promise<void>;
  acquireOwnership?(): { acquired: boolean; recovered: boolean; ownerPid?: number };
  releaseOwnership?(): void;
}

export interface TelegramBotBindingLookup {
  profile: string;
  chatId: number;
  threadId?: number;
  ownerUserId: number;
}

export type TelegramBotBindingValidation =
  | void
  | boolean
  | string
  | { valid: boolean; reason?: string };

interface TelegramExtensionRuntimeContext {
  chatId: number;
  threadId?: number;
  ownerUserId: number;
  workspaceId?: string;
}

interface TelegramSelectableWorkspace {
  id: string;
  name: string;
  folderPath: string;
}

interface TelegramPromptCommand {
  command: string;
  description: string;
  expand?(argument: string): string;
  handle?(argument: string, message: TelegramMessage, context: TelegramExtensionRuntimeContext): Promise<string | void>;
}

const TELEGRAM_HELP_TEXT = [
  "🤖 Aiden Telegram Agent",
  "",
  "Send any message and I'll respond as Aiden.",
  "",
  "Commands:",
  "/start — open the operator menu",
  "/compact — compact the current session",
  "/next — stop this turn and run the next queued prompt",
  "/continue — queue a continuation prompt",
  "/abort — abort the active turn",
  "/stop — abort the turn and clear the queue",
  "/status — show runtime status and controls",
  "/model — choose the Telegram model",
  "/thinking — choose reasoning effort",
  "/queue — inspect queued prompts",
  "/workspace — list and choose a workspace",
  "/settings — open Telegram agent settings",
  "",
  "A true same-thread /new session is not exposed because Aiden does not yet have a safe remote session-replacement API.",
].join("\n");

export function createTelegramServiceCore(deps: TelegramServiceDeps) {
  const buttonStore = createTelegramButtonStore(deps.now);
  const queue: TelegramQueue = createTelegramQueue({
    isActive: () => activeTurn,
    hasPendingDispatch: () => dispatchPending,
  });

  let started = false;
  let abortController: AbortController | undefined;
  let activeTurn = false;
  let activeChatId: string | undefined;
  let dispatchPending = false;
  let botUsername: string | undefined;
  let botTopicsEnabled: boolean | undefined;
  let lastError: string | undefined;
  let activeInput: QueuedTelegramTurn | undefined;
  const mediaGroups = new Map<string, {
    turn: QueuedTelegramTurn;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const diagnostics: TelegramDiagnosticEvent[] = [];

  function recordDiagnostic(level: TelegramDiagnosticEvent["level"], message: string): void {
    diagnostics.push({ at: deps.now(), level, message: message.replace(/\d{5,16}:[A-Za-z0-9_-]{20,}/gu, "[redacted-token]").slice(0, 500) });
    if (diagnostics.length > 50) diagnostics.splice(0, diagnostics.length - 50);
  }

  function bindingKey(binding: TelegramBotBindingSnapshot | undefined): string {
    if (!binding) return "unbound";
    return [
      binding.profile,
      binding.chatId,
      binding.threadId ?? "dm",
      binding.ownerUserId,
      binding.botId,
      binding.workspaceId,
      binding.backingChatId,
    ].join(":");
  }

  function sameBinding(
    left: TelegramBotBindingSnapshot | undefined,
    right: TelegramBotBindingSnapshot | undefined,
  ): boolean {
    return bindingKey(left) === bindingKey(right);
  }

  /**
   * Resolve and freeze a route only after the private-chat and paired-owner
   * gates have passed. The snapshot is then carried through queue admission;
   * rebinding the same Telegram source cannot retarget accepted work.
   */
  async function resolveBinding(
    chatId: number,
    threadId: number | undefined,
    ownerUserId: number,
  ): Promise<TelegramBotBindingSnapshot | undefined> {
    const resolver = deps.resolveBotBinding ?? deps.resolveTelegramBotBinding;
    if (!resolver) return undefined;
    const expected: TelegramBotBindingLookup = {
      profile: deps.profile ?? "default",
      chatId,
      threadId,
      ownerUserId,
    };
    const resolved = await resolver(expected);
    if (!resolved) return undefined;
    if (
      resolved.profile !== expected.profile ||
      resolved.chatId !== expected.chatId ||
      resolved.threadId !== expected.threadId ||
      resolved.ownerUserId !== expected.ownerUserId ||
      resolved.botId.trim().length === 0 ||
      resolved.workspaceId.trim().length === 0 ||
      resolved.backingChatId.trim().length === 0
    ) {
      throw new Error("Telegram bot binding did not match the source chat exactly.");
    }
    if (resolved.enabled === false) {
      throw new Error("This Telegram bot binding is disabled. Restore it from Bots to continue.");
    }
    const binding = Object.freeze({ ...resolved });
    const validation = await deps.validateBotBinding?.(binding);
    if (validation === false) throw new Error("This Telegram bot is unavailable or archived.");
    if (typeof validation === "string") throw new Error(validation);
    if (validation && typeof validation === "object" && !validation.valid) {
      throw new Error(validation.reason ?? "This Telegram bot is unavailable or archived.");
    }
    return binding;
  }

  async function rejectBinding(
    chatId: number,
    threadId: number | undefined,
    cause: unknown,
  ): Promise<void> {
    const message = cause instanceof Error ? cause.message : String(cause);
    deps.warn(`Telegram bot binding rejected: ${message}`);
    await deps.api.sendMessage({
      chatId,
      threadId,
      text: `⚠️ ${message}`,
    }).catch(() => undefined);
  }

  function clearMediaGroups(): void {
    for (const group of mediaGroups.values()) clearTimeout(group.timer);
    mediaGroups.clear();
  }

  function getStatus(): TelegramServiceState {
    return {
      status: started ? (lastError ? "error" : "polling") : "disabled",
      botUsername,
      lastError,
      queuedCount: queue.size(),
      recentDiagnostics: [...diagnostics],
    };
  }

  async function start(): Promise<void> {
    if (started) return;
    const snap = await deps.config.snapshot();
    if (!snap.enabled || !snap.hasToken) return;
    const ownership = deps.acquireOwnership?.();
    if (ownership && !ownership.acquired) {
      lastError = `Telegram profile is already owned by process ${ownership.ownerPid ?? "unknown"}.`;
      recordDiagnostic("warning", lastError);
      return;
    }
    if (ownership?.recovered) recordDiagnostic("recovery", "Recovered a stale Telegram transport owner lease.");
    started = true;
    lastError = undefined;
    abortController = new AbortController();
    void runPollLoop(abortController.signal).catch((cause) => {
      if (abortController?.signal.aborted) return;
      lastError = cause instanceof Error ? cause.message : String(cause);
      recordDiagnostic("error", lastError);
      started = false;
      deps.releaseOwnership?.();
      deps.error("Telegram polling stopped unexpectedly.", cause);
    });
    deps.info("Telegram bridge started.");
    recordDiagnostic("info", "Telegram polling started.");
  }

  function stop(): void {
    started = false;
    abortController?.abort();
    abortController = undefined;
    queue.clear();
    clearMediaGroups();
    deps.releaseOwnership?.();
    // Do NOT reset activeTurn/dispatchPending here — the in-flight
    // dispatchTurn's finally block owns those. Resetting mid-turn
    // would allow a concurrent dispatch on the same chat.
  }

  async function stopAndSettle(): Promise<void> {
    const chatId = activeChatId;
    stop();
    if (chatId && deps.abortChat) {
      await deps.abortChat(chatId).catch((cause) => {
        deps.warn(`Telegram active turn did not settle cleanly: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    }
  }

  /** Force-start after enablement/token changes (bypasses the enabled gate). */
  async function connect(): Promise<void> {
    const snap = await deps.config.snapshot();
    if (!snap.hasToken) throw new Error("Cannot connect without a bot token.");
    if (started) return;
    const ownership = deps.acquireOwnership?.();
    if (ownership && !ownership.acquired) throw new Error(`Telegram profile is already owned by process ${ownership.ownerPid ?? "unknown"}.`);
    if (ownership?.recovered) recordDiagnostic("recovery", "Recovered a stale Telegram transport owner lease.");
    started = true;
    lastError = undefined;
    abortController = new AbortController();
    void runPollLoop(abortController.signal).catch((cause) => {
      if (abortController?.signal.aborted) return;
      lastError = cause instanceof Error ? cause.message : String(cause);
      recordDiagnostic("error", lastError);
      started = false;
      deps.releaseOwnership?.();
      deps.error("Telegram polling stopped unexpectedly.", cause);
    });
    deps.info("Telegram bridge connected.");
  }

  /** Disconnect and clear pairing (keeps the token). */
  async function disconnect(): Promise<void> {
    stop();
    await deps.config.clearOffset();
    deps.info("Telegram bridge disconnected.");
  }

  async function runPollLoop(signal: AbortSignal): Promise<void> {
    try {
      const me = await deps.api.getMe();
      botUsername = me.username;
      botTopicsEnabled = me.has_topics_enabled === true;
      deps.info(`Telegram bot connected as @${me.username}.`);
      const settings = await deps.config.getSettings();
      if (settings.telegramThreadedMode && !botTopicsEnabled) {
        recordDiagnostic("warning", "Private-chat threads are enabled in Aiden but disabled for this bot. Enable Threaded Mode in BotFather.");
      } else if (settings.telegramAllowedUserId !== undefined) {
        await deps.ensureThreadTargets?.(settings.telegramAllowedUserId).catch((cause) => {
          deps.warn(`Telegram thread provisioning is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
      }
      const templates = await deps.listPromptCommands?.(settings.telegramWorkspaceId).catch(() => []) ?? [];
      await deps.api.setMyCommands?.([
        ...TELEGRAM_COMMANDS,
        ...templates.slice(0, Math.max(0, 100 - TELEGRAM_COMMANDS.length)).map(({ command, description }) => ({ command, description })),
      ]).catch((cause) => {
        deps.warn(`Telegram command registration failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
      deps.error("Telegram getMe failed.", cause);
      started = false;
      deps.releaseOwnership?.();
      return;
    }

    let offset = await deps.config.getOffset();

    while (started && !signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await deps.api.getUpdates(offset, POLL_TIMEOUT_SECONDS, signal);
      } catch (cause) {
        if (signal.aborted || !started) break;
        lastError = cause instanceof Error ? cause.message : String(cause);
        recordDiagnostic("error", lastError);
        deps.error("Telegram getUpdates failed.", cause);
        await deps.sleep(ERROR_SLEEP_MS, signal).catch(() => undefined);
        continue;
      }

      lastError = undefined;

      for (const update of updates) {
        let handled = false;
        try {
          await handleUpdate(update);
          handled = true;
        } catch (cause) {
          deps.error(`Telegram handleUpdate failed for ${update.update_id}.`, cause);
        }
        // Persist the resume offset (update_id + 1) ONLY after successful
        // handling. On failure the update will be retried on the next poll.
        // Monotonic max is enforced inside persistOffset.
        if (handled) {
          offset = update.update_id + 1;
          try {
            await deps.config.persistOffset(update.update_id + 1);
          } catch (cause) {
            lastError = cause instanceof Error ? cause.message : String(cause);
            recordDiagnostic("error", lastError);
            deps.error(`Telegram offset persistence failed for ${update.update_id}.`, cause);
            await deps.sleep(ERROR_SLEEP_MS, signal).catch(() => undefined);
          }
        }
      }

      tryDispatch();
    }
  }

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message_reaction) {
      await handleReaction(update.message_reaction);
      return;
    }
    const message = update.message ?? update.edited_message ?? update.callback_query?.message;
    const from = update.message?.from ?? update.edited_message?.from ?? update.callback_query?.from;
    if (!message || !from) return;

    deps.info(
      `Telegram update ${update.update_id}: from=${from.id} (${from.username ?? "no-username"}) chat=${message.chat.id} type=${message.chat.type} text="${(message.text ?? "").slice(0, 80)}"`,
    );

    // Restrict to private chats — group/supergroup messages are ignored.
    if (message.chat.type !== "private") return;

    const snap = await deps.config.snapshot();

    // Authorization / pairing gate (checked before answering callbacks).
    if (snap.allowedUserId === undefined) {
      // First non-bot user to message becomes the owner.
      if (from.is_bot) return;
      await deps.config.setSettings({ telegramAllowedUserId: from.id });
      // Answer any pending callback after pairing.
      if (update.callback_query) {
        await deps.api.answerCallbackQuery(update.callback_query.id);
      }
      await deps.api.sendMessage({
        chatId: message.chat.id,
        text: "✅ Telegram bridge paired with this account.\n\nSend any message and I'll respond. Use /stop to clear queued messages.",
      });
      const pairedSettings = await deps.config.getSettings();
      if (pairedSettings.telegramThreadedMode && !botTopicsEnabled) {
        await deps.api.sendMessage({
          chatId: message.chat.id,
          text: "⚠️ Private-chat threads require Threaded Mode to be enabled for this bot in @BotFather. Classic DM routing remains active.",
        });
      } else {
        await deps.ensureThreadTargets?.(message.chat.id).catch((cause) => {
          deps.warn(`Telegram thread provisioning is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
      }
      return;
    }

    // Only the paired owner is authorized.
    if (from.id !== snap.allowedUserId) {
      deps.warn(`Telegram: unauthorized user ${from.id} ignored.`);
      return;
    }

    let binding: TelegramBotBindingSnapshot | undefined;
    try {
      binding = await resolveBinding(message.chat.id, message.message_thread_id, from.id);
    } catch (cause) {
      await rejectBinding(message.chat.id, message.message_thread_id, cause);
      return;
    }

    const settings = await deps.config.getSettings();
    const threadWorkspaceId = message.message_thread_id !== undefined
      ? await deps.resolveThreadWorkspace?.(message.message_thread_id)
      : undefined;
    const selectedWorkspaceId = binding?.workspaceId ?? threadWorkspaceId ?? settings.telegramWorkspaceId;

    if (deps.handleExtensionUpdate) {
      const handled = await deps.handleExtensionUpdate(update, {
        chatId: message.chat.id,
        threadId: message.message_thread_id,
        ownerUserId: from.id,
        workspaceId: selectedWorkspaceId,
      });
      if (handled) return;
    }

    if (update.callback_query) {
      await handleCallback(update.callback_query, binding);
      return;
    }

    const rawText = extractText(message);

    // Control lane: commands are handled immediately (no LLM).
    if (rawText?.startsWith("/")) {
      await handleCommand(rawText.trim(), message, selectedWorkspaceId, threadWorkspaceId !== undefined, binding);
      return;
    }

    if (settings.telegramThreadedMode && message.message_thread_id !== undefined && threadWorkspaceId === undefined && !binding) {
      await deps.api.sendMessage({
        chatId: message.chat.id,
        threadId: message.message_thread_id,
        text: "⚠️ This Telegram thread is not bound to a live Aiden workspace. Re-enable Private-chat threads in Aiden Settings to reconcile targets.",
      });
      return;
    }
    let inbound = await normalizeTelegramInbound(
      {
        api: deps.api,
        transcribeAudio: deps.transcribeAudio,
        storeFile: deps.storeInboundFile
          ? (input) => deps.storeInboundFile!({ ...input, workspaceId: selectedWorkspaceId })
          : undefined,
      },
      message,
    );
    if (deps.transformInbound) {
      inbound = await deps.transformInbound(inbound, message, {
        chatId: message.chat.id,
        threadId: message.message_thread_id,
        ownerUserId: from.id,
        workspaceId: selectedWorkspaceId,
      });
    }
    for (const notice of inbound.notices) {
      await deps.api.sendMessage({ chatId: message.chat.id, threadId: message.message_thread_id, text: `⚠️ ${notice}` });
    }
    if (!inbound.text && inbound.attachments.length === 0) return;

    if (update.edited_message) {
      const existing = queue.list().find(
        (turn) => turn.chatId === message.chat.id &&
          turn.sourceMessageId === message.message_id &&
          sameBinding(turn.binding, binding),
      );
      if (existing?.id !== undefined) {
        queue.replace(existing.id, {
          ...existing,
          text: inbound.text || "Please review the attached file.",
          attachments: inbound.attachments,
        });
        await deps.api.sendMessage({ chatId: message.chat.id, threadId: message.message_thread_id, text: "✏️ Updated the queued prompt." });
      }
      return;
    }

    if (message.media_group_id) {
      const key = `${message.chat.id}:${message.message_thread_id ?? "dm"}:${bindingKey(binding)}:${message.media_group_id}`;
      const pending = mediaGroups.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        const merged: QueuedTelegramTurn = {
          ...pending.turn,
          text: [pending.turn.text, inbound.text].filter(Boolean).join("\n\n"),
          attachments: [...(pending.turn.attachments ?? []), ...inbound.attachments],
        };
        pending.turn = merged;
        pending.timer = scheduleMediaGroup(key);
        return;
      }
      const existing = queue.list().find(
        (turn) => turn.chatId === message.chat.id &&
          turn.sourceMediaGroupId === message.media_group_id &&
          sameBinding(turn.binding, binding),
      );
      if (existing?.id !== undefined) {
        queue.replace(existing.id, {
          ...existing,
          text: [existing.text, inbound.text].filter(Boolean).join("\n\n"),
          attachments: [...(existing.attachments ?? []), ...inbound.attachments],
        });
        return;
      }
      const turn: QueuedTelegramTurn = {
        lane: classifyMessage(inbound.text),
        text: inbound.text || "Please review the attached file.",
        attachments: inbound.attachments,
        chatId: message.chat.id,
        threadId: message.message_thread_id,
        sourceMessageId: message.message_id,
        sourceMediaGroupId: message.media_group_id,
        ownerUserId: from.id,
        fromUsername: from.username,
        workspaceId: threadWorkspaceId ?? settings.telegramWorkspaceId,
        hasVoiceInput: inbound.hasVoiceInput,
        binding,
      };
      mediaGroups.set(key, { turn, timer: scheduleMediaGroup(key) });
      return;
    }

    await enqueuePrompt({
      lane: classifyMessage(inbound.text),
      text: inbound.text || "Please review the attached file.",
      attachments: inbound.attachments,
      chatId: message.chat.id,
      sourceMessageId: message.message_id,
      sourceMediaGroupId: message.media_group_id,
      threadId: message.message_thread_id,
      ownerUserId: from.id,
      fromUsername: from.username,
      hasVoiceInput: inbound.hasVoiceInput,
      binding,
    }, selectedWorkspaceId, true);
  }

  function scheduleMediaGroup(key: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const pending = mediaGroups.get(key);
      if (!pending) return;
      mediaGroups.delete(key);
      queue.enqueue(pending.turn);
      tryDispatch();
    }, deps.mediaGroupDebounceMs ?? MEDIA_GROUP_DEBOUNCE_MS);
  }

  async function handleReaction(reaction: TelegramMessageReactionUpdated): Promise<void> {
    const from = reaction.user;
    if (!from || from.is_bot || reaction.chat.type !== "private") return;
    const snap = await deps.config.snapshot();
    if (snap.allowedUserId === undefined || from.id !== snap.allowedUserId) return;
    let binding: TelegramBotBindingSnapshot | undefined;
    try {
      binding = await resolveBinding(
        reaction.chat.id,
        (reaction as TelegramMessageReactionUpdated & { message_thread_id?: number }).message_thread_id,
        from.id,
      );
    } catch (cause) {
      await rejectBinding(
        reaction.chat.id,
        (reaction as TelegramMessageReactionUpdated & { message_thread_id?: number }).message_thread_id,
        cause,
      );
      return;
    }
    if (deps.handleExtensionUpdate) {
      const settings = await deps.config.getSettings();
      const reactionThreadId = (reaction as TelegramMessageReactionUpdated & { message_thread_id?: number }).message_thread_id;
      const threadWorkspaceId = reactionThreadId === undefined
        ? undefined
        : await deps.resolveThreadWorkspace?.(reactionThreadId);
      const handled = await deps.handleExtensionUpdate({ update_id: 0, message_reaction: reaction }, {
        chatId: reaction.chat.id,
        threadId: reactionThreadId,
        ownerUserId: from.id,
        workspaceId: binding?.workspaceId ?? threadWorkspaceId ?? settings.telegramWorkspaceId,
      });
      if (handled) return;
    }
    const added = reaction.new_reaction
      .map((candidate) => candidate.emoji.replace(/[\uFE0E\uFE0F]/gu, ""))
      .filter((emoji) => !reaction.old_reaction.some(
        (candidate) => candidate.emoji.replace(/[\uFE0E\uFE0F]/gu, "") === emoji,
      ));
    const item = queue.findBySource(
      reaction.chat.id,
      reaction.message_id,
      (reaction as TelegramMessageReactionUpdated & { message_thread_id?: number }).message_thread_id,
      binding,
    );
    if (!item?.id) return;
    if (added.some((emoji) => ["👍", "⚡", "❤", "🕊", "🔥"].includes(emoji))) {
      queue.setPriority(item.id, true);
      await deps.api.sendMessage({ chatId: reaction.chat.id, text: "⚡ Queued prompt promoted." });
    } else if (added.some((emoji) => ["👎", "👻", "💔", "💩", "🗑"].includes(emoji))) {
      queue.remove(item.id);
      await deps.api.sendMessage({ chatId: reaction.chat.id, text: "🗑 Queued prompt removed." });
    }
  }

  /**
   * Capture workspace authority before a prompt joins the queue. A later local
   * Settings or Telegram /workspace change must not retarget an accepted prompt.
   */
  async function enqueuePrompt(
    turn: Omit<QueuedTelegramTurn, "workspaceId">,
    workspaceId?: string,
    workspaceCaptured = false,
  ): Promise<void> {
    const settings = workspaceCaptured ? undefined : await deps.config.getSettings();
    queue.enqueue({ ...turn, workspaceId: workspaceCaptured ? workspaceId : settings?.telegramWorkspaceId });
  }

  async function controlStatus(
    workspaceOverride?: string,
    binding?: TelegramBotBindingSnapshot,
  ): Promise<TelegramControlStatus> {
    const [settings, models, workspaces, extension] = await Promise.all([
      deps.config.getSettings(),
      deps.listModels?.() ?? Promise.resolve([]),
      deps.listWorkspaces(),
      deps.extensionStatus?.() ?? Promise.resolve({ rows: [], sections: [] }),
    ]);
    const providerId = settings.telegramProviderId ?? settings.lastProviderId;
    const model = settings.telegramModel ?? settings.lastModel;
    const choice = models.find(
      (candidate) => candidate.providerId === providerId && candidate.model === model,
    );
    const effectiveWorkspaceId = binding?.workspaceId ?? workspaceOverride ?? settings.telegramWorkspaceId;
    const workspace = workspaces.find((candidate) => candidate.id === effectiveWorkspaceId);
    return {
      botUsername,
      allowedUserId: settings.telegramAllowedUserId,
      providerId,
      providerLabel: choice?.providerLabel,
      model,
      thinkingLevel: settings.telegramThinkingLevel ?? "medium",
      queueCount: queuedCount(binding),
      active: activeTurn && sameBinding(activeInput?.binding, binding),
      workspaceLabel: workspace?.name ?? (effectiveWorkspaceId ? "Unavailable" : "Assistant only"),
      lastError,
      extensionRows: extension.rows,
      extensionSections: extension.sections,
    };
  }

  async function renderControl(
    message: TelegramMessage,
    text: string,
    replyMarkup: TelegramInlineKeyboardMarkup,
    edit = false,
  ): Promise<void> {
    if (edit) {
      await deps.api.editMessageText({
        chatId: message.chat.id,
        messageId: message.message_id,
        text,
        parseMode: "HTML",
        replyMarkup,
      });
      return;
    }
    await deps.api.sendMessage({
      chatId: message.chat.id,
      threadId: message.message_thread_id,
      text,
      parseMode: "HTML",
      replyMarkup,
      disablePreview: true,
    });
  }

  async function openMainMenu(
    message: TelegramMessage,
    edit = false,
    binding?: TelegramBotBindingSnapshot,
  ): Promise<void> {
    const threadWorkspaceId = message.message_thread_id !== undefined
      ? await deps.resolveThreadWorkspace?.(message.message_thread_id)
      : undefined;
    const status = await controlStatus(threadWorkspaceId, binding);
    await renderControl(message, buildStatusText(status), buildMainMenu(status), edit);
  }

  async function openModelMenu(message: TelegramMessage, page = 0, edit = false): Promise<void> {
    const [settings, models] = await Promise.all([
      deps.config.getSettings(),
      deps.listModels?.() ?? Promise.resolve([]),
    ]);
    const menu = buildModelMenu(
      models,
      settings.telegramProviderId ?? settings.lastProviderId,
      settings.telegramModel ?? settings.lastModel,
      page,
    );
    await renderControl(message, menu.text, menu.markup, edit);
  }

  async function openThinkingMenu(message: TelegramMessage, edit = false): Promise<void> {
    const [settings, models] = await Promise.all([
      deps.config.getSettings(),
      deps.listModels?.() ?? Promise.resolve([]),
    ]);
    const providerId = settings.telegramProviderId ?? settings.lastProviderId;
    const model = settings.telegramModel ?? settings.lastModel;
    const active = models.find(
      (candidate) => candidate.providerId === providerId && candidate.model === model,
    );
    const supported = active?.reasoning
      ? active.thinkingLevels?.length
        ? active.thinkingLevels
        : GENERATION_THINKING_LEVELS
      : (["off"] as const);
    const menu = buildThinkingMenu(settings.telegramThinkingLevel ?? "medium", supported);
    await renderControl(message, menu.text, menu.markup, edit);
  }

  async function openWorkspaceMenu(
    message: TelegramMessage,
    edit = false,
    binding?: TelegramBotBindingSnapshot,
  ): Promise<void> {
    const [settings, workspaces] = await Promise.all([
      deps.config.getSettings(),
      deps.listWorkspaces(),
    ]);
    const threadWorkspaceId = binding?.workspaceId ?? (message.message_thread_id !== undefined
      ? await deps.resolveThreadWorkspace?.(message.message_thread_id)
      : undefined);
    if (threadWorkspaceId !== undefined) {
      const workspace = workspaces.find((candidate) => candidate.id === threadWorkspaceId);
      await renderControl(
        message,
        `<b>🗂 ${binding ? "Bot" : "Thread"} workspace</b>\n\nThis ${binding ? "bot binding" : "thread"} is durably routed to ${workspace ? `<b>${escapeHtml(workspace.name)}</b>\n<code>${escapeHtml(workspace.folderPath)}</code>` : "an unavailable workspace"}. Change ${binding ? "the binding from Bots" : "thread targets from Aiden Settings"}.`,
        { inline_keyboard: [[{ text: "⬆️ Main menu", callback_data: "menu:back" }]] },
        edit,
      );
      return;
    }
    const menu = buildWorkspaceMenu(workspaces, settings.telegramWorkspaceId);
    await renderControl(message, menu.text, menu.markup, edit);
  }

  async function openQueueMenu(
    message: TelegramMessage,
    edit = false,
    binding?: TelegramBotBindingSnapshot,
  ): Promise<void> {
    const menu = buildQueueMenu(
      queue.list().filter((turn) => sameBinding(turn.binding, binding)),
    );
    await renderControl(message, menu.text, menu.markup, edit);
  }

  function currentSessionChatId(
    ownerUserId: number,
    workspaceId?: string,
    binding?: TelegramBotBindingSnapshot,
  ): string {
    return binding?.backingChatId ?? telegramChatId(ownerUserId, workspaceId, deps.profile);
  }

  async function abortCurrentTurn(binding?: TelegramBotBindingSnapshot): Promise<boolean> {
    if (!activeTurn || !activeChatId) return false;
    if (!sameBinding(activeInput?.binding, binding)) return false;
    if (!deps.abortChat) return false;
    await deps.abortChat(activeChatId);
    return true;
  }

  function clearQueued(binding?: TelegramBotBindingSnapshot): number {
    let count = 0;
    for (const turn of queue.list()) {
      if (sameBinding(turn.binding, binding) && turn.id !== undefined && queue.remove(turn.id)) count += 1;
    }
    for (const [key, group] of mediaGroups) {
      if (!sameBinding(group.turn.binding, binding)) continue;
      clearTimeout(group.timer);
      mediaGroups.delete(key);
      count += 1;
    }
    return count;
  }

  function queuedCount(binding?: TelegramBotBindingSnapshot): number {
    let count = queue.list().filter((turn) => sameBinding(turn.binding, binding)).length;
    for (const group of mediaGroups.values()) {
      if (sameBinding(group.turn.binding, binding)) count += 1;
    }
    return count;
  }

  async function handleCallback(
    callback: TelegramCallbackQuery,
    binding?: TelegramBotBindingSnapshot,
  ): Promise<void> {
    const message = callback.message;
    const data = callback.data ?? "";
    if (!message) {
      await deps.api.answerCallbackQuery(callback.id, "This control is no longer available.");
      return;
    }
    try {
      if (data.startsWith("tgbtn:")) {
        const action = buttonStore.resolve(data);
        if (!action) {
          await deps.api.answerCallbackQuery(callback.id, "This action has expired.");
          return;
        }
        const settings = await deps.config.getSettings();
        const threadWorkspaceId = message.message_thread_id !== undefined
          ? await deps.resolveThreadWorkspace?.(message.message_thread_id)
          : undefined;
        await enqueuePrompt({
          lane: "priority",
          text: action.prompt,
          chatId: message.chat.id,
          threadId: message.message_thread_id,
          ownerUserId: callback.from.id,
          fromUsername: callback.from.username,
          binding,
        }, threadWorkspaceId ?? settings.telegramWorkspaceId, true);
        const selectedMarkup = callback.message?.reply_markup
          ? markTelegramButtonSelected(
              callback.message.reply_markup,
              data,
              action.selectedStyle,
            )
          : undefined;
        if (selectedMarkup) {
          await deps.api.editMessageReplyMarkup({
            chatId: message.chat.id,
            messageId: message.message_id,
            replyMarkup: selectedMarkup,
          });
        }
        await deps.api.answerCallbackQuery(callback.id, action.label);
        return;
      }
      if (data === "noop") {
        await deps.api.answerCallbackQuery(callback.id);
        return;
      }
      if (data === "menu:back") await openMainMenu(message, true, binding);
      else if (data === "menu:model") await openModelMenu(message, 0, true);
      else if (data === "menu:thinking") await openThinkingMenu(message, true);
      else if (data === "menu:queue") await openQueueMenu(message, true, binding);
      else if (data === "menu:workspace") await openWorkspaceMenu(message, true, binding);
      else if (data === "menu:settings") {
        const settings = await deps.config.getSettings();
        const menu = buildSettingsMenu({
          draftPreviews: settings.telegramDraftPreviews,
          activity: settings.telegramActivity,
          rendering: settings.telegramRendering,
          voiceMode: settings.telegramVoiceMode,
        });
        await renderControl(message, menu.text, menu.markup, true);
      } else if (data === "settings:drafts:toggle") {
        const settings = await deps.config.getSettings();
        const updated = await deps.config.setSettings({
          telegramDraftPreviews: !(settings.telegramDraftPreviews ?? false),
        });
        const menu = buildSettingsMenu({
          draftPreviews: updated.telegramDraftPreviews,
          activity: updated.telegramActivity,
          rendering: updated.telegramRendering,
          voiceMode: updated.telegramVoiceMode,
        });
        await renderControl(message, menu.text, menu.markup, true);
      } else if (data === "settings:activity:next") {
        const settings = await deps.config.getSettings();
        const levels = ["quiet", "thinking", "tools", "verbose"] as const;
        const current = levels.indexOf(settings.telegramActivity ?? "quiet");
        const updated = await deps.config.setSettings({
          telegramActivity: levels[(current + 1) % levels.length],
        });
        const menu = buildSettingsMenu({
          draftPreviews: updated.telegramDraftPreviews,
          activity: updated.telegramActivity,
          rendering: updated.telegramRendering,
          voiceMode: updated.telegramVoiceMode,
        });
        await renderControl(message, menu.text, menu.markup, true);
      } else if (data === "settings:rendering:toggle") {
        const settings = await deps.config.getSettings();
        const updated = await deps.config.setSettings({
          telegramRendering: settings.telegramRendering === "html" ? "rich" : "html",
        });
        const menu = buildSettingsMenu({
          draftPreviews: updated.telegramDraftPreviews,
          activity: updated.telegramActivity,
          rendering: updated.telegramRendering,
          voiceMode: updated.telegramVoiceMode,
        });
        await renderControl(message, menu.text, menu.markup, true);
      } else if (data === "settings:voice:next") {
        const settings = await deps.config.getSettings();
        const modes = ["hidden", "mirror", "always"] as const;
        const current = modes.indexOf(settings.telegramVoiceMode ?? "hidden");
        const updated = await deps.config.setSettings({
          telegramVoiceMode: modes[(current + 1) % modes.length],
        });
        const menu = buildSettingsMenu({
          draftPreviews: updated.telegramDraftPreviews,
          activity: updated.telegramActivity,
          rendering: updated.telegramRendering,
          voiceMode: updated.telegramVoiceMode,
        });
        await renderControl(message, menu.text, menu.markup, true);
      } else if (/^model:page:\d+$/u.test(data)) {
        await openModelMenu(message, Number(data.slice("model:page:".length)), true);
      } else if (/^model:set:\d+$/u.test(data)) {
        const models = await deps.listModels?.() ?? [];
        const choice = models[Number(data.slice("model:set:".length))];
        if (!choice) throw new Error("That model is no longer available.");
        if (activeTurn && !deps.abortChat) {
          throw new Error("Wait for the active turn to finish or abort it before switching models.");
        }
        await (deps.applyModelSelection?.(choice) ?? deps.config.setSettings({
          telegramProviderId: choice.providerId,
          telegramModel: choice.model,
          lastProviderId: choice.providerId,
          lastModel: choice.model,
          telegramThinkingLevel: choice.reasoning ? undefined : "off",
        }).then(() => undefined));
        if (activeTurn && activeInput && sameBinding(activeInput.binding, binding)) {
          queue.enqueue({
            ...activeInput,
            id: undefined,
            lane: "priority",
            text: `Continue the interrupted task using ${choice.providerLabel}/${choice.model}. Preserve the existing conversation context and do not repeat completed work.`,
            sourceMessageId: undefined,
            sourceMediaGroupId: undefined,
            attachments: undefined,
          });
          await abortCurrentTurn(binding);
        }
        await openMainMenu(message, true, binding);
      } else if (data.startsWith("thinking:set:")) {
        const level = data.slice("thinking:set:".length);
        if (!GENERATION_THINKING_LEVELS.includes(level as never)) {
          throw new Error("Unknown thinking level.");
        }
        await deps.config.setSettings({ telegramThinkingLevel: level as typeof GENERATION_THINKING_LEVELS[number] });
        await openMainMenu(message, true, binding);
      } else if (data.startsWith("workspace:set:")) {
        if (binding) throw new Error("This bot's workspace is fixed. Rebind it from Bots to change workspace.");
        if (message.message_thread_id !== undefined && await deps.resolveThreadWorkspace?.(message.message_thread_id) !== undefined) {
          throw new Error("Thread workspace routing is fixed. Change thread targets from Aiden Settings.");
        }
        const selection = data.slice("workspace:set:".length);
        const workspaces = await deps.listWorkspaces();
        const workspace = selection === "off" ? undefined : workspaces[Number(selection)];
        if (selection !== "off" && !workspace) throw new Error("That workspace is unavailable.");
        const cleared = clearQueued(binding);
        await deps.config.setSettings({ telegramWorkspaceId: workspace?.id });
        await openMainMenu(message, true, binding);
        if (cleared > 0) {
          await deps.api.sendMessage({ chatId: message.chat.id, threadId: message.message_thread_id, text: `Cleared ${cleared} queued prompt(s) because the workspace changed.` });
        }
      } else if (/^queue:item:\d+$/u.test(data)) {
        const item = queue.find(Number(data.slice("queue:item:".length)));
        if (!item || !sameBinding(item.binding, binding)) {
          return void (await openQueueMenu(message, true, binding));
        }
        const menu = buildQueueItemMenu(item);
        await renderControl(message, menu.text, menu.markup, true);
      } else if (/^queue:priority:\d+$/u.test(data)) {
        const id = Number(data.slice("queue:priority:".length));
        const item = queue.find(id);
        if (!item || !sameBinding(item.binding, binding)) {
          return void (await openQueueMenu(message, true, binding));
        }
        queue.setPriority(id, item.lane !== "priority");
        const updated = queue.find(id);
        if (updated) {
          const menu = buildQueueItemMenu(updated);
          await renderControl(message, menu.text, menu.markup, true);
        }
      } else if (/^queue:delete:\d+$/u.test(data)) {
        const item = queue.find(Number(data.slice("queue:delete:".length)));
        if (item && sameBinding(item.binding, binding) && item.id !== undefined) {
          queue.remove(item.id);
        }
        await openQueueMenu(message, true, binding);
      } else if (data === "queue:clear:ask") {
        const menu = confirmationMenu("Clear every queued prompt?", "queue:clear:yes");
        await renderControl(message, menu.text, menu.markup, true);
      } else if (data === "queue:clear:yes") {
        clearQueued(binding);
        await openQueueMenu(message, true, binding);
      } else if (data === "compact:ask") {
        const menu = confirmationMenu("Compact the current Aiden session?", "compact:yes");
        await renderControl(message, menu.text, menu.markup, true);
      } else if (data === "compact:yes") {
        if (activeTurn) throw new Error("Wait for the active turn to finish or abort it first.");
        const settings = await deps.config.getSettings();
        const threadWorkspaceId = message.message_thread_id !== undefined
          ? await deps.resolveThreadWorkspace?.(message.message_thread_id)
          : undefined;
        if (!deps.compactChat) throw new Error("Manual compaction is unavailable in this runtime.");
        const result = await deps.compactChat(
          currentSessionChatId(
            callback.from.id,
            threadWorkspaceId ?? settings.telegramWorkspaceId,
            binding,
          ),
        );
        await deps.api.sendMessage({
          chatId: message.chat.id,
          text: result.compacted
            ? `🗜 Session compacted${result.tokensBefore ? ` from about ${result.tokensBefore.toLocaleString()} tokens` : ""}.`
            : `⚠️ ${result.error ?? "Compaction did not run."}`,
        });
        await openMainMenu(message, true, binding);
      } else if (data === "turn:abort") {
        const aborted = await abortCurrentTurn(binding);
        await deps.api.sendMessage({ chatId: message.chat.id, threadId: message.message_thread_id, text: aborted ? "⏹ Active turn aborted." : "No turn is active." });
        await openMainMenu(message, true, binding);
      } else if (data === "turn:next") {
        const aborted = await abortCurrentTurn(binding);
        await deps.api.sendMessage({ chatId: message.chat.id, threadId: message.message_thread_id, text: aborted ? "⏭ Moving to the next queued prompt." : "No turn is active." });
      } else if (data === "turn:stop") {
        const cleared = clearQueued(binding);
        const aborted = await abortCurrentTurn(binding);
        await deps.api.sendMessage({ chatId: message.chat.id, threadId: message.message_thread_id, text: `🛑 ${aborted ? "Active turn aborted. " : ""}Cleared ${cleared} queued prompt(s).` });
        await openMainMenu(message, true, binding);
      } else if (data.startsWith("ext:") && deps.handleExtensionCallback) {
        const settings = await deps.config.getSettings();
        const threadWorkspaceId = message.message_thread_id !== undefined
          ? await deps.resolveThreadWorkspace?.(message.message_thread_id)
          : undefined;
        const reply = await deps.handleExtensionCallback(data, {
          chatId: message.chat.id,
          threadId: message.message_thread_id,
          ownerUserId: callback.from.id,
          workspaceId: binding?.workspaceId ?? threadWorkspaceId ?? settings.telegramWorkspaceId,
        });
        if (reply) await deps.api.sendMessage({ chatId: message.chat.id, threadId: message.message_thread_id, text: reply });
      } else {
        await deps.api.answerCallbackQuery(callback.id, "This control is no longer available.");
        return;
      }
      await deps.api.answerCallbackQuery(callback.id);
    } catch (cause) {
      const messageText = cause instanceof Error ? cause.message : String(cause);
      await deps.api.answerCallbackQuery(callback.id, messageText.slice(0, 180)).catch(() => undefined);
      await deps.api.sendMessage({ chatId: message.chat.id, threadId: message.message_thread_id, text: `⚠️ ${messageText}` }).catch(() => undefined);
    }
  }

  async function handleCommand(
    command: string,
    message: TelegramMessage,
    effectiveWorkspaceId?: string,
    managedThread = false,
    binding?: TelegramBotBindingSnapshot,
  ): Promise<void> {
    const cmd = commandName(command);
    const chatId = message.chat.id;

    if (cmd === "/start") {
      await openMainMenu(message, false, binding);
      return;
    }

    if (cmd === "/help") {
      await deps.api.sendMessage({ chatId, threadId: message.message_thread_id, text: TELEGRAM_HELP_TEXT });
      return;
    }

    if (cmd === "/status") {
      await openMainMenu(message, false, binding);
      return;
    }

    if (cmd === "/model") {
      await openModelMenu(message);
      return;
    }

    if (cmd === "/thinking") {
      await openThinkingMenu(message);
      return;
    }

    if (cmd === "/queue") {
      await openQueueMenu(message, false, binding);
      return;
    }

    if (cmd === "/settings") {
      const settings = await deps.config.getSettings();
      const menu = buildSettingsMenu({
        draftPreviews: settings.telegramDraftPreviews,
        activity: settings.telegramActivity,
        rendering: settings.telegramRendering,
        voiceMode: settings.telegramVoiceMode,
      });
      await renderControl(message, menu.text, menu.markup);
      return;
    }

    if (cmd === "/compact") {
      const menu = confirmationMenu("Compact the current Aiden session?", "compact:yes");
      await renderControl(message, menu.text, menu.markup);
      return;
    }

    if (cmd === "/continue") {
      await enqueuePrompt({
        lane: "priority",
        text: commandArgument(command) || "Continue.",
        chatId,
        threadId: message.message_thread_id,
        ownerUserId: message.from?.id ?? chatId,
        fromUsername: message.from?.username,
        binding,
      }, effectiveWorkspaceId, true);
      await deps.api.sendMessage({ chatId, threadId: message.message_thread_id, text: "▶️ Continuation queued." });
      return;
    }

    if (cmd === "/workspace") {
      if (binding) {
        await openWorkspaceMenu(message, false, binding);
        return;
      }
      if (managedThread) {
        await openWorkspaceMenu(message);
        return;
      }
      const workspaces = await deps.listWorkspaces();
      const selection = commandArgument(command);
      if (!selection) {
        await openWorkspaceMenu(message);
        return;
      }

      if (selection.toLowerCase() === "off") {
        const hadQueued = clearQueued(binding);
        await deps.config.setSettings({ telegramWorkspaceId: undefined });
        await deps.api.sendMessage({
          chatId,
          threadId: message.message_thread_id,
          text: [
            "Telegram workspace cleared. Future turns will run in assistant-only mode.",
            ...(hadQueued > 0 ? [`Cleared ${hadQueued} queued message(s).`] : []),
          ].join("\n"),
        });
        return;
      }

      const position = /^\d+$/u.test(selection) ? Number(selection) - 1 : -1;
      const matches = workspaces.filter(
        (workspace) => workspace.id === selection || workspace.name === selection,
      );
      const workspace =
        position >= 0 ? workspaces[position] : matches.length === 1 ? matches[0] : undefined;
      if (!workspace) {
        await deps.api.sendMessage({
          chatId,
          threadId: message.message_thread_id,
          text:
            matches.length > 1
              ? `More than one workspace is named "${selection}". Choose by number from /workspace.`
              : `Workspace "${selection}" was not found. Run /workspace to see configured folders.`,
        });
        return;
      }

      const hadQueued = clearQueued(binding);
      await deps.config.setSettings({ telegramWorkspaceId: workspace.id });
      await deps.api.sendMessage({
        chatId,
        threadId: message.message_thread_id,
        text: [
          `Telegram workspace set to ${workspace.name}. Future turns will run in ${workspace.folderPath}.`,
          ...(hadQueued > 0 ? [`Cleared ${hadQueued} queued message(s).`] : []),
        ].join("\n"),
      });
      return;
    }
    if (cmd === "/abort" || cmd === "/cancel") {
      const aborted = await abortCurrentTurn(binding);
      await deps.api.sendMessage({
        chatId,
        threadId: message.message_thread_id,
        text: aborted ? "⏹ Active turn aborted. The queue is preserved." : "No turn is active.",
      });
      return;
    }

    if (cmd === "/next") {
      const aborted = await abortCurrentTurn(binding);
      await deps.api.sendMessage({
        chatId,
        threadId: message.message_thread_id,
        text: aborted
          ? "⏭ Active turn aborted. The next queued prompt will run."
          : queuedCount(binding)
            ? "⏭ The next queued prompt will run."
            : "No active turn or queued prompt.",
      });
      tryDispatch();
      return;
    }

    if (cmd === "/stop") {
      const hadQueued = clearQueued(binding);
      const aborted = await abortCurrentTurn(binding);
      const lines = [
        hadQueued > 0 ? `🧹 Cleared ${hadQueued} queued message(s).` : "No messages were queued.",
      ];
      if (aborted) lines.push("The active turn was aborted.");
      await deps.api.sendMessage({ chatId, threadId: message.message_thread_id, text: lines.join("\n") });
      return;
    }

    const templates = await deps.listPromptCommands?.(effectiveWorkspaceId) ?? [];
    const template = templates.find((candidate) => `/${candidate.command}` === cmd);
    if (template) {
      if (template.handle) {
        const reply = await template.handle(commandArgument(command), message, {
          chatId,
          threadId: message.message_thread_id,
          ownerUserId: message.from?.id ?? chatId,
          workspaceId: effectiveWorkspaceId,
        });
        if (reply) await deps.api.sendMessage({ chatId, threadId: message.message_thread_id, text: reply });
        return;
      }
      if (!template.expand) throw new Error(`Telegram command /${template.command} has no handler.`);
      await enqueuePrompt({
        lane: "default",
        text: template.expand(commandArgument(command)),
        chatId,
        threadId: message.message_thread_id,
        ownerUserId: message.from?.id ?? chatId,
        fromUsername: message.from?.username,
        binding,
      }, effectiveWorkspaceId, true);
      return;
    }

    await deps.api.sendMessage({
      chatId,
      threadId: message.message_thread_id,
      text: `Unknown command ${cmd}. Use /start for controls or /help for the command list.`,
    });
  }

  /** Attempt to dispatch the next queued turn. No-op if gates block. */
  function tryDispatch(): void {
    if (!started || activeTurn || dispatchPending) return;
    const next = queue.dequeue();
    if (!next) return;
    void dispatchTurn(next);
  }

  async function dispatchTurn(turn: QueuedTelegramTurn): Promise<void> {
    dispatchPending = true;
    try {
      if (turn.binding) {
        const validation = await deps.validateBotBinding?.(turn.binding);
        if (validation === false) throw new Error("This Telegram bot is unavailable or archived.");
        if (typeof validation === "string") throw new Error(validation);
        if (validation && typeof validation === "object" && !validation.valid) {
          throw new Error(validation.reason ?? "This Telegram bot is unavailable or archived.");
        }
      }
      // A bound Telegram conversation is created with a durable workspace by
      // the Bots binding flow. Read that authoritative metadata at dispatch so
      // a later profile-level /workspace change cannot retarget the bot chat.
      const backingChat = turn.binding
        ? await deps.turn.chatStore.get(turn.binding.backingChatId)
        : undefined;
      if (turn.binding && (
        !backingChat ||
        backingChat.botId !== turn.binding.botId ||
        backingChat.workspaceId !== turn.binding.workspaceId
      )) {
        throw new Error("This bot's Telegram conversation no longer matches its binding.");
      }
      const workspace = await deps.turn.resolveWorkspace(
        turn.binding?.workspaceId ?? turn.workspaceId,
      );
      const workspaceId = workspace.kind === "project" ? workspace.workspaceId : undefined;
      const chatId = turn.binding?.backingChatId ?? telegramChatId(
        turn.ownerUserId,
        workspaceId,
        deps.profile,
      );

      if (workspace.kind !== "stale") {
        try {
          const settings = await deps.config.getSettings();
          await ensureTelegramChat(
            deps.turn,
            turn.ownerUserId,
            `Telegram${turn.fromUsername ? ` (@${turn.fromUsername})` : ""}`,
            settings.lastProviderId,
            settings.lastModel,
            workspaceId,
            deps.profile,
            turn.binding,
          );
        } catch (cause) {
          deps.error("Telegram: failed to ensure chat for turn.", cause);
          // A bot route must never fall through to append/generate against an
          // unverified or mismatched backing chat. Legacy unbound Telegram
          // keeps its historical best-effort behavior.
          if (turn.binding) throw cause;
        }
      }

      activeTurn = true;
      activeChatId = chatId;
      activeInput = turn;
      dispatchPending = false;

      const settings = await deps.config.getSettings();
      const automaticVoice = (settings.telegramVoiceMode === "always") ||
        (settings.telegramVoiceMode === "mirror" && (turn.hasVoiceInput ?? false));
      const activity = createTelegramActivityProjector({
        api: deps.api,
        chatId: turn.chatId,
        draftPreviews: (settings.telegramDraftPreviews ?? false) && !automaticVoice,
        verbosity: settings.telegramActivity ?? "quiet",
        rendering: settings.telegramRendering ?? "rich",
        threadId: turn.threadId,
        now: deps.now,
      });

      // Start typing indicator AFTER activeTurn is set so the loop condition
      // evaluates true on its first iteration.
      void sendTypingIndicator(turn.chatId, turn.threadId).catch(() => undefined);

      const result: TelegramTurnResult = await sendTelegramTurn(
        deps.turn,
        chatId,
        turn.text,
        workspace,
        turn.attachments,
        activity.observe,
        { binding: turn.binding },
      );
      await activity.settle();
      await deliverReply(
        turn.chatId,
        result,
        activity.draftMessageId,
        turn.binding?.workspaceId ?? turn.workspaceId,
        turn.threadId,
        settings.telegramRendering ?? "rich",
        turn.ownerUserId,
        turn.hasVoiceInput ?? false,
        settings.telegramVoiceMode ?? "hidden",
      );
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      deps.error("Telegram turn failed.", cause);
      await deps.api
        .sendMessage({ chatId: turn.chatId, threadId: turn.threadId, text: `⚠️ Error: ${msg}` })
        .catch(() => undefined);
    } finally {
      activeTurn = false;
      activeChatId = undefined;
      activeInput = undefined;
      dispatchPending = false;
      tryDispatch();
    }
  }

  async function resetPairing(): Promise<void> {
    queue.clear();
    clearMediaGroups();
    await abortCurrentTurn().catch((cause) => {
      deps.warn(`Telegram active turn could not be aborted during pairing reset: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    await deps.clearThreadTargets?.();
    await deps.config.setSettings({ telegramAllowedUserId: undefined });
  }

  async function ensureThreads(): Promise<void> {
    const settings = await deps.config.getSettings();
    if (!settings.telegramThreadedMode) return;
    if (botTopicsEnabled === undefined) {
      const me = await deps.api.getMe();
      botTopicsEnabled = me.has_topics_enabled === true;
    }
    if (!botTopicsEnabled) {
      throw new Error("Enable Threaded Mode for this bot in @BotFather before turning on private-chat threads.");
    }
    if (settings.telegramAllowedUserId !== undefined) {
      await deps.ensureThreadTargets?.(settings.telegramAllowedUserId);
    }
  }

  async function clearThreads(): Promise<void> {
    await deps.clearThreadTargets?.();
  }

  async function deliverReply(
    chatId: number,
    result: TelegramTurnResult,
    draftMessageId?: number,
    workspaceId?: string,
    threadId?: number,
    rendering: "rich" | "html" = "rich",
    ownerUserId: number = chatId,
    hasVoiceInput = false,
    voiceMode: "hidden" | "mirror" | "always" = "hidden",
  ): Promise<void> {
    if (!result.ok) {
      if (result.error) {
        await deps.api.sendMessage({ chatId, threadId, text: `⚠️ ${result.error}` }).catch(() => undefined);
      }
      return;
    }

    const outboundContext = { chatId, threadId, ownerUserId, workspaceId };
    const outbound = deps.transformOutbound
      ? await deps.transformOutbound(result.content, outboundContext)
      : result.content;
    const plan = planTelegramReply(outbound, (action) => buttonStore.register(action));
    const automaticVoice = Boolean(plan.markdown) && plan.voices.length === 0 &&
      (voiceMode === "always" || (voiceMode === "mirror" && hasVoiceInput));
    const automaticVoiceDelivered = automaticVoice
      ? await deliverVoiceRequests(chatId, threadId, workspaceId, ownerUserId, [{ text: plan.markdown }], false)
      : false;
    let deliveredText = false;
    if (!automaticVoiceDelivered && rendering === "rich" && plan.markdown) {
      const richChunks = chunkRichMarkdown(plan.markdown);
      for (let index = 0; index < richChunks.length; index += 1) {
        try {
          await deps.api.sendRichMessage({
            chatId,
            threadId,
            markdown: richChunks[index]!,
            ...(index === richChunks.length - 1 && plan.replyMarkup ? { replyMarkup: plan.replyMarkup } : {}),
          });
          deliveredText = true;
        } catch (cause) {
          if (!(cause instanceof TelegramApiError) || cause.code !== 400) throw cause;
          deps.warn(`Telegram Rich Markdown chunk ${index + 1} was rejected; falling back to HTML: ${cause.message}`);
          await deliverHtmlReply(
            chatId,
            threadId,
            richChunks.slice(index).join("\n\n"),
            index === 0 ? draftMessageId : undefined,
            plan.replyMarkup,
          );
          deliveredText = true;
          break;
        }
      }
    } else if (!automaticVoiceDelivered && plan.markdown) {
      await deliverHtmlReply(chatId, threadId, plan.markdown, draftMessageId, plan.replyMarkup);
      deliveredText = true;
    }
    if (!deliveredText && plan.replyMarkup) {
      await deps.api.sendMessage({ chatId, threadId, text: "Choose an option:", replyMarkup: plan.replyMarkup });
    }
    await deliverAttachments(chatId, workspaceId, plan.attachments, threadId);
    if (plan.voices.length > 0) {
      await deliverVoiceRequests(chatId, threadId, workspaceId, ownerUserId, plan.voices, true);
    }
  }

  async function deliverHtmlReply(
    chatId: number,
    threadId: number | undefined,
    markdown: string,
    draftMessageId: number | undefined,
    replyMarkup: TelegramInlineKeyboardMarkup | undefined,
  ): Promise<void> {
    const chunks = chunkForTelegram(markdownToTelegramHtml(markdown));
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      if (index === 0 && draftMessageId !== undefined) {
        await deps.api.editMessageText({
          chatId,
          messageId: draftMessageId,
          text: chunk,
          parseMode: "HTML",
          disablePreview: true,
          ...(index === chunks.length - 1 && replyMarkup ? { replyMarkup } : {}),
        });
      } else {
        await deps.api.sendMessage({
          chatId,
          threadId,
          text: chunk,
          parseMode: "HTML",
          ...(index === chunks.length - 1 && replyMarkup ? { replyMarkup } : {}),
          disablePreview: true,
        });
      }
    }
  }

  async function deliverVoiceRequests(
    chatId: number,
    threadId: number | undefined,
    workspaceId: string | undefined,
    ownerUserId: number,
    requests: readonly { text: string; lang?: string; rate?: string }[],
    explicit: boolean,
  ): Promise<boolean> {
    if (requests.length === 0) return false;
    if (!deps.synthesizeVoice) {
      if (explicit) await deps.api.sendMessage({ chatId, threadId, text: "⚠️ No Telegram voice synthesis provider is registered." });
      return false;
    }
    let delivered = false;
    for (const request of requests) {
      try {
        const voice = await deps.synthesizeVoice(request.text, {
          lang: request.lang,
          rate: request.rate,
          chatId,
          threadId,
          ownerUserId,
          workspaceId,
        });
        if (!voice) {
          if (explicit) await deps.api.sendMessage({ chatId, threadId, text: "⚠️ Telegram voice synthesis was unavailable." });
          continue;
        }
        await deps.api.sendVoice({
          chatId,
          threadId,
          bytes: voice.bytes,
          name: voice.name,
          mimeType: voice.mimeType,
          caption: voice.caption,
        });
        delivered = true;
      } catch (cause) {
        deps.warn(`Telegram voice delivery failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        if (explicit) await deps.api.sendMessage({ chatId, threadId, text: "⚠️ Telegram voice synthesis failed." });
      }
    }
    return delivered;
  }

  async function deliverAttachments(
    chatId: number,
    workspaceId: string | undefined,
    attachments: readonly { path: string; caption?: string }[],
    threadId?: number,
  ): Promise<void> {
    for (const attachment of attachments) {
      if (!deps.readOutboundAttachment) {
        await deps.api.sendMessage({ chatId, threadId, text: "⚠️ Outbound file delivery is unavailable." });
        continue;
      }
      try {
        const file = await deps.readOutboundAttachment(workspaceId, attachment.path);
        await deps.api.sendDocument({
          chatId,
          threadId,
          bytes: file.bytes,
          name: file.name,
          mimeType: file.mimeType,
          caption: attachment.caption,
        });
      } catch (cause) {
        await deps.api.sendMessage({
          chatId,
          threadId,
          text: `⚠️ Could not attach ${attachment.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }
  }

  let typingActive = false;
  async function sendTypingIndicator(chatId: number, threadId?: number): Promise<void> {
    if (typingActive) return;
    typingActive = true;
    try {
      while (activeTurn && started) {
        await deps.api.sendChatAction(chatId, "typing", threadId).catch(() => undefined);
        await deps.sleep(TYPING_INTERVAL_MS).catch(() => undefined);
      }
    } finally {
      typingActive = false;
    }
  }

  return {
    start,
    stop,
    stopAndSettle,
    connect,
    disconnect,
    resetPairing,
    ensureThreads,
    clearThreads,
    getStatus,
    get queueSize() {
      return queue.size();
    },
    get isActive() {
      return activeTurn;
    },
  };
}
