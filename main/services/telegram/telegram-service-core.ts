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
import { sendTelegramTurn, ensureTelegramChat, telegramChatId } from "./telegram-turn.js";
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

export type TelegramServiceStatus = "disabled" | "idle" | "polling" | "error";

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
  listWorkspaces(): Promise<readonly TelegramSelectableWorkspace[]>;
}

interface TelegramSelectableWorkspace {
  id: string;
  name: string;
  folderPath: string;
}

const TELEGRAM_HELP_TEXT = [
  "🤖 Aiden Telegram Bridge",
  "",
  "Send any message and I'll respond as Aiden.",
  "",
  "Commands:",
  "/start — show this help",
  "/stop — clear queued messages",
  "/status — show bridge status",
  "/workspace — list and choose a workspace",
].join("\n");

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
          deps.error(`Telegram handleUpdate failed for ${update.update_id}.`, cause);
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

    await enqueuePrompt({
      lane: classifyMessage(text),
      text,
      chatId: message.chat.id,
      ownerUserId: from.id,
      fromUsername: from.username,
    });
  }

  /**
   * Capture workspace authority before a prompt joins the queue. A later local
   * Settings or Telegram /workspace change must not retarget an accepted prompt.
   */
  async function enqueuePrompt(turn: Omit<QueuedTelegramTurn, "workspaceId">): Promise<void> {
    const settings = await deps.config.getSettings();
    queue.enqueue({ ...turn, workspaceId: settings.telegramWorkspaceId });
    tryDispatch();
  }

  async function handleCommand(command: string, message: TelegramMessage): Promise<void> {
    const cmd = (command.split(/\s+/)[0]?.toLowerCase() ?? "").split("@")[0];
    const chatId = message.chat.id;

    if (cmd === "/start" || cmd === "/help") {
      await deps.api.sendMessage({ chatId, text: TELEGRAM_HELP_TEXT });
      return;
    }

    if (cmd === "/workspace") {
      const workspaces = await deps.listWorkspaces();
      const settings = await deps.config.getSettings();
      const selectedWorkspaceId = settings.telegramWorkspaceId;
      const selectedWorkspace = workspaces.find(
        (workspace) => workspace.id === selectedWorkspaceId,
      );
      const separator = command.search(/\s/u);
      const selection = separator === -1 ? "" : command.slice(separator).trim();
      if (!selection) {
        const lines =
          workspaces.length === 0
            ? [
                "No configured folder workspaces are available.",
                "Add a folder workspace in Aiden Settings, then try /workspace again.",
              ]
            : [
                "🗂️ Telegram workspace",
                `Current: ${
                  selectedWorkspace
                    ? selectedWorkspace.name
                    : selectedWorkspaceId
                      ? "saved workspace unavailable"
                      : "assistant-only mode"
                }`,
                "",
                ...workspaces.flatMap((workspace, index) => [
                  `${index + 1}. ${workspace.name}`,
                  `   ${workspace.folderPath}`,
                ]),
                "",
                "Choose one with /workspace <number>.",
                "Use /workspace off for assistant-only mode.",
              ];
        await deps.api.sendMessage({ chatId, text: lines.join("\n") });
        return;
      }

      if (selection.toLowerCase() === "off") {
        const hadQueued = queue.size();
        queue.clear();
        await deps.config.setSettings({ telegramWorkspaceId: undefined });
        await deps.api.sendMessage({
          chatId,
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
          text:
            matches.length > 1
              ? `More than one workspace is named "${selection}". Choose by number from /workspace.`
              : `Workspace "${selection}" was not found. Run /workspace to see configured folders.`,
        });
        return;
      }

      const hadQueued = queue.size();
      queue.clear();
      await deps.config.setSettings({ telegramWorkspaceId: workspace.id });
      await deps.api.sendMessage({
        chatId,
        text: [
          `Telegram workspace set to ${workspace.name}. Future turns will run in ${workspace.folderPath}.`,
          ...(hadQueued > 0 ? [`Cleared ${hadQueued} queued message(s).`] : []),
        ].join("\n"),
      });
      return;
    }
    if (cmd === "/stop" || cmd === "/cancel") {
      const hadQueued = queue.size();
      queue.clear();
      const lines = [
        hadQueued > 0 ? `🧹 Cleared ${hadQueued} queued message(s).` : "No messages were queued.",
      ];
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

    await enqueuePrompt({
      lane: "default",
      text: command,
      chatId,
      ownerUserId: message.from?.id ?? chatId,
      fromUsername: message.from?.username,
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
      const workspace = await deps.turn.resolveWorkspace(turn.workspaceId);
      const workspaceId = workspace.kind === "project" ? workspace.workspaceId : undefined;
      const chatId = telegramChatId(turn.ownerUserId, workspaceId);

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
          );
        } catch (cause) {
          deps.error("Telegram: failed to ensure chat for turn.", cause);
        }
      }

      activeTurn = true;
      dispatchPending = false;

      // Start typing indicator AFTER activeTurn is set so the loop condition
      // evaluates true on its first iteration.
      void sendTypingIndicator(turn.chatId).catch(() => undefined);

      const result: TelegramTurnResult = await sendTelegramTurn(
        deps.turn,
        chatId,
        turn.text,
        workspace,
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
      dispatchPending = false;
      tryDispatch();
    }
  }

  async function deliverReply(chatId: number, result: TelegramTurnResult): Promise<void> {
    if (!result.ok) {
      if (result.error) {
        await deps.api.sendMessage({ chatId, text: `⚠️ ${result.error}` }).catch(() => undefined);
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
