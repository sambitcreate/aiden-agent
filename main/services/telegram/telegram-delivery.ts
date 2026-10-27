import type { TelegramBotApi } from "./telegram-bot-api.js";

/** Only outbound operations, so activity and final delivery share the same authority guard. */
export type TelegramDeliveryApi = Pick<TelegramBotApi,
  "sendMessage" | "sendRichMessage" | "sendRichMessageDraft" | "editMessageText" |
  "sendDocument" | "sendVoice" | "sendChatAction"
>;

export function createTelegramDeliveryApi(api: TelegramBotApi, assertCurrent: () => Promise<void>, signal: AbortSignal): TelegramDeliveryApi {
  function guard<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) {
    return async (...args: Args): Promise<Result> => {
      signal.throwIfAborted();
      await assertCurrent();
      // No await between this final cancellation check and starting the actual request.
      signal.throwIfAborted();
      return operation(...args);
    };
  }
  return {
    sendMessage: guard((...args: Parameters<TelegramBotApi["sendMessage"]>) => api.sendMessage(...args)),
    sendRichMessage: guard((...args: Parameters<TelegramBotApi["sendRichMessage"]>) => api.sendRichMessage(...args)),
    sendRichMessageDraft: guard((...args: Parameters<TelegramBotApi["sendRichMessageDraft"]>) => api.sendRichMessageDraft(...args)),
    editMessageText: guard((...args: Parameters<TelegramBotApi["editMessageText"]>) => api.editMessageText(...args)),
    sendDocument: guard((...args: Parameters<TelegramBotApi["sendDocument"]>) => api.sendDocument(...args)),
    sendVoice: guard((...args: Parameters<TelegramBotApi["sendVoice"]>) => api.sendVoice(...args)),
    sendChatAction: guard((...args: Parameters<TelegramBotApi["sendChatAction"]>) => api.sendChatAction(...args)),
  };
}

export interface TelegramDelivery {
  api: TelegramDeliveryApi;
  assertCurrent(): Promise<void>;
}
