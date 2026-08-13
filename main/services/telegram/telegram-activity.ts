// Ordered, bounded Telegram projection for Aiden generation activity.

import type { NotificationChannel } from "../../../renderer/preload-channels.js";
import type { TelegramBotApi, TelegramMessage } from "./telegram-bot-api.js";
import { escapeHtml } from "./telegram-controls.js";
import { chunkForTelegram, markdownToTelegramHtml } from "./telegram-markdown.js";

export type TelegramActivityVerbosity = "quiet" | "thinking" | "tools" | "verbose";

interface ActivityOptions {
  api: TelegramBotApi;
  chatId: number;
  draftPreviews: boolean;
  verbosity: TelegramActivityVerbosity;
  now(): number;
}

const DRAFT_INTERVAL_MS = 900;
const THINKING_LIMIT = 3_500;

export function createTelegramActivityProjector(options: ActivityOptions) {
  let draft = "";
  let reasoning = "";
  let draftMessage: TelegramMessage | undefined;
  let thinkingMessage: TelegramMessage | undefined;
  let lastDraftAt = 0;
  let delivery = Promise.resolve();
  let finished = false;

  const enqueue = (operation: () => Promise<void>): void => {
    delivery = delivery.then(operation).catch(() => undefined);
  };

  async function updateDraft(): Promise<void> {
    if (!draft.trim() || finished) return;
    const html = chunkForTelegram(markdownToTelegramHtml(draft))[0];
    if (!html) return;
    if (!draftMessage) {
      draftMessage = await options.api.sendMessage({
        chatId: options.chatId,
        text: html,
        parseMode: "HTML",
        disablePreview: true,
      });
      return;
    }
    await options.api.editMessageText({
      chatId: options.chatId,
      messageId: draftMessage.message_id,
      text: html,
      parseMode: "HTML",
    });
  }

  async function updateThinking(): Promise<void> {
    if (!reasoning.trim() || finished) return;
    const visible = reasoning.slice(-THINKING_LIMIT).trim();
    const html = `<blockquote expandable>${escapeHtml(visible)}</blockquote>`;
    if (!thinkingMessage) {
      thinkingMessage = await options.api.sendMessage({
        chatId: options.chatId,
        text: html,
        parseMode: "HTML",
        disablePreview: true,
      });
      return;
    }
    await options.api.editMessageText({
      chatId: options.chatId,
      messageId: thinkingMessage.message_id,
      text: html,
      parseMode: "HTML",
    });
  }

  function observe(channel: NotificationChannel, payload: unknown): void {
    if (channel === "chat:delta") {
      const delta = (payload as { delta?: string })?.delta;
      if (!delta) return;
      draft += delta;
      if (options.draftPreviews && options.now() - lastDraftAt >= DRAFT_INTERVAL_MS) {
        lastDraftAt = options.now();
        enqueue(updateDraft);
      }
      return;
    }
    if (channel === "chat:reasoning-delta") {
      if (options.verbosity !== "thinking" && options.verbosity !== "verbose") return;
      const delta = (payload as { delta?: string })?.delta;
      if (!delta) return;
      reasoning += delta;
      enqueue(updateThinking);
      return;
    }
    if (channel === "chat:tool") {
      if (options.verbosity !== "tools" && options.verbosity !== "verbose") return;
      const event = payload as { phase?: string; toolName?: string };
      if (!event.toolName || !event.phase) return;
      if (event.phase === "call") return;
      const icon = event.phase === "result" ? "✅" : event.phase === "blocked" ? "⛔️" : "⚠️";
      enqueue(async () => {
        await options.api.sendMessage({
          chatId: options.chatId,
          text: `${icon} <b>${escapeHtml(titleCase(event.toolName!))}</b>: <code>${escapeHtml(event.phase!)}</code>`,
          parseMode: "HTML",
          disablePreview: true,
        });
      });
    }
  }

  async function settle(): Promise<void> {
    if (options.draftPreviews && draft.trim()) enqueue(updateDraft);
    await delivery;
    finished = true;
  }

  return { observe, settle, get draftMessageId() { return draftMessage?.message_id; } };
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (char) => char.toUpperCase());
}
