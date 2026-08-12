// Telegram service core — the polling orchestrator that ties together
// inbound handling, owner pairing, queue dispatch, and outbound reply delivery.
//
// This is the pure factory that schedule-service-core.ts / schedule-service.ts
// models: start() / stop() / stopAndSettle(), idempotent lifecycle, DI for tests.
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT).

import type { TelegramBotApi, TelegramUpdate, TelegramMessage } from "./telegram-bot-api.js";
import type { TelegramConfig } from "./telegram-config.js";
import type { TelegramTurnDeps, TelegramTurnResult } from "./telegram-turn.js";
import {
  sendTelegramTurn,
  ensureTelegramChat,
  telegramChatId,
} from "./telegram-turn.js";
import {
  createTelegramQueue,
  classifyMessage,
  type TelegramQueue,
  type QueuedTelegramTurn,
} from "./telegram-queue.js";
import { markdownToTelegramHtml, chunkForTelegram } from "./telegram-markdown.js";

const POLL_TIMEOUT_SECONDS = 30;
const ERROR_SLEEP_MS = 3_000;
const TYPING_INTERVAL_MS = 2_500;

/** Extract text content from a Telegram message (text or caption). */
function extractText(message: TelegramMessage): string | undefined {
  return message.text ?? message.caption;
}

export type TelegramServiceStatus =
  | "disabled"
  | "idle"
  | "polling"
  | "error";

export interface TelegramServiceState {
  status: TelegramServiceStatus;
  botUsername?: string;
  lastError?: string;
  queuedCount: number;
}

export interface TelegramServiceDeps {
  api: TelegramBotApi;
  config: TelegramConfig;
  turn: TelegramTurnDeps;
  getToken(): Promise<string | null>;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  warn(message: string): void;
  error(message: string, cause?: unknown): void;
  info(message: string): void;
}

export function createTelegramServiceCore(deps: TelegramServiceDeps) {
  const queue: TelegramQueue = createTelegramQueue({
    isActive: () => activeTurn,
    hasPendingDispatch: () => dispatchPending,
  });

  let started = false;
  let abortController: AbortController | undefined;
  let activeTurn = false;
  let dispatchPending = false;
  let botUsername: string | undefined;
  let lastError: string | undefined;

  function getStatus(): TelegramServiceState {
    return {
      status: started ? (lastError ? "error" : "polling") : "disabled",
      botUsername,
      lastError,
      queuedCount: queue.size(),
    };
  }

  async function start(): Promise<void> {
    if (started) return;
    const snap = await deps.config.snapshot();
    if (!snap.enabled || !snap.hasToken) return;
    started = true;
    lastError = undefined;
    abortController = new AbortController();
    void runPollLoop(abortController.signal);
    deps.info("Telegram bridge started.");
  }

  function stop(): void {
    started = false;
    abortController?.abort();
    abortController = undefined;
    queue.clear();
    // Do NOT reset activeTurn/dispatchPending here — the in-flight
    // dispatchTurn's finally block owns those. Resetting mid-turn
    // would allow a concurrent dispatch on the same chat.
  }

  async function stopAndSettle(): Promise<void> {
    stop();
    // The abort signal cancels polling; active LLM turns settle on their own.
  }

  /** Force-start after enablement/token changes (bypasses the enabled gate). */
  async function connect(): Promise<void> {
    const snap = await deps.config.snapshot();
    if (!snap.hasToken) throw new Error("Cannot connect without a bot token.");
    if (started) return;
    started = true;
    lastError = undefined;
    abortController = new AbortController();
    void runPollLoop(abortController.signal);
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
      deps.info(`Telegram bot connected as @${me.username}.`);
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
      deps.error("Telegram getMe failed.", cause);
      started = false;
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
          deps.error(
            `Telegram handleUpdate failed for ${update.update_id}.`,
            cause,
          );
        }
        // Persist the resume offset (update_id + 1) ONLY after successful
        // handling. On failure the update will be retried on the next poll.
        // Monotonic max is enforced inside persistOffset.
        if (handled) {
          offset = update.update_id + 1;
          await deps.config.persistOffset(update.update_id + 1);
        }
      }

      tryDispatch();
    }
  }

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message ?? update.callback_query?.message;
    const from = update.message?.from ?? update.callback_query?.from;
    if (!message || !from) return;

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
      return;
    }

    // Only the paired owner is authorized.
    if (from.id !== snap.allowedUserId) {
      deps.warn(`Telegram: unauthorized user ${from.id} ignored.`);
      return;
    }

    // Answer callback queries after the authorization gate.
    if (update.callback_query) {
      await deps.api.answerCallbackQuery(update.callback_query.id);
    }

    const text = extractText(message);
    if (!text) return;

    // Control lane: commands are handled immediately (no LLM).
    if (text.startsWith("/")) {
      await handleCommand(text.trim(), message);
      return;
    }

    // Enqueue the prompt.
    queue.enqueue({
      lane: classifyMessage(text),
      text,
      chatId: message.chat.id,
      ownerUserId: from.id,
      fromUsername: from.username,
    });

    tryDispatch();
  }

  async function handleCommand(command: string, message: TelegramMessage): Promise<void> {
    const cmd = command.split(/\s+/)[0]?.toLowerCase() ?? "";
    const chatId = message.chat.id;

    if (cmd === "/start") {
      await deps.api.sendMessage({
        chatId,
        text: "🤖 Aiden Telegram Bridge\n\nSend any message and I'll respond as Aiden.\n\nCommands:\n/start — show this help\n/stop — clear queued messages\n/status — show bridge status",
      });
      return;
    }

    if (cmd === "/stop" || cmd === "/cancel") {
      const hadQueued = queue.size();
      queue.clear();
      const lines = [hadQueued > 0 ? `🧹 Cleared ${hadQueued} queued message(s).` : "No messages were queued."];
      if (activeTurn) {
        lines.push("The current turn is still running — it will finish on its own.");
      }
      await deps.api.sendMessage({ chatId, text: lines.join("\n") });
      return;
    }

    if (cmd === "/status") {
      const snap = await deps.config.snapshot();
      const lines = [
        `Bot: @${botUsername ?? "unknown"}`,
        `Paired owner: ${snap.allowedUserId ?? "none"}`,
        `Queue: ${queue.size()} pending`,
        `Active turn: ${activeTurn ? "yes" : "no"}`,
      ];
      if (lastError) lines.push(`Last error: ${lastError}`);
      await deps.api.sendMessage({ chatId, text: lines.join("\n") });
      return;
    }

    // Unknown command — treat as a prompt.
    queue.enqueue({
      lane: "default",
      text: command,
      chatId,
      ownerUserId: message.from?.id ?? chatId,
      fromUsername: message.from?.username,
    });
    tryDispatch();
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

    // Ensure the persistent chat exists. The Aiden chat key is derived from
    // the owner's Telegram user ID; the Telegram chat ID is used for API calls.
    const chatId = telegramChatId(turn.ownerUserId);
    try {
      const settings = await deps.config.getSettings();
      await ensureTelegramChat(
        deps.turn,
        turn.ownerUserId,
        `Telegram${turn.fromUsername ? ` (@${turn.fromUsername})` : ""}`,
        settings.lastProviderId,
        settings.lastModel,
      );
    } catch (cause) {
      deps.error("Telegram: failed to ensure chat for turn.", cause);
    }

    activeTurn = true;
    dispatchPending = false;

    // Start typing indicator AFTER activeTurn is set so the loop condition
    // evaluates true on its first iteration.
    void sendTypingIndicator(turn.chatId).catch(() => undefined);

    try {
      const result: TelegramTurnResult = await sendTelegramTurn(
        deps.turn,
        chatId,
        turn.text,
      );
      await deliverReply(turn.chatId, result);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      deps.error("Telegram turn failed.", cause);
      await deps.api
        .sendMessage({ chatId: turn.chatId, text: `⚠️ Error: ${msg}` })
        .catch(() => undefined);
    } finally {
      activeTurn = false;
      tryDispatch();
    }
  }

  async function deliverReply(
    chatId: number,
    result: TelegramTurnResult,
  ): Promise<void> {
    if (!result.ok) {
      if (result.error) {
        await deps.api
          .sendMessage({ chatId, text: `⚠️ ${result.error}` })
          .catch(() => undefined);
      }
      return;
    }

    const html = markdownToTelegramHtml(result.content);
    const chunks = chunkForTelegram(html);
    for (const chunk of chunks) {
      await deps.api.sendMessage({
        chatId,
        text: chunk,
        parseMode: "HTML",
        disablePreview: true,
      });
    }
  }

  let typingActive = false;
  async function sendTypingIndicator(chatId: number): Promise<void> {
    if (typingActive) return;
    typingActive = true;
    try {
      while (activeTurn && started) {
        await deps.api.sendChatAction(chatId, "typing").catch(() => undefined);
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
    getStatus,
    get queueSize() {
      return queue.size();
    },
    get isActive() {
      return activeTurn;
    },
  };
}
