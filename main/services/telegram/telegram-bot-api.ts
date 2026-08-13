// Telegram Bot API client — long-polling transport, message delivery, and bot identity.
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT)
// — a fork of badlogic/pi-telegram. The host-agent coupling in the original
// is replaced by Aiden's llmClient turn-injection shim (telegram-turn.ts).
// This module is pure transport: it knows nothing about Aiden's chat model.

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  /** True when BotFather Threaded Mode is enabled for this bot's private chats. */
  has_topics_enabled?: boolean;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  media_group_id?: string;
  message_thread_id?: number;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  animation?: TelegramDocument;
  forward_origin?: unknown;
  reply_markup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio extends TelegramVoice {
  file_name?: string;
  title?: string;
  performer?: string;
}

export interface TelegramVideo extends TelegramDocument {
  width: number;
  height: number;
  duration: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramBotCommand {
  command: string;
  description: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  style?: "primary" | "success" | "danger";
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramInputRichMessage {
  markdown: string;
  skip_entity_detection?: boolean;
}

export interface TelegramForumTopic {
  message_thread_id: number;
  name: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReactionUpdated;
}

export interface TelegramReactionTypeEmoji {
  type: "emoji";
  emoji: string;
}

export interface TelegramMessageReactionUpdated {
  chat: TelegramChat;
  message_id: number;
  user?: TelegramUser;
  old_reaction: TelegramReactionTypeEmoji[];
  new_reaction: TelegramReactionTypeEmoji[];
  date: number;
}

export type TelegramMessageEntityType =
  | "bold"
  | "italic"
  | "code"
  | "pre"
  | "text_link"
  | "mention"
  | "bot_command";

export interface TelegramMessageEntity {
  type: TelegramMessageEntityType;
  offset: number;
  length: number;
  url?: string;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** Inject-able transport so tests can mock the network entirely. */
export type TelegramTransport = (
  method: string,
  body: Record<string, unknown>,
) => Promise<TelegramApiResponse<unknown>>;

export type TelegramFileDownloader = (filePath: string) => Promise<Uint8Array>;
export type TelegramUploadTransport = (
  method: string,
  fields: Record<string, string>,
  file: { field: string; bytes: Uint8Array; name: string; mimeType: string },
) => Promise<TelegramApiResponse<unknown>>;

/** Production transport: posts JSON to api.telegram.org. Resolves the token
 *  per request so runtime key changes are picked up without re-creation. */
export function createFetchTransport(tokenResolver: () => Promise<string | null>): TelegramTransport {
  return async (method: string, body: Record<string, unknown>) => {
    const token = await tokenResolver();
    if (!token) throw new Error("No Telegram bot token configured.");
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json()) as TelegramApiResponse<unknown>;
  };
}

export function createFetchFileDownloader(
  tokenResolver: () => Promise<string | null>,
): TelegramFileDownloader {
  return async (filePath: string) => {
    const token = await tokenResolver();
    if (!token) throw new Error("No Telegram bot token configured.");
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!response.ok) {
      throw new TelegramApiError(
        `Telegram file download failed: ${response.status} ${response.statusText}`,
        response.status,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

export function createFetchUploadTransport(
  tokenResolver: () => Promise<string | null>,
): TelegramUploadTransport {
  return async (method, fields, file) => {
    const token = await tokenResolver();
    if (!token) throw new Error("No Telegram bot token configured.");
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append(file.field, new Blob([file.bytes as BlobPart], { type: file.mimeType }), file.name);
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      body: form,
    });
    return (await response.json()) as TelegramApiResponse<unknown>;
  };
}

/** Retryable error with optional retry_after (seconds) from Telegram. */
export class TelegramApiError extends Error {
  readonly retryAfter: number | undefined;
  readonly code: number;
  constructor(message: string, code: number, retryAfter?: number) {
    super(message);
    this.name = "TelegramApiError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function unwrap<T>(res: TelegramApiResponse<unknown>): T {
  if (!res.ok) {
    const retry = res.parameters?.retry_after;
    const msg = res.description ?? "Telegram API request failed.";
    throw new TelegramApiError(msg, res.error_code ?? 0, retry);
  }
  return res.result as T;
}

/** Race a transport call against an abort signal for cooperative cancellation. */
function callWithAbort(
  transport: () => Promise<TelegramApiResponse<unknown>>,
  signal?: AbortSignal,
): Promise<TelegramApiResponse<unknown>> {
  if (!signal) return transport();
  if (signal.aborted) return Promise.reject(new Error("Telegram polling aborted."));
  return new Promise<TelegramApiResponse<unknown>>((resolve, reject) => {
    const onAbort = () => reject(new Error("Telegram polling aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    transport()
      .then((result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      })
      .catch((error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
  });
}

export class TelegramBotApi {
  constructor(
    private readonly transport: TelegramTransport,
    private readonly fileDownloader?: TelegramFileDownloader,
    private readonly uploadTransport?: TelegramUploadTransport,
  ) {}

  /** Long-poll for updates. Returns immediately on timeout (empty array). */
  async getUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = {
      timeout: timeoutSeconds,
      allowed_updates: ["message", "edited_message", "callback_query", "message_reaction"],
    };
    if (offset !== undefined) body.offset = offset;
    return callWithAbort(
      () => this.transport("getUpdates", body),
      signal,
    ).then((r) => unwrap<TelegramUpdate[]>(r));
  }

  async getMe(): Promise<TelegramUser> {
    return unwrap<TelegramUser>(await this.transport("getMe", {}));
  }

  async createForumTopic(chatId: number, name: string): Promise<TelegramForumTopic> {
    return unwrap<TelegramForumTopic>(await this.transport("createForumTopic", {
      chat_id: chatId,
      name,
    }));
  }

  async deleteForumTopic(chatId: number, threadId: number): Promise<void> {
    await unwrap<boolean>(await this.transport("deleteForumTopic", {
      chat_id: chatId,
      message_thread_id: threadId,
    }));
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return unwrap<TelegramFile>(await this.transport("getFile", { file_id: fileId }));
  }

  async downloadFile(fileId: string): Promise<{ file: TelegramFile; bytes: Uint8Array }> {
    if (!this.fileDownloader) throw new Error("Telegram file downloads are unavailable.");
    const file = await this.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram did not return a file path.");
    return { file, bytes: await this.fileDownloader(file.file_path) };
  }

  async sendDocument(params: {
    chatId: number;
    threadId?: number;
    bytes: Uint8Array;
    name: string;
    mimeType?: string;
    caption?: string;
  }): Promise<TelegramMessage> {
    if (!this.uploadTransport) throw new Error("Telegram file uploads are unavailable.");
    return unwrap<TelegramMessage>(await this.uploadTransport(
      "sendDocument",
      {
        chat_id: String(params.chatId),
        ...(params.threadId !== undefined ? { message_thread_id: String(params.threadId) } : {}),
        ...(params.caption ? { caption: params.caption } : {}),
      },
      {
        field: "document",
        bytes: params.bytes,
        name: params.name,
        mimeType: params.mimeType ?? "application/octet-stream",
      },
    ));
  }

  async sendVoice(params: {
    chatId: number;
    threadId?: number;
    bytes: Uint8Array;
    name?: string;
    mimeType?: "audio/ogg" | "audio/opus";
    caption?: string;
  }): Promise<TelegramMessage> {
    if (!this.uploadTransport) throw new Error("Telegram voice uploads are unavailable.");
    return unwrap<TelegramMessage>(await this.uploadTransport(
      "sendVoice",
      {
        chat_id: String(params.chatId),
        ...(params.threadId !== undefined ? { message_thread_id: String(params.threadId) } : {}),
        ...(params.caption ? { caption: params.caption } : {}),
      },
      {
        field: "voice",
        bytes: params.bytes,
        name: params.name ?? "aiden-voice.ogg",
        mimeType: params.mimeType ?? "audio/ogg",
      },
    ));
  }

  /** Publish the private-chat command palette shown by Telegram clients. */
  async setMyCommands(commands: readonly TelegramBotCommand[]): Promise<void> {
    await unwrap<boolean>(
      await this.transport("setMyCommands", {
        commands,
        scope: { type: "all_private_chats" },
      }),
    );
  }

  async sendMessage(params: {
    chatId: number;
    threadId?: number;
    text: string;
    parseMode?: "HTML" | "MarkdownV2";
    replyMarkup?: unknown;
    disablePreview?: boolean;
  }): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      ...(params.threadId !== undefined ? { message_thread_id: params.threadId } : {}),
      text: params.text,
    };
    if (params.parseMode) body.parse_mode = params.parseMode;
    if (params.replyMarkup) body.reply_markup = params.replyMarkup;
    if (params.disablePreview) body.disable_web_page_preview = true;
    return unwrap<TelegramMessage>(await this.transport("sendMessage", body));
  }

  async sendRichMessage(params: {
    chatId: number;
    threadId?: number;
    markdown: string;
    replyMarkup?: unknown;
  }): Promise<TelegramMessage> {
    return unwrap<TelegramMessage>(await this.transport("sendRichMessage", {
      chat_id: params.chatId,
      ...(params.threadId !== undefined ? { message_thread_id: params.threadId } : {}),
      rich_message: { markdown: params.markdown, skip_entity_detection: true },
      ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
    }));
  }

  async sendRichMessageDraft(params: {
    chatId: number;
    threadId?: number;
    draftId: number;
    markdown: string;
  }): Promise<void> {
    await unwrap<boolean>(await this.transport("sendRichMessageDraft", {
      chat_id: params.chatId,
      draft_id: params.draftId,
      ...(params.threadId !== undefined ? { message_thread_id: params.threadId } : {}),
      rich_message: { markdown: params.markdown, skip_entity_detection: true },
    }));
  }

  async editMessageText(params: {
    chatId: number;
    messageId: number;
    text: string;
    parseMode?: "HTML" | "MarkdownV2";
    replyMarkup?: unknown;
    disablePreview?: boolean;
  }): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      message_id: params.messageId,
      text: params.text,
    };
    if (params.parseMode) body.parse_mode = params.parseMode;
    if (params.replyMarkup !== undefined) body.reply_markup = params.replyMarkup;
    if (params.disablePreview) body.disable_web_page_preview = true;
    return unwrap<TelegramMessage>(await this.transport("editMessageText", body));
  }


  async editMessageReplyMarkup(params: {
    chatId: number;
    messageId: number;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  }): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      message_id: params.messageId,
      reply_markup: params.replyMarkup ?? { inline_keyboard: [] },
    };
    await unwrap<unknown>(await this.transport("editMessageReplyMarkup", body));
  }

  async sendChatAction(chatId: number, action: string, threadId?: number): Promise<void> {
    await unwrap<boolean>(await this.transport("sendChatAction", {
      chat_id: chatId,
      action,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    }));
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id: id };
    if (text) body.text = text;
    await unwrap<boolean>(await this.transport("answerCallbackQuery", body));
  }
}
