import type {
  TelegramBotBindingStore,
} from "./telegram-bot-binding-store.js";

export class TelegramBotBindingsUnsupportedError extends Error {
  readonly name = "TelegramBotBindingsUnsupportedError";

  constructor() {
    super("Bots are not available on this platform.");
  }
}
/**
 * Linux can continue ordinary Telegram routing without pretending to provide
 * the independently checkpointed Bot-binding authority used on macOS.
 */
export function createUnavailableTelegramBotBindingStore(): TelegramBotBindingStore {
  const unavailable = async (): Promise<never> => {
    throw new TelegramBotBindingsUnsupportedError();
  };
  return Object.freeze({
    assertHealthy: async () => undefined,
    list: async () => [],
    get: async () => null,
    resolve: async () => null,
    resolveExact: async () => null,
    bind: unavailable,
    unbind: unavailable,
    // Ordinary Telegram profile deletion/reset uses this reduction-only seam.
    // With no readable or writable Bot bindings on this host, zero is exact.
    unbindProfile: async () => 0,
  });
}
