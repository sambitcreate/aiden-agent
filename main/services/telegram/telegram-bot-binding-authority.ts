import type {
  TelegramBotBinding,
  TelegramBotBindingStore,
} from "./telegram-bot-binding-store.js";

type TelegramBotBindingNarrowingStore = Pick<
  TelegramBotBindingStore,
  "unbind" | "unbindProfile"
>;

/**
 * The deliberately small authority-reduction surface for Telegram Bot routes.
 *
 * Production supplies the independently Keychain-checkpointed binding store.
 * This surface exposes no bind/update operation and has no BotApplicationService
 * dependency: direct disconnect, profile reset/delete, archive cleanup, and
 * startup repair can reduce authority even while ordinary Bot mutations are
 * poisoned. A protected-store error is propagated; it is never converted into
 * a write, rebind, or wider fallback.
 */
export function createTelegramBotBindingAuthorityNarrower(
  store: TelegramBotBindingNarrowingStore,
) {
  return Object.freeze({
    disableBot(botId: string): Promise<TelegramBotBinding> {
      return store.unbind(botId);
    },
    disableProfile(profile: string): Promise<number> {
      return store.unbindProfile(profile);
    },
  });
}

export type TelegramBotBindingAuthorityNarrower = ReturnType<
  typeof createTelegramBotBindingAuthorityNarrower
>;
