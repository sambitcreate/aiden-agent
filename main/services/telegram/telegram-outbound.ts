// Assistant-authored Telegram-native reply actions.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../durable-fs.js";
import type { TelegramInlineKeyboardMarkup } from "./telegram-bot-api.js";

const BUTTON_TTL_MS = 24 * 60 * 60 * 1_000;
const PENDING_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_STORED_BUTTONS = 500;
const MAX_STORED_RECEIPTS = 500;
const MAX_STORED_STOP_TARGETS = 500;

export interface TelegramButtonAction {
  label: string;
  prompt: string;
  selectedStyle?: "primary" | "success" | "danger";
}

export interface TelegramButtonScope {
  profile?: string;
  chatId: number;
  threadId?: number;
  ownerUserId: number;
  messageId?: number;
  bindingKey?: string;
}

export interface TelegramStopTargetReceipt {
  targetSubmissionId: string | null;
  stopped: boolean;
  updatedAt: number;
}

export interface TelegramOutboundAttachment {
  path: string;
  caption?: string;
}

export interface TelegramOutboundVoice {
  text: string;
  lang?: string;
  rate?: string;
}

interface StoredTelegramButtonAction extends TelegramButtonAction {
  createdAt: number;
  scope?: TelegramButtonScope;
}

interface StoredTelegramCallbackReceipt {
  callbackQueryId: string;
  token: string;
  action: TelegramButtonAction;
  scope: TelegramButtonScope;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ButtonStoreFile {
  version: 1;
  actions: Record<string, StoredTelegramButtonAction>;
  receipts: Record<string, StoredTelegramCallbackReceipt>;
  stopTargets?: Record<string, TelegramStopTargetReceipt>;
}

function toButtonAction(action: TelegramButtonAction): TelegramButtonAction {
  return {
    label: action.label,
    prompt: action.prompt,
    ...(action.selectedStyle ? { selectedStyle: action.selectedStyle } : {}),
  };
}

function matchesButtonScope(
  stored: TelegramButtonScope | undefined,
  actual: TelegramButtonScope | undefined,
  exact: boolean,
): boolean {
  if (!stored) {
    if (!actual) return true;
    // Fail closed: an unscoped button must never execute against a Bot binding.
    if (actual.bindingKey && actual.bindingKey !== "unbound") return false;
    return !exact;
  }
  if (!actual) return false;
  if (stored.profile !== undefined && (actual.profile ?? "default") !== stored.profile) return false;
  if (exact && (stored.profile ?? "default") !== (actual.profile ?? "default")) return false;
  if (stored.chatId !== actual.chatId) return false;
  if (stored.threadId !== actual.threadId) return false;
  if (stored.ownerUserId !== actual.ownerUserId) return false;
  if ((stored.bindingKey ?? "unbound") !== (actual.bindingKey ?? "unbound")) return false;
  if (exact ? stored.messageId !== actual.messageId : (stored.messageId !== undefined && stored.messageId !== actual.messageId)) {
    return false;
  }
  return true;
}

export interface TelegramButtonStoreOptions {
  /** Optional durable file for registered actions, pending callback receipts, and Stop target fences. */
  file?: string;
}

export type TelegramButtonStore = ReturnType<typeof createTelegramButtonStore>;

export function createTelegramButtonStore(now: () => number, options: TelegramButtonStoreOptions = {}) {
  const actions = new Map<string, StoredTelegramButtonAction>();
  const receipts = new Map<string, StoredTelegramCallbackReceipt>();
  const stopTargets = new Map<string, TelegramStopTargetReceipt>();
  const consumed = new Set<string>();
  let loadedFromDisk = !options.file;
  let tail: Promise<unknown> = Promise.resolve();

  function prune(): void {
    const current = now();
    for (const [id, stored] of actions) {
      if (current - stored.createdAt > BUTTON_TTL_MS) actions.delete(id);
    }
    while (actions.size > MAX_STORED_BUTTONS) {
      const oldest = actions.keys().next().value;
      if (oldest === undefined) break;
      actions.delete(oldest);
    }
    for (const [id, receipt] of receipts) {
      const ttl = receipt.completed ? BUTTON_TTL_MS : PENDING_RECEIPT_TTL_MS;
      if (current - receipt.updatedAt > ttl) receipts.delete(id);
    }
    while (receipts.size > MAX_STORED_RECEIPTS) {
      const oldest = receipts.keys().next().value;
      if (oldest === undefined) break;
      receipts.delete(oldest);
    }
    for (const [id, target] of stopTargets) {
      if (current - target.updatedAt > BUTTON_TTL_MS) stopTargets.delete(id);
    }
    while (stopTargets.size > MAX_STORED_STOP_TARGETS) {
      const oldest = stopTargets.keys().next().value;
      if (oldest === undefined) break;
      stopTargets.delete(oldest);
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (loadedFromDisk || !options.file) return;
    const raw = await readFile(options.file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (raw !== undefined) {
      const parsed = JSON.parse(raw) as Partial<ButtonStoreFile>;
      if (parsed.version !== 1 || typeof parsed.actions !== "object" || parsed.actions === null || typeof parsed.receipts !== "object" || parsed.receipts === null) {
        throw new Error("Unreadable Telegram button state.");
      }
      for (const [id, stored] of Object.entries(parsed.actions)) {
        if (!actions.has(id) && !consumed.has(id) && stored) actions.set(id, stored);
      }
      for (const [id, receipt] of Object.entries(parsed.receipts)) {
        if (!receipts.has(id) && receipt) receipts.set(id, receipt);
      }
      for (const [id, target] of Object.entries(parsed.stopTargets ?? {})) {
        if (!stopTargets.has(id) && target) stopTargets.set(id, target);
      }
    }
    loadedFromDisk = true;
    prune();
  }

  async function persistToDisk(): Promise<void> {
    if (!options.file) return;
    prune();
    const payload: ButtonStoreFile = {
      version: 1,
      actions: Object.fromEntries(actions),
      receipts: Object.fromEntries(receipts),
      stopTargets: Object.fromEntries(stopTargets),
    };
    await writeJsonAtomic(options.file, payload, { mode: 0o600, mkdirMode: 0o700 });
  }

  function locked<T>(work: () => Promise<T> | T): Promise<T> {
    const next = tail.then(async () => {
      await ensureLoaded();
      return work();
    });
    tail = next.catch(() => undefined);
    return next;
  }

  return {
    register(action: TelegramButtonAction, scope?: TelegramButtonScope): string {
      prune();
      let id = "";
      do {
        id = `tgbtn:${randomBytes(12).toString("base64url")}`;
      } while (actions.has(id));
      actions.set(id, {
        ...toButtonAction(action),
        createdAt: now(),
        ...(scope ? { scope: { ...scope } } : {}),
      });
      return id;
    },
    bindMessage(ids: readonly string[], messageId: number): void {
      for (const id of ids) {
        const stored = actions.get(id);
        if (stored?.scope) stored.scope = { ...stored.scope, messageId };
      }
    },
    resolve(id: string, scope?: TelegramButtonScope): TelegramButtonAction | undefined {
      const action = actions.get(id);
      if (!action || now() - action.createdAt > BUTTON_TTL_MS) {
        actions.delete(id);
        return undefined;
      }
      if (!matchesButtonScope(action.scope, scope, false)) return undefined;
      actions.delete(id);
      consumed.add(id);
      return toButtonAction(action);
    },
    flush(): Promise<void> {
      return locked(() => persistToDisk());
    },
    /**
     * Validate and stage a pending callback receipt before admitting its prompt,
     * without consuming the button yet so transient failures and restarts replay safely.
     */
    prepareCallback(
      callbackQueryId: string,
      token: string,
      scope: TelegramButtonScope,
    ): Promise<{ action: TelegramButtonAction; alreadyCompleted: boolean } | undefined> {
      return locked(async () => {
        prune();
        const existing = receipts.get(callbackQueryId);
        if (existing) {
          if (existing.token !== token || !matchesButtonScope(existing.scope, scope, true)) return undefined;
          return { action: toButtonAction(existing.action), alreadyCompleted: existing.completed };
        }
        const stored = actions.get(token);
        if (!stored) return undefined;
        if (!matchesButtonScope(stored.scope, scope, false)) return undefined;
        const created: StoredTelegramCallbackReceipt = {
          callbackQueryId,
          token,
          action: toButtonAction(stored),
          scope: { ...scope },
          completed: false,
          createdAt: now(),
          updatedAt: now(),
        };
        receipts.set(callbackQueryId, created);
        try {
          await persistToDisk();
        } catch (error) {
          receipts.delete(callbackQueryId);
          loadedFromDisk = !options.file;
          throw error;
        }
        return { action: toButtonAction(created.action), alreadyCompleted: false };
      });
    },
    completeCallback(callbackQueryId: string, token: string): Promise<void> {
      return locked(async () => {
        actions.delete(token);
        consumed.add(token);
        const existing = receipts.get(callbackQueryId);
        if (existing && existing.token === token) {
          existing.completed = true;
          existing.updatedAt = now();
        }
        await persistToDisk();
      });
    },
    getStopTarget(stopIdentity: string): Promise<TelegramStopTargetReceipt | undefined> {
      return locked(() => {
        prune();
        const found = stopTargets.get(stopIdentity);
        return found ? { ...found } : undefined;
      });
    },
    recordStopTarget(stopIdentity: string, targetSubmissionId: string | null, stopped: boolean): Promise<void> {
      return locked(async () => {
        stopTargets.set(stopIdentity, { targetSubmissionId, stopped, updatedAt: now() });
        await persistToDisk();
      });
    },
  };
}

export function planTelegramReply(
  markdown: string,
  register: (action: TelegramButtonAction) => string,
): {
  markdown: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
  attachments: TelegramOutboundAttachment[];
  voices: TelegramOutboundVoice[];
} {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  const attachments: TelegramOutboundAttachment[] = [];
  const voices: TelegramOutboundVoice[] = [];
  const visible = markdown.replace(
    /^<!--\s*(telegram_button|telegram_attach|telegram_voice)\s*:?[ \t]*(\{.*\}|(?:[A-Za-z_]\w*="[^"]*"\s*)+)\s*-->[ \t]*(?:\r?\n)?/gmu,
    (_raw, command: string, source: string) => {
      const payload = parsePayload(source.trim());
      if (command === "telegram_attach") {
        const path = stringValue(payload.path) ?? stringValue(payload.value);
        if (path) attachments.push({ path, caption: stringValue(payload.caption) });
        return "";
      }
      if (command === "telegram_voice") {
        const text = stringValue(payload.text) ?? stringValue(payload.value);
        const lang = stringValue(payload.lang);
        const rate = stringValue(payload.rate);
        if (text) voices.push({ text, ...(lang ? { lang } : {}), ...(rate ? { rate } : {}) });
        return "";
      }
      const value = stringValue(payload.value);
      const label = stringValue(payload.label) ?? value;
      const prompt = stringValue(payload.prompt) ?? value;
      const style = payload.selected_style;
      const selectedStyle = style === "primary" || style === "success" || style === "danger"
        ? style
        : undefined;
      if (label && prompt) {
        rows.push([{
          text: label.slice(0, 64),
          callback_data: register({ label, prompt, ...(selectedStyle ? { selectedStyle } : {}) }),
        }]);
      }
      return "";
    },
  ).replace(/\n{3,}/gu, "\n\n").trim();
  return {
    markdown: visible || (rows.length ? "☑️ **Choose an option:**" : ""),
    attachments,
    voices,
    ...(rows.length ? { replyMarkup: { inline_keyboard: rows } } : {}),
  };
}

/** Hide complete and in-progress host action comments from streamed previews. */
export function stripTelegramActionMarkupForPreview(markdown: string): string {
  return markdown
    .split(/\r?\n/gu)
    .filter((line) => !/^<!--[ \t]*telegram_(?:button|attach|voice)\b/iu.test(line))
    .join("\n")
    .trim();
}

export function markTelegramButtonSelected(
  markup: TelegramInlineKeyboardMarkup,
  callbackData: string,
  style: "primary" | "success" | "danger" = "primary",
): TelegramInlineKeyboardMarkup | undefined {
  let matched = false;
  const inline_keyboard = markup.inline_keyboard.map((row) => row.map((button) => {
    if (button.callback_data !== callbackData) return { ...button };
    matched = true;
    return { ...button, style };
  }));
  return matched ? { inline_keyboard } : undefined;
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
