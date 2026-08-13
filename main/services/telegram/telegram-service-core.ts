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
} from "./telegram-bot-api.js";
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
  type TelegramControlStatus,
  type TelegramModelChoice,
} from "./telegram-controls.js";
import type { TelegramCompactionResult } from "./telegram-session.js";
import { normalizeTelegramInbound } from "./telegram-inbound.js";
import { GENERATION_THINKING_LEVELS } from "../../../renderer/shared/generation-thinking.js";
import { createTelegramActivityProjector } from "./telegram-activity.js";
import { createTelegramButtonStore, planTelegramReply } from "./telegram-outbound.js";

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
  listModels?(): Promise<readonly TelegramModelChoice[]>;
  abortChat?(chatId: string): Promise<void>;
  compactChat?(chatId: string): Promise<TelegramCompactionResult>;
  transcribeAudio?(input: { audioBase64: string; mimeType: string }): Promise<string>;
  listPromptCommands?(workspaceId?: string): Promise<readonly TelegramPromptCommand[]>;
  readOutboundAttachment?(workspaceId: string | undefined, requestedPath: string): Promise<{
    bytes: Uint8Array;
    name: string;
    mimeType: string;
  }>;
}

interface TelegramSelectableWorkspace {
  id: string;
  name: string;
  folderPath: string;
}

interface TelegramPromptCommand {
  command: string;
  description: string;
  expand(argument: string): string;
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
      const settings = await deps.config.getSettings();
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
      return;
    }

    // Only the paired owner is authorized.
    if (from.id !== snap.allowedUserId) {
      deps.warn(`Telegram: unauthorized user ${from.id} ignored.`);
      return;
    }

    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return;
    }

    const rawText = extractText(message);

    // Control lane: commands are handled immediately (no LLM).
    if (rawText?.startsWith("/")) {
      await handleCommand(rawText.trim(), message);
      return;
    }

    const inbound = await normalizeTelegramInbound(
      { api: deps.api, transcribeAudio: deps.transcribeAudio },
      message,
    );
    for (const notice of inbound.notices) {
      await deps.api.sendMessage({ chatId: message.chat.id, text: `⚠️ ${notice}` });
    }
    if (!inbound.text && inbound.attachments.length === 0) return;

    if (update.edited_message) {
      const existing = queue.list().find(
        (turn) => turn.chatId === message.chat.id && turn.sourceMessageId === message.message_id,
      );
      if (existing?.id !== undefined) {
        queue.replace(existing.id, {
          ...existing,
          text: inbound.text || "Please review the attached file.",
          attachments: inbound.attachments,
        });
        await deps.api.sendMessage({ chatId: message.chat.id, text: "✏️ Updated the queued prompt." });
      }
      return;
    }

    if (message.media_group_id) {
      const existing = queue.list().find(
        (turn) => turn.chatId === message.chat.id && turn.sourceMediaGroupId === message.media_group_id,
      );
      if (existing?.id !== undefined) {
        queue.replace(existing.id, {
          ...existing,
          text: [existing.text, inbound.text].filter(Boolean).join("\n\n"),
          attachments: [...(existing.attachments ?? []), ...inbound.attachments],
        });
        return;
      }
    }

    await enqueuePrompt({
      lane: classifyMessage(inbound.text),
      text: inbound.text || "Please review the attached file.",
      attachments: inbound.attachments,
      chatId: message.chat.id,
      sourceMessageId: message.message_id,
      sourceMediaGroupId: message.media_group_id,
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
  }

  async function controlStatus(): Promise<TelegramControlStatus> {
    const [settings, models, workspaces] = await Promise.all([
      deps.config.getSettings(),
      deps.listModels?.() ?? Promise.resolve([]),
      deps.listWorkspaces(),
    ]);
    const providerId = settings.telegramProviderId ?? settings.lastProviderId;
    const model = settings.telegramModel ?? settings.lastModel;
    const choice = models.find(
      (candidate) => candidate.providerId === providerId && candidate.model === model,
    );
    const workspace = workspaces.find((candidate) => candidate.id === settings.telegramWorkspaceId);
    return {
      botUsername,
      allowedUserId: settings.telegramAllowedUserId,
      providerId,
      providerLabel: choice?.providerLabel,
      model,
      thinkingLevel: settings.telegramThinkingLevel ?? "medium",
      queueCount: queue.size(),
      active: activeTurn,
      workspaceLabel: workspace?.name ?? (settings.telegramWorkspaceId ? "Unavailable" : "Assistant only"),
      lastError,
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
      text,
      parseMode: "HTML",
      replyMarkup,
      disablePreview: true,
    });
  }

  async function openMainMenu(message: TelegramMessage, edit = false): Promise<void> {
    const status = await controlStatus();
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

  async function openWorkspaceMenu(message: TelegramMessage, edit = false): Promise<void> {
    const [settings, workspaces] = await Promise.all([
      deps.config.getSettings(),
      deps.listWorkspaces(),
    ]);
    const menu = buildWorkspaceMenu(workspaces, settings.telegramWorkspaceId);
    await renderControl(message, menu.text, menu.markup, edit);
  }

  async function openQueueMenu(message: TelegramMessage, edit = false): Promise<void> {
    const menu = buildQueueMenu(queue.list());
    await renderControl(message, menu.text, menu.markup, edit);
  }

  function currentSessionChatId(ownerUserId: number, workspaceId?: string): string {
    return telegramChatId(ownerUserId, workspaceId);
  }

  async function abortCurrentTurn(): Promise<boolean> {
    if (!activeTurn || !activeChatId) return false;
    if (!deps.abortChat) return false;
    await deps.abortChat(activeChatId);
    return true;
  }

  async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
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
        await enqueuePrompt({
          lane: "priority",
          text: action.prompt,
          chatId: message.chat.id,
          ownerUserId: callback.from.id,
          fromUsername: callback.from.username,
        });
        await deps.api.answerCallbackQuery(callback.id, action.label);
        return;
      }
      if (data === "noop") {
        await deps.api.answerCallbackQuery(callback.id);
        return;
      }
      if (data === "menu:back") await openMainMenu(message, true);
      else if (data === "menu:model") await openModelMenu(message, 0, true);
      else if (data === "menu:thinking") await openThinkingMenu(message, true);
      else if (data === "menu:queue") await openQueueMenu(message, true);
      else if (data === "menu:workspace") await openWorkspaceMenu(message, true);
      else if (data === "menu:settings") {
        const settings = await deps.config.getSettings();
        const menu = buildSettingsMenu({
          draftPreviews: settings.telegramDraftPreviews,
          activity: settings.telegramActivity,
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
        });
        await renderControl(message, menu.text, menu.markup, true);
      } else if (/^model:page:\d+$/u.test(data)) {
        await openModelMenu(message, Number(data.slice("model:page:".length)), true);
      } else if (/^model:set:\d+$/u.test(data)) {
        const models = await deps.listModels?.() ?? [];
        const choice = models[Number(data.slice("model:set:".length))];
        if (!choice) throw new Error("That model is no longer available.");
        await deps.config.setSettings({
          telegramProviderId: choice.providerId,
          telegramModel: choice.model,
          telegramThinkingLevel: choice.reasoning ? undefined : "off",
        });
        await openMainMenu(message, true);
      } else if (data.startsWith("thinking:set:")) {
        const level = data.slice("thinking:set:".length);
        if (!GENERATION_THINKING_LEVELS.includes(level as never)) {
          throw new Error("Unknown thinking level.");
        }
        await deps.config.setSettings({ telegramThinkingLevel: level as typeof GENERATION_THINKING_LEVELS[number] });
        await openMainMenu(message, true);
      } else if (data.startsWith("workspace:set:")) {
        const selection = data.slice("workspace:set:".length);
        const workspaces = await deps.listWorkspaces();
        const workspace = selection === "off" ? undefined : workspaces[Number(selection)];
        if (selection !== "off" && !workspace) throw new Error("That workspace is unavailable.");
        const cleared = queue.size();
        queue.clear();
        await deps.config.setSettings({ telegramWorkspaceId: workspace?.id });
        await openMainMenu(message, true);
        if (cleared > 0) {
          await deps.api.sendMessage({ chatId: message.chat.id, text: `Cleared ${cleared} queued prompt(s) because the workspace changed.` });
        }
      } else if (/^queue:item:\d+$/u.test(data)) {
        const item = queue.find(Number(data.slice("queue:item:".length)));
        if (!item) return void (await openQueueMenu(message, true));
        const menu = buildQueueItemMenu(item);
        await renderControl(message, menu.text, menu.markup, true);
      } else if (/^queue:priority:\d+$/u.test(data)) {
        const id = Number(data.slice("queue:priority:".length));
        const item = queue.find(id);
        if (!item) return void (await openQueueMenu(message, true));
        queue.setPriority(id, item.lane !== "priority");
        const updated = queue.find(id);
        if (updated) {
          const menu = buildQueueItemMenu(updated);
          await renderControl(message, menu.text, menu.markup, true);
        }
      } else if (/^queue:delete:\d+$/u.test(data)) {
        queue.remove(Number(data.slice("queue:delete:".length)));
        await openQueueMenu(message, true);
      } else if (data === "queue:clear:ask") {
        const menu = confirmationMenu("Clear every queued prompt?", "queue:clear:yes");
        await renderControl(message, menu.text, menu.markup, true);
      } else if (data === "queue:clear:yes") {
        queue.clear();
        await openQueueMenu(message, true);
      } else if (data === "compact:ask") {
        const menu = confirmationMenu("Compact the current Aiden session?", "compact:yes");
        await renderControl(message, menu.text, menu.markup, true);
      } else if (data === "compact:yes") {
        if (activeTurn) throw new Error("Wait for the active turn to finish or abort it first.");
        const settings = await deps.config.getSettings();
        if (!deps.compactChat) throw new Error("Manual compaction is unavailable in this runtime.");
        const result = await deps.compactChat(
          currentSessionChatId(callback.from.id, settings.telegramWorkspaceId),
        );
        await deps.api.sendMessage({
          chatId: message.chat.id,
          text: result.compacted
            ? `🗜 Session compacted${result.tokensBefore ? ` from about ${result.tokensBefore.toLocaleString()} tokens` : ""}.`
            : `⚠️ ${result.error ?? "Compaction did not run."}`,
        });
        await openMainMenu(message, true);
      } else if (data === "turn:abort") {
        const aborted = await abortCurrentTurn();
        await deps.api.sendMessage({ chatId: message.chat.id, text: aborted ? "⏹ Active turn aborted." : "No turn is active." });
        await openMainMenu(message, true);
      } else if (data === "turn:next") {
        const aborted = await abortCurrentTurn();
        await deps.api.sendMessage({ chatId: message.chat.id, text: aborted ? "⏭ Moving to the next queued prompt." : "No turn is active." });
      } else if (data === "turn:stop") {
        const cleared = queue.size();
        queue.clear();
        const aborted = await abortCurrentTurn();
        await deps.api.sendMessage({ chatId: message.chat.id, text: `🛑 ${aborted ? "Active turn aborted. " : ""}Cleared ${cleared} queued prompt(s).` });
        await openMainMenu(message, true);
      } else {
        await deps.api.answerCallbackQuery(callback.id, "This control is no longer available.");
        return;
      }
      await deps.api.answerCallbackQuery(callback.id);
    } catch (cause) {
      const messageText = cause instanceof Error ? cause.message : String(cause);
      await deps.api.answerCallbackQuery(callback.id, messageText.slice(0, 180)).catch(() => undefined);
      await deps.api.sendMessage({ chatId: message.chat.id, text: `⚠️ ${messageText}` }).catch(() => undefined);
    }
  }

  async function handleCommand(command: string, message: TelegramMessage): Promise<void> {
    const cmd = commandName(command);
    const chatId = message.chat.id;

    if (cmd === "/start") {
      await openMainMenu(message);
      return;
    }

    if (cmd === "/help") {
      await deps.api.sendMessage({ chatId, text: TELEGRAM_HELP_TEXT });
      return;
    }

    if (cmd === "/status") {
      await openMainMenu(message);
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
      await openQueueMenu(message);
      return;
    }

    if (cmd === "/settings") {
      const settings = await deps.config.getSettings();
      const menu = buildSettingsMenu({
        draftPreviews: settings.telegramDraftPreviews,
        activity: settings.telegramActivity,
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
        ownerUserId: message.from?.id ?? chatId,
        fromUsername: message.from?.username,
      });
      await deps.api.sendMessage({ chatId, text: "▶️ Continuation queued." });
      return;
    }

    if (cmd === "/workspace") {
      const workspaces = await deps.listWorkspaces();
      const selection = commandArgument(command);
      if (!selection) {
        await openWorkspaceMenu(message);
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
    if (cmd === "/abort" || cmd === "/cancel") {
      const aborted = await abortCurrentTurn();
      await deps.api.sendMessage({
        chatId,
        text: aborted ? "⏹ Active turn aborted. The queue is preserved." : "No turn is active.",
      });
      return;
    }

    if (cmd === "/next") {
      const aborted = await abortCurrentTurn();
      await deps.api.sendMessage({
        chatId,
        text: aborted
          ? "⏭ Active turn aborted. The next queued prompt will run."
          : queue.size()
            ? "⏭ The next queued prompt will run."
            : "No active turn or queued prompt.",
      });
      tryDispatch();
      return;
    }

    if (cmd === "/stop") {
      const hadQueued = queue.size();
      queue.clear();
      const aborted = await abortCurrentTurn();
      const lines = [
        hadQueued > 0 ? `🧹 Cleared ${hadQueued} queued message(s).` : "No messages were queued.",
      ];
      if (aborted) lines.push("The active turn was aborted.");
      await deps.api.sendMessage({ chatId, text: lines.join("\n") });
      return;
    }

    const settings = await deps.config.getSettings();
    const templates = await deps.listPromptCommands?.(settings.telegramWorkspaceId) ?? [];
    const template = templates.find((candidate) => `/${candidate.command}` === cmd);
    if (template) {
      await enqueuePrompt({
        lane: "default",
        text: template.expand(commandArgument(command)),
        chatId,
        ownerUserId: message.from?.id ?? chatId,
        fromUsername: message.from?.username,
      });
      return;
    }

    await deps.api.sendMessage({
      chatId,
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
      activeChatId = chatId;
      dispatchPending = false;

      const settings = await deps.config.getSettings();
      const activity = createTelegramActivityProjector({
        api: deps.api,
        chatId: turn.chatId,
        draftPreviews: settings.telegramDraftPreviews ?? false,
        verbosity: settings.telegramActivity ?? "quiet",
        now: deps.now,
      });

      // Start typing indicator AFTER activeTurn is set so the loop condition
      // evaluates true on its first iteration.
      void sendTypingIndicator(turn.chatId).catch(() => undefined);

      const result: TelegramTurnResult = await sendTelegramTurn(
        deps.turn,
        chatId,
        turn.text,
        workspace,
        turn.attachments,
        activity.observe,
      );
      await activity.settle();
      await deliverReply(turn.chatId, result, activity.draftMessageId, turn.workspaceId);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      deps.error("Telegram turn failed.", cause);
      await deps.api
        .sendMessage({ chatId: turn.chatId, text: `⚠️ Error: ${msg}` })
        .catch(() => undefined);
    } finally {
      activeTurn = false;
      activeChatId = undefined;
      dispatchPending = false;
      tryDispatch();
    }
  }

  async function deliverReply(
    chatId: number,
    result: TelegramTurnResult,
    draftMessageId?: number,
    workspaceId?: string,
  ): Promise<void> {
    if (!result.ok) {
      if (result.error) {
        await deps.api.sendMessage({ chatId, text: `⚠️ ${result.error}` }).catch(() => undefined);
      }
      return;
    }

    const plan = planTelegramReply(result.content, (action) => buttonStore.register(action));
    const html = markdownToTelegramHtml(plan.markdown);
    const chunks = chunkForTelegram(html);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      if (index === 0 && draftMessageId !== undefined) {
        await deps.api.editMessageText({
          chatId,
          messageId: draftMessageId,
          text: chunk,
          parseMode: "HTML",
          ...(index === chunks.length - 1 && plan.replyMarkup ? { replyMarkup: plan.replyMarkup } : {}),
        });
      } else {
        await deps.api.sendMessage({
          chatId,
          text: chunk,
          parseMode: "HTML",
          ...(index === chunks.length - 1 && plan.replyMarkup ? { replyMarkup: plan.replyMarkup } : {}),
          disablePreview: true,
        });
      }
    }
    for (const attachment of plan.attachments) {
      if (!deps.readOutboundAttachment) {
        await deps.api.sendMessage({ chatId, text: "⚠️ Outbound file delivery is unavailable." });
        continue;
      }
      try {
        const file = await deps.readOutboundAttachment(workspaceId, attachment.path);
        await deps.api.sendDocument({
          chatId,
          bytes: file.bytes,
          name: file.name,
          mimeType: file.mimeType,
          caption: attachment.caption,
        });
      } catch (cause) {
        await deps.api.sendMessage({
          chatId,
          text: `⚠️ Could not attach ${attachment.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
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
