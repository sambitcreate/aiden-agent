// Assistant-authored Telegram-native reply actions.

import type { TelegramInlineKeyboardMarkup } from "./telegram-bot-api.js";

export interface TelegramButtonAction {
  label: string;
  prompt: string;
}

export interface TelegramOutboundAttachment {
  path: string;
  caption?: string;
}

export function createTelegramButtonStore(now: () => number) {
  const actions = new Map<string, TelegramButtonAction & { createdAt: number }>();
  let sequence = 0;
  return {
    register(action: TelegramButtonAction): string {
      for (const [id, stored] of actions) {
        if (now() - stored.createdAt > 24 * 60 * 60 * 1_000) actions.delete(id);
      }
      const id = `tgbtn:${(++sequence).toString(36)}`;
      actions.set(id, { ...action, createdAt: now() });
      return id;
    },
    resolve(id: string): TelegramButtonAction | undefined {
      const action = actions.get(id);
      if (!action || now() - action.createdAt > 24 * 60 * 60 * 1_000) {
        actions.delete(id);
        return undefined;
      }
      return { label: action.label, prompt: action.prompt };
    },
  };
}

export function planTelegramReply(
  markdown: string,
  register: (action: TelegramButtonAction) => string,
): { markdown: string; replyMarkup?: TelegramInlineKeyboardMarkup; attachments: TelegramOutboundAttachment[] } {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  const attachments: TelegramOutboundAttachment[] = [];
  const visible = markdown.replace(
    /^<!--\s*(telegram_button|telegram_attach)\s*:?[ \t]*(\{.*\}|(?:[A-Za-z_]\w*="[^"]*"\s*)+)\s*-->[ \t]*(?:\r?\n)?/gmu,
    (_raw, command: string, source: string) => {
      const payload = parsePayload(source.trim());
      if (command === "telegram_attach") {
        const path = stringValue(payload.path) ?? stringValue(payload.value);
        if (path) attachments.push({ path, caption: stringValue(payload.caption) });
        return "";
      }
      const value = stringValue(payload.value);
      const label = stringValue(payload.label) ?? value;
      const prompt = stringValue(payload.prompt) ?? value;
      if (label && prompt) {
        rows.push([{ text: label.slice(0, 64), callback_data: register({ label, prompt }) }]);
      }
      return "";
    },
  ).replace(/\n{3,}/gu, "\n\n").trim();
  return {
    markdown: visible || (rows.length ? "☑️ **Choose an option:**" : ""),
    attachments,
    ...(rows.length ? { replyMarkup: { inline_keyboard: rows } } : {}),
  };
}

function parsePayload(source: string): Record<string, unknown> {
  if (source.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(source);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_]\w*)="([^"]*)"/gu)) result[match[1]!] = match[2]!;
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
