import * as keychain from "./bot-capability-keychain-anchor.js";
import * as secretService from "./bot-capability-secret-service-anchor.js";
import { BotCapabilityUnavailableError } from "./bot-capability-store-core.js";
import type { BotCapabilityAuthorityItemOptions } from "./bot-capability-authority-item.js";
export { botCapabilityAuthorityAccountForCanonicalRoot } from "./bot-capability-authority-item.js";
export function createBotAuthorities(options: BotCapabilityAuthorityItemOptions, platform: NodeJS.Platform = process.platform) {
  if (platform === "darwin") return {
    anchor: keychain.createBotCapabilityKeychainAnchor(options),
    bootstrapMarker: keychain.createBotCapabilityKeychainBootstrapMarker(options),
    telegramAnchor: keychain.createTelegramBotBindingKeychainAnchor(options),
    telegramBootstrapMarker: keychain.createTelegramBotBindingKeychainBootstrapMarker(options),
  };
  if (platform === "linux") return {
    anchor: secretService.createBotCapabilitySecretServiceAnchor(options),
    bootstrapMarker: secretService.createBotCapabilitySecretServiceBootstrapMarker(options),
    telegramAnchor: secretService.createTelegramBotBindingSecretServiceAnchor(options),
    telegramBootstrapMarker: secretService.createTelegramBotBindingSecretServiceBootstrapMarker(options),
  };
  const unavailable = async (): Promise<never> => { throw new BotCapabilityUnavailableError("Bot rollback authority is unsupported on this platform."); };
  return { anchor: { load: unavailable, store: unavailable }, bootstrapMarker: { load: unavailable, store: unavailable }, telegramAnchor: { load: unavailable, store: unavailable }, telegramBootstrapMarker: { load: unavailable, store: unavailable } };
}
